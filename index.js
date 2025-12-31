import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ================== 配置 ==================
const TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = parseInt(process.env.GROUP_CHAT_ID); // 客服群ID
const PORT = process.env.PORT || 3000;

let WEBHOOK_URL = process.env.WEBHOOK_URL;
if (!WEBHOOK_URL.startsWith("https://")) WEBHOOK_URL = "https://" + WEBHOOK_URL;
if (!WEBHOOK_URL.endsWith("/webhook")) WEBHOOK_URL += "/webhook";

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

console.log("BOT_TOKEN:", TOKEN ? TOKEN.substring(0, 8) + "..." : "未设置");
console.log("Webhook URL:", WEBHOOK_URL);

// ================== 数据管理 ==================
const chatHistory = {};        // 保存客户消息历史
const greetedUsers = new Set(); // 已回复 /start 的用户

// ================== 队列发送 ==================
const sendQueue = [];
async function processQueue() {
  if (!sendQueue.length) return;
  const task = sendQueue.shift();
  try {
    await axios.post(`${TELEGRAM_API}/${task.method}`, task.payload);
  } catch (err) {
    if (err.response && err.response.status === 429) {
      const retryAfter = err.response.data.parameters?.retry_after || 1;
      console.warn(`[429限流] 重试延迟 ${retryAfter} 秒`);
      sendQueue.unshift(task);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
    } else {
      console.warn("[发送失败]", err.response?.data || err.message);
    }
  }
  if (sendQueue.length > 0) setTimeout(processQueue, 500);
}
function enqueueSend(method, payload) {
  sendQueue.push({ method, payload });
  if (sendQueue.length === 1) processQueue();
}
function sendMessage(chat_id, text, replyToMessageId = null) {
  if (!text || !text.trim()) return;
  const payload = { chat_id, text, reply_to_message_id: replyToMessageId || undefined };
  enqueueSend("sendMessage", payload);
}
function sendFile(chat_id, type, file_id, replyToMessageId = null) {
  const payload = { chat_id, [`${type.toLowerCase()}`]: file_id, reply_to_message_id: replyToMessageId || undefined };
  enqueueSend(`send${type}`, payload);
}
function saveMessage(userId, message) {
  if (!chatHistory[userId]) chatHistory[userId] = [];
  chatHistory[userId].push({ ...message, timestamp: new Date() });
}

// ================== Webhook ==================
app.post("/webhook", async (req, res) => {
  const update = req.body;

  try {
    // -------- 客户消息 --------
    if (update.message && update.message.chat.id !== GROUP_CHAT_ID) {
      const msg = update.message;
      const userId = msg.from.id;

      // 首次 /start 自动问候
      if (!greetedUsers.has(userId) && msg.text && msg.text.toLowerCase() === "/start") {
        sendMessage(userId, "Hola, soy Leah. ¿Cómo debería llamarte?");
        greetedUsers.add(userId);
      }

      // 保存消息
      let savedMessage = { from: "user", type: "text", message: msg.text };
      if (msg.text) savedMessage.type = "text";
      else if (msg.photo) { savedMessage.type = "Photo"; savedMessage.file_id = msg.photo[msg.photo.length - 1].file_id; }
      else if (msg.voice) { savedMessage.type = "Voice"; savedMessage.file_id = msg.voice.file_id; }
      else if (msg.document) { savedMessage.type = "Document"; savedMessage.file_id = msg.document.file_id; }
      saveMessage(userId, savedMessage);

      // 转发到客服群，隐藏 ID/用户名
      if (savedMessage.type === "text") sendMessage(GROUP_CHAT_ID, savedMessage.message);
      else sendFile(GROUP_CHAT_ID, savedMessage.type, savedMessage.file_id);
    }

    // -------- 客服消息 --------
    if (update.message && update.message.chat.id === GROUP_CHAT_ID) {
      const msg = update.message;
      let replyToUserId = null;

      // 判断是否引用客户消息
      if (msg.reply_to_message) {
        const repliedText = msg.reply_to_message.text;
        for (let uid in chatHistory) {
          if (chatHistory[uid].some(m => m.message === repliedText && m.from === "user")) {
            replyToUserId = uid;
            break;
          }
        }
      } else {
        // 默认使用最后一条客户消息的用户
        const allUsers = Object.keys(chatHistory);
        if (allUsers.length) replyToUserId = allUsers[allUsers.length - 1];
      }

      if (!replyToUserId) return res.sendStatus(200);

      let savedMessage = { from: "support", type: "text", message: msg.text };
      if (msg.text) savedMessage.type = "text";
      else if (msg.photo) { savedMessage.type = "Photo"; savedMessage.file_id = msg.photo[msg.photo.length - 1].file_id; }
      else if (msg.voice) { savedMessage.type = "Voice"; savedMessage.file_id = msg.voice.file_id; }
      else if (msg.document) { savedMessage.type = "Document"; savedMessage.file_id = msg.document.file_id; }

      saveMessage(replyToUserId, savedMessage);

      // 自动转发给客户，隐藏任何 ID/用户名
      if (savedMessage.type === "text") sendMessage(replyToUserId, savedMessage.message);
      else sendFile(replyToUserId, savedMessage.type, savedMessage.file_id);
    }

    res.sendStatus(200);
  } catch (err) {
    console.warn("[Webhook异常]", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// ================== 健康检查 ==================
app.get("/health", (req, res) => res.send("ok"));

// ================== 手动设置 Webhook ==================
app.get("/set-webhook", async (req, res) => {
  try {
    const webhookRes = await axios.post(`${TELEGRAM_API}/setWebhook`, null, { params: { url: WEBHOOK_URL } });
    res.json(webhookRes.data);
  } catch (err) {
    console.warn("[手动设置Webhook异常]", err.response?.data || err.message);
    res.json({ ok: false, error: err.response?.data || err.message });
  }
});

// ================== 启动 ==================
app.listen(PORT, async () => {
  console.log(`Telegram 支持机器人已启动，监听端口 ${PORT}`);

  try {
    const resWebhook = await axios.post(`${TELEGRAM_API}/setWebhook`, null, { params: { url: WEBHOOK_URL } });
    if (resWebhook.data.ok) console.log("Webhook 设置成功:", WEBHOOK_URL);
    else console.warn("[Webhook设置返回非 ok]", resWebhook.data);
  } catch (err) {
    console.warn("[自动设置Webhook异常，不影响使用]", err.response?.data || err.message);
  }
});
