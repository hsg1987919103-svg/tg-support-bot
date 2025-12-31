import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ================== 配置 ==================
const TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = parseInt(process.env.GROUP_CHAT_ID);
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.RAILWAY_STATIC_URL || `localhost:${PORT}`;
const WEBHOOK_URL = `https://${DOMAIN}/webhook`;

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;
console.log("Webhook URL:", WEBHOOK_URL);

// ================== 消息历史 & 会话管理 ==================
const chatHistory = {};  
const userTopics = {};  

// ================== 队列与工具函数 ==================
const sendQueue = [];

async function processQueue() {
  if (sendQueue.length === 0) return;
  const task = sendQueue.shift();
  try {
    console.log("[队列发送] 方法:", task.method, "Payload:", task.payload);
    await axios.post(`${TELEGRAM_API}/${task.method}`, task.payload);
  } catch (err) {
    if (err.response && err.response.status === 429) {
      const retryAfter = err.response.data.parameters?.retry_after || 1;
      console.warn(`[429限流] 重试延迟 ${retryAfter} 秒`);
      sendQueue.unshift(task);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
    } else {
      console.error("[发送失败]", err.response?.data || err.message);
    }
  }
  if (sendQueue.length > 0) setTimeout(processQueue, 500);
}

function enqueueSend(method, payload) {
  sendQueue.push({ method, payload });
  if (sendQueue.length === 1) processQueue();
}

function sendMessage(chat_id, text, replyToMessageId = null, topic_id = null) {
  const payload = { chat_id, text, reply_to_message_id: replyToMessageId || undefined };
  if (topic_id) payload.message_thread_id = topic_id;
  enqueueSend("sendMessage", payload);
}

function sendFile(chat_id, type, file_id, replyToMessageId = null, topic_id = null) {
  const payload = { chat_id, [`${type.toLowerCase()}`]: file_id, reply_to_message_id: replyToMessageId || undefined };
  if (topic_id) payload.message_thread_id = topic_id;
  enqueueSend(`send${type}`, payload);
}

function saveMessage(userId, message) {
  if (!chatHistory[userId]) chatHistory[userId] = [];
  chatHistory[userId].push({ ...message, timestamp: new Date() });
}

// ================== Webhook 接收消息 ==================
app.post("/webhook", async (req, res) => {
  const update = req.body;

  try {
    // ------------------ 用户发消息 ------------------
    if (update.message && update.message.chat && !update.message.chat.id === GROUP_CHAT_ID) {
      const msg = update.message;
      const userId = msg.from.id;
      console.log("[用户消息] userId:", userId, "内容:", msg.text || "非文本消息");

      // 创建话题窗口
      if (!userTopics[userId]) {
        try {
          const topicRes = await axios.post(`${TELEGRAM_API}/createForumTopic`, null, {
            params: { chat_id: GROUP_CHAT_ID, name: `用户 ${userId} 会话` }
          });
          if (topicRes.data.ok) {
            userTopics[userId] = topicRes.data.result.message_thread_id;
            console.log(`[话题创建成功] userId: ${userId}, topic_id: ${userTopics[userId]}`);
          }
        } catch (err) {
          console.error("[话题创建失败]", err.response?.data || err.message);
        }
      }

      // 保存消息
      let savedMessage = { from: "user", type: "text", message: msg.text };
      if (msg.text) savedMessage.type = "text";
      else if (msg.photo) {
        savedMessage.type = "Photo";
        savedMessage.file_id = msg.photo[msg.photo.length - 1].file_id;
      } else if (msg.voice) {
        savedMessage.type = "Voice";
        savedMessage.file_id = msg.voice.file_id;
      } else if (msg.document) {
        savedMessage.type = "Document";
        savedMessage.file_id = msg.document.file_id;
      }

      saveMessage(userId, savedMessage);

      // 转发到客服群话题
      const topicId = userTopics[userId];
      if (savedMessage.type === "text") sendMessage(GROUP_CHAT_ID, `用户 ${userId} 说:\n${savedMessage.message}`, null, topicId);
      else sendFile(GROUP_CHAT_ID, savedMessage.type, savedMessage.file_id, null, topicId);
    }

    // ------------------ 客服在群话题回复 ------------------
    if (update.message && update.message.chat.id === GROUP_CHAT_ID) {
      const msg = update.message;
      const topicId = msg.message_thread_id;
      if (!topicId) return res.sendStatus(200);

      console.log("[客服消息] topic_id:", topicId, "内容:", msg.text || "非文本消息");

      // 找到对应用户
      const userId = Object.keys(userTopics).find(k => userTopics[k] === topicId);
      if (!userId) {
        console.warn("[未匹配用户] topic_id:", topicId);
        return res.sendStatus(200);
      }

      let savedMessage = { from: "support", type: "text", message: msg.text };
      if (msg.text) savedMessage.type = "text";
      else if (msg.photo) {
        savedMessage.type = "Photo";
        savedMessage.file_id = msg.photo[msg.photo.length - 1].file_id;
      } else if (msg.voice) {
        savedMessage.type = "Voice";
        savedMessage.file_id = msg.voice.file_id;
      } else if (msg.document) {
        savedMessage.type = "Document";
        savedMessage.file_id = msg.document.file_id;
      }

      saveMessage(userId, savedMessage);

      // 自动转发给客户
      if (savedMessage.type === "text") sendMessage(userId, savedMessage.message);
      else sendFile(userId, savedMessage.type, savedMessage.file_id);

      console.log(`[已转发给用户] userId: ${userId}, 类型: ${savedMessage.type}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("[Webhook异常]", err);
    res.sendStatus(500);
  }
});

// ================== 手动重试 Webhook ==================
app.get("/set-webhook", async (req, res) => {
  try {
    const webhookRes = await axios.post(`${TELEGRAM_API}/setWebhook`, {}, { params: { url: WEBHOOK_URL } });
    res.json(webhookRes.data);
  } catch (err) {
    if (err.response) res.json(err.response.data);
    else res.json({ ok: false, error: err.message });
  }
});

// ================== 启动服务器并设置 Webhook ==================
app.listen(PORT, async () => {
  console.log(`Telegram 支持机器人已启动，监听端口 ${PORT}`);

  try {
    const resWebhook = await axios.post(`${TELEGRAM_API}/setWebhook`, {}, { params: { url: WEBHOOK_URL } });
    if (resWebhook.data.ok) console.log("Webhook 设置成功:", WEBHOOK_URL);
    else console.error("Webhook 设置失败:", resWebhook.data);
  } catch (err) {
    if (err.response) console.error("Webhook 设置失败:", err.response.data);
    else console.error("Webhook 设置异常:", err.message);
  }
});
