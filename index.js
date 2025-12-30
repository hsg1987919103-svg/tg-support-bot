import express from "express";
import axios from "axios";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
app.use(express.json());

// ================== 配置 ==================
const TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const API = `https://api.telegram.org/bot${TOKEN}`;

// ================== 数据库 ==================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ================== 初始化数据库 ==================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      customer_id BIGINT PRIMARY KEY,
      topic_id BIGINT NOT NULL,
      welcomed BOOLEAN DEFAULT FALSE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      customer_msg_id BIGINT,
      group_msg_id BIGINT,
      customer_id BIGINT,
      PRIMARY KEY (customer_msg_id, customer_id)
    );
  `);

  console.log("🗄️ PostgreSQL 已初始化");
}
initDB();

// ================== Webhook ==================
async function setWebhook() {
  await axios.get(`${API}/setWebhook`, {
    params: { url: WEBHOOK_URL },
  });
  console.log("✅ Webhook 设置成功");
}
setWebhook();

// ================== 获取或创建客服窗口 ==================
async function getOrCreateTopic(customerId) {
  const res = await pool.query(
    "SELECT topic_id, welcomed FROM customers WHERE customer_id=$1",
    [customerId]
  );

  // 已存在
  if (res.rows.length) {
    return {
      topicId: res.rows[0].topic_id,
      welcomed: res.rows[0].welcomed,
    };
  }

  // 新客户 → 创建窗口
  const topic = await axios.post(`${API}/createForumTopic`, {
    chat_id: GROUP_CHAT_ID,
    name: `客户 ${customerId}`,
  });

  const topicId = topic.data.result.message_thread_id;

  await pool.query(
    "INSERT INTO customers (customer_id, topic_id, welcomed) VALUES ($1,$2,false)",
    [customerId, topicId]
  );

  return { topicId, welcomed: false };
}

// ================== Webhook 处理 ==================
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg) return res.sendStatus(200);

  // ================== 客户私聊 ==================
  if (msg.chat.type === "private") {
    const customerId = msg.from.id;

    try {
      const { topicId, welcomed } = await getOrCreateTopic(customerId);

      // ✅ 只在第一次 /start 自动回复
      if (msg.text === "/start" && !welcomed) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: "Hola 👋，欢迎联系客户支持，请发送你的问题。",
        });

        await pool.query(
          "UPDATE customers SET welcomed=true WHERE customer_id=$1",
          [customerId]
        );

        return res.sendStatus(200);
      }

      // ❌ 已欢迎过的 /start 不处理
      if (msg.text === "/start" && welcomed) {
        return res.sendStatus(200);
      }

      // ===== 转发普通文本 =====
      if (msg.text) {
        const sent = await axios.post(`${API}/sendMessage`, {
          chat_id: GROUP_CHAT_ID,
          message_thread_id: topicId,
          text: msg.text,
        });

        await pool.query(
          "INSERT INTO messages VALUES ($1,$2,$3)",
          [msg.message_id, sent.data.result.message_id, customerId]
        );
      }

      // ===== 转发图片 =====
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: GROUP_CHAT_ID,
          message_thread_id: topicId,
          photo: fileId,
        });
      }
    } catch (e) {
      console.error("❌ 客户消息处理失败", e.message);
    }

    return res.sendStatus(200);
  }

  // ================== 客服群回复 ==================
  if (
    msg.chat.type === "supergroup" &&
    String(msg.chat.id) === GROUP_CHAT_ID &&
    msg.message_thread_id &&
    !msg.from.is_bot
  ) {
    try {
      const topicId = msg.message_thread_id;

      const r = await pool.query(
        "SELECT customer_id FROM customers WHERE topic_id=$1",
        [topicId]
      );
      if (!r.rows.length) return res.sendStatus(200);

      const customerId = r.rows[0].customer_id;

      // ===== 引用回复 =====
      if (msg.reply_to_message) {
        const m = await pool.query(
          "SELECT customer_msg_id FROM messages WHERE group_msg_id=$1",
          [msg.reply_to_message.message_id]
        );

        if (m.rows.length) {
          await axios.post(`${API}/sendMessage`, {
            chat_id: customerId,
            text: msg.text,
            reply_to_message_id: m.rows[0].customer_msg_id,
          });
          return res.sendStatus(200);
        }
      }

      // ===== 普通文本 =====
      if (msg.text) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: msg.text,
        });
      }

      // ===== 图片 =====
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: customerId,
          photo: fileId,
          caption: msg.caption || "",
        });
      }
    } catch (e) {
      console.error("❌ 客服回复失败", e.message);
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// ================== 启动 ==================
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Bot 已启动（最终稳定版）");
});
