import express from "express";
import axios from "axios";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

// ================= PostgreSQL 初始化（可选） =================
let pool;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      update_id BIGINT,
      customer_id BIGINT,
      customer_name TEXT,
      chat_type TEXT,
      message_type TEXT,
      content TEXT,
      topic_id BIGINT,
      timestamp TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS topics (
      id SERIAL PRIMARY KEY,
      customer_id BIGINT UNIQUE,
      topic_id BIGINT
    );
  `);
}

// ================= 测试接口 =================
app.get("/", (req, res) => res.send("Bot running"));

// ================= Webhook 接口 =================
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    console.log("🔥 Webhook hit", JSON.stringify(update, null, 2));
    res.sendStatus(200);

    if (!update.message) return;
    const msg = update.message;
    const customerId = msg.from.id;
    const customerName = msg.from.first_name;

    // ================= 消息类型识别 =================
    const msgType = msg.text ? "text" :
                    msg.photo ? "photo" :
                    msg.voice ? "voice" :
                    msg.document ? "file" : "unknown";

    let content = msg.text || "";
    if (msg.photo) content = `[Photo] file_id: ${msg.photo[msg.photo.length - 1].file_id}`;
    if (msg.voice) content = `[Voice] file_id: ${msg.voice.file_id}`;
    if (msg.document) content = `[File] file_id: ${msg.document.file_id}`;

    // ================= 查找或创建群话题 =================
    let topicId;

    if (pool) {
      const topicRes = await pool.query(`SELECT topic_id FROM topics WHERE customer_id = $1`, [customerId]);
      if (topicRes.rowCount === 0) {
        try {
          const topicTitle = `客户: ${customerName} (${customerId})`;
          const createTopic = await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic`,
            { chat_id: GROUP_CHAT_ID, name: topicTitle }
          );

          topicId = createTopic.data.result.message_thread_id;

          await pool.query(
            `INSERT INTO topics (customer_id, topic_id) VALUES ($1, $2)`,
            [customerId, topicId]
          );
        } catch (err) {
          console.error("❌ 创建话题失败:", err.response?.data || err.message);
          return;
        }
      } else {
        topicId = topicRes.rows[0].topic_id;
      }

      await pool.query(
        `INSERT INTO messages (update_id, customer_id, customer_name, chat_type, message_type, content, topic_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [update.update_id, customerId, customerName, msg.chat.type, msgType, content, topicId]
      );
    }

    // ================= 转发到群话题 =================
    if (!topicId) {
      console.error("❌ topicId 未生成，跳过消息转发");
      return;
    }

    try {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: GROUP_CHAT_ID,
        message_thread_id: topicId,
        text: content
      });
    } catch (err) {
      console.error("❌ 转发消息到群话题失败:", err.response?.data || err.message);
    }

  } catch (err) {
    console.error("❌ Webhook处理错误:", err.response?.data || err.message || err);
  }
});

// ================= 群消息 → 自动回客户 =================
app.post("/group_webhook", async (req, res) => {
  try {
    const update = req.body;
    res.sendStatus(200);

    if (!update.message) return;
    const msg = update.message;

    if (msg.from.is_bot) return;
    if (!msg.message_thread_id || !msg.text) return;

    let customerId;
    if (pool) {
      const topicRes = await pool.query(`SELECT customer_id FROM topics WHERE topic_id = $1`, [msg.message_thread_id]);
      if (topicRes.rowCount === 0) return;
      customerId = topicRes.rows[0].customer_id;
    }

    if (!customerId) return;

    try {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: customerId,
        text: `💬 客服回复:\n${msg.text}`
      });
    } catch (err) {
      console.error("❌ 群消息转发给客户失败:", err.response?.data || err.message);
    }

  } catch (err) {
    console.error("❌ Group webhook处理错误:", err.response?.data || err.message || err);
  }
});

// ================= 启动 =================
app.listen(PORT, "0.0.0.0", () => {
  console.log("Bot running on port", PORT);
});
