import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ===================== 配置 =====================
const TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

console.log("🔧 BOT_TOKEN =", TOKEN);
console.log("🔧 GROUP_CHAT_ID =", GROUP_CHAT_ID);
console.log("🔧 WEBHOOK_URL =", WEBHOOK_URL);

const API = `https://api.telegram.org/bot${TOKEN}`;

// 内存映射
const customerToTopic = new Map(); // customer → topicId
const topicToCustomer = new Map(); // topic → customerId

// ===================== 设置 Webhook =====================
async function setWebhook() {
  try {
    const res = await axios.get(`${API}/setWebhook`, {
      params: { url: WEBHOOK_URL }
    });
    console.log("Webhook 已设置：", res.data);
  } catch (e) {
    console.error("Webhook 设置失败：", e.response?.data || e.message);
  }
}
setWebhook();

// ===================== 创建 / 获取话题 =====================
async function getOrCreateTopic(customer) {
  const customerId = customer.id;
  if (customerToTopic.has(customerId)) return customerToTopic.get(customerId);

  const username = customer.username ? `@${customer.username}` : "Cliente";
  const topicName = `Cliente ${customerId}（${username}）`;

  console.log("🧵 创建话题：", topicName);

  const res = await axios.post(`${API}/createForumTopic`, {
    chat_id: GROUP_CHAT_ID,
    name: topicName
  });

  const topicId = res.data?.result?.message_thread_id;
  if (!topicId) throw new Error("createForumTopic 未返回 message_thread_id");

  customerToTopic.set(customerId, topicId);
  topicToCustomer.set(topicId, customerId);

  return topicId;
}

// ===================== Webhook 主逻辑 =====================
app.post("/webhook", async (req, res) => {
  const update = req.body;
  const msg = update.message;
  if (!msg) return res.sendStatus(200);

  const chatType = msg.chat.type;

  // ===================== 1. 客户给机器人发私聊 =====================
  if (chatType === "private") {
    const customer = msg.from;
    const customerId = customer.id;

    try {
      // 自动欢迎（仅第一次）
      if (!customerToTopic.has(customerId)) {
        const botInfo = await axios.get(`${API}/getMe`);
        const botName =
          botInfo.data?.result?.username ||
          botInfo.data?.result?.first_name ||
          "mi asistente";

        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: `¡Hola cariño! Soy ${botName} 🤖\nEstoy aquí para ayudarte, ¿en qué necesitas apoyo?`
        });
      }

      // 获取/创建话题
      const topicId = await getOrCreateTopic(customer);

      // 处理纯文本 / 图片 / 文档
      let content = msg.text || "";
      if (!content) {
        if (msg.photo) content = "[Imagen]";
        else if (msg.document) content = "[Documento]";
        else content = "[Mensaje no textual]";
      }

      // ⭐⭐⭐ ========== 精简格式：@username：内容 ========== ⭐⭐⭐
      const userTag = customer.username ? `@${customer.username}` : "Cliente";
      const forwardText = `${userTag}：${content}`;

      // 转发文本到群话题
      await axios.post(`${API}/sendMessage`, {
        chat_id: GROUP_CHAT_ID,
        message_thread_id: topicId,
        text: forwardText
      });

      // 图片处理（继续保留原图）
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: GROUP_CHAT_ID,
          message_thread_id: topicId,
          photo: fileId
        });
      }
    } catch (e) {
      console.error("处理客户私聊失败：", e.response?.data || e.message);
    }

    return res.sendStatus(200);
  }

  // ===================== 2. 客服在群话题中回复客户 =====================
  if (chatType === "supergroup") {
    if (String(msg.chat.id) !== GROUP_CHAT_ID) return res.sendStatus(200);

    const topicId = msg.message_thread_id;
    if (!topicId) return res.sendStatus(200);
    if (msg.from.is_bot) return res.sendStatus(200);

    const customerId = topicToCustomer.get(topicId);
    if (!customerId) return res.sendStatus(200);

    try {
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: customerId,
          photo: fileId,
          caption: msg.caption || ""
        });
        return res.sendStatus(200);
      }

      if (msg.text) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: msg.text
        });
      }
    } catch (e) {
      console.error("客服回复失败：", e.response?.data || e.message);
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// ===================== 启动 =====================
app.listen(Number(process.env.PORT) || 3000, () => {
  console.log("🚀 Bot 已启动");
});
