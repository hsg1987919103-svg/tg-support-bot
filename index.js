import express from "express";
import axios from "axios";
import fs from "fs";

const app = express();
app.use(express.json());

// ===================== 配置 =====================
const TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// ⚠️ 强制转 number（关键修复点）
const GROUP_CHAT_ID = Number(process.env.GROUP_CHAT_ID);

if (!TOKEN || !WEBHOOK_URL || !Number.isFinite(GROUP_CHAT_ID)) {
  throw new Error("❌ 环境变量未正确配置");
}

const API = `https://api.telegram.org/bot${TOKEN}`;

// ===================== 映射存储 =====================
const MAPPING_FILE = "./mapping.json";

const customerToTopic = new Map();
const topicToCustomer = new Map();
const groupMsgToCustomer = new Map();

function loadMapping() {
  if (!fs.existsSync(MAPPING_FILE)) return;
  const data = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf8"));
  data.customerToTopic?.forEach(([k, v]) => customerToTopic.set(k, v));
  data.topicToCustomer?.forEach(([k, v]) => topicToCustomer.set(k, v));
  data.groupMsgToCustomer?.forEach(([k, v]) => groupMsgToCustomer.set(k, v));
}

function saveMapping() {
  fs.writeFileSync(
    MAPPING_FILE,
    JSON.stringify(
      {
        customerToTopic: [...customerToTopic],
        topicToCustomer: [...topicToCustomer],
        groupMsgToCustomer: [...groupMsgToCustomer],
      },
      null,
      2
    )
  );
}

loadMapping();

// ===================== 设置 Webhook =====================
(async () => {
  const res = await axios.get(`${API}/setWebhook`, {
    params: { url: WEBHOOK_URL },
  });
  console.log("✅ Webhook 设置成功", res.data);
})();

// ===================== 工具 =====================
function log(prefix, msg) {
  console.log(
    `${prefix} chat=${msg.chat.id} type=${msg.chat.type} thread=${msg.message_thread_id ?? "-"} text=${msg.text || "[非文本]"}`
  );
}

// ===================== 创建 / 获取话题 =====================
async function getOrCreateTopic(customerId) {
  if (customerToTopic.has(customerId)) {
    return customerToTopic.get(customerId);
  }

  const res = await axios.post(`${API}/createForumTopic`, {
    chat_id: GROUP_CHAT_ID,
    name: `客户 ${customerId}`,
  });

  const topicId = res.data?.result?.message_thread_id;
  if (!topicId) throw new Error("创建话题失败");

  customerToTopic.set(customerId, topicId);
  topicToCustomer.set(topicId, customerId);
  saveMapping();

  return topicId;
}

// ===================== Webhook =====================
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg) return res.sendStatus(200);

  log("📩 收到消息:", msg);

  try {
    // ===================== 私聊 =====================
    if (msg.chat.type === "private") {
      const customerId = msg.from.id;

      // 先确保 topic 存在（关键顺序修复）
      const topicId = await getOrCreateTopic(customerId);

      // /start 或首次消息
      if (msg.text === "/start" || msg.text) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: "Hola 👋 Soy Lia. Nuestro equipo te atenderá aquí.",
        });
      }

      // 转发到群
      const content =
        msg.text ||
        (msg.photo ? "[Imagen]" : msg.document ? "[Documento]" : "[Mensaje]");

      const sent = await axios.post(`${API}/sendMessage`, {
        chat_id: GROUP_CHAT_ID,
        message_thread_id: topicId,
        text: content,
      });

      // 映射回复关系
      groupMsgToCustomer.set(sent.data.result.message_id, {
        customerId,
        customerMsgId: msg.message_id,
      });
      saveMapping();

      // 图片转发
      if (msg.photo) {
        const fileId = msg.photo.at(-1).file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: GROUP_CHAT_ID,
          message_thread_id: topicId,
          photo: fileId,
        });
      }

      return res.sendStatus(200);
    }

    // ===================== 群内客服回复 =====================
    if (
      msg.chat.type === "supergroup" &&
      msg.chat.id === GROUP_CHAT_ID &&
      msg.message_thread_id &&
      !msg.from.is_bot
    ) {
      const topicId = msg.message_thread_id;
      const customerId = topicToCustomer.get(topicId);
      if (!customerId) return res.sendStatus(200);

      // 引用回复
      if (msg.reply_to_message) {
        const mapping = groupMsgToCustomer.get(
          msg.reply_to_message.message_id
        );
        if (mapping) {
          await axios.post(`${API}/sendMessage`, {
            chat_id: customerId,
            text: msg.text,
            reply_to_message_id: mapping.customerMsgId,
          });
          return res.sendStatus(200);
        }
      }

      // 普通回复
      if (msg.text) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: msg.text,
        });
      }

      if (msg.photo) {
        const fileId = msg.photo.at(-1).file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: customerId,
          photo: fileId,
        });
      }
    }
  } catch (e) {
    // ✅ 真实错误完整打印（关键）
    console.error(
      "❌ 处理失败:",
      JSON.stringify(e.response?.data, null, 2),
      e.stack
    );
  }

  res.sendStatus(200);
});

// ===================== 启动 =====================
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 tg-support-bot 已启动");
});
