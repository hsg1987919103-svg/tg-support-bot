import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ================== 配置 ==================
const TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = parseInt(process.env.GROUP_CHAT_ID);
const WEBHOOK_URL = "https://tg-support-bot-production-8afa.up.railway.app/webhook";
const PORT = process.env.PORT || 3000;

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;
const chatHistory = {};

// ================== 队列与工具函数 ==================
const sendQueue = [];

async function processQueue() {
  if (sendQueue.length === 0) return;
  const task = sendQueue.shift();
  try {
    await axios.post(`${TELEGRAM_API}/${task.method}`, task.payload);
  } catch (err) {
    if (err.response && err.response.status === 429) {
      const retryAfter = err.response.data.parameters?.retry_after || 1;
      console.warn(`429 Too Many Requests, retry after ${retryAfter} seconds`);
      // 重试前重新放回队列
      sendQueue.unshift(task);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
    } else {
      console.error(err.message);
    }
  }
  // 下一条消息间隔 0.5 秒
  if (sendQueue.length > 0) {
    setTimeout(processQueue, 500);
  }
}

function enqueueSend(method, payload) {
  sendQueue.push({ method, payload });
  if (sendQueue.length === 1) processQueue();
}

function sendMessage(chat_id, text, replyToMessageId = null) {
  enqueueSend("sendMessage", { chat_id, text, reply_to_message_id: replyToMessageId || undefined });
}

function sendFile(chat_id, type, file_id, replyToMessageId = null) {
  enqueueSend(`send${type}`, { chat_id, [`${type.toLowerCase()}`]: file_id, reply_to_message_id: replyToMessageId || undefined });
}

function saveMessage(userId, message) {
  if (!chatHistory[userId]) chatHistory[userId] = [];
  chatHistory[userId].push({ ...message, timestamp: new Date() });
}

// ================== Webhook 接收消息 ==================
app.post("/webhook", async (req, res) => {
  const update = req.body;

  try {
    // 客户消息
    if (update.message && update.message.chat) {
      const msg = update.message;
      const fromUserId = msg.from.id;

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

      saveMessage(fromUserId, savedMessage);

      if (savedMessage.type === "text") {
        sendMessage(GROUP_CHAT_ID, `用户 ${fromUserId} 说:\n${savedMessage.message}`);
      } else {
        sendFile(GROUP_CHAT_ID, savedMessage.type, savedMessage.file_id);
      }
    }

    // 群客服回复
    if (update.message && update.message.chat.id === GROUP_CHAT_ID) {
      const msg = update.message;
      if (msg.reply_to_message) {
        const match = msg.reply_to_message.text?.match(/用户 (\d+) 说:/);
        if (match) {
          const userId = parseInt(match[1]);
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

          if (savedMessage.type === "text") {
            sendMessage(userId, savedMessage.message);
          } else {
            sendFile(userId, savedMessage.type, savedMessage.file_id);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ================== 手动重试 Webhook 设置接口 ==================
app.get("/set-webhook", async (req, res) => {
  try {
    const webhookRes = await axios.post(`${TELEGRAM_API}/setWebhook`, {}, { params: { url: WEBHOOK_URL } });
    res.json(webhookRes.data);
  } catch (err) {
    if (err.response) res.json(err.response.data);
    else res.json({ ok: false, error: err.message });
  }
});

// ================== 启动服务器 ==================
app.listen(PORT, async () => {
  console.log(`Telegram 支持机器人已启动，监听端口 ${PORT}`);

  try {
    const test = await axios.get(WEBHOOK_URL).catch(() => null);
    if (!test) console.warn("Warning: WEBHOOK_URL 可能暂不可访问，Telegram 设置 Webhook 可能失败。");

    const resWebhook = await axios.post(`${TELEGRAM_API}/setWebhook`, {}, { params: { url: WEBHOOK_URL } });
    if (resWebhook.data.ok) console.log("Webhook 设置成功:", WEBHOOK_URL);
    else console.error("Webhook 设置失败:", resWebhook.data);
  } catch (err) {
    if (err.response) console.error("Webhook 设置失败:", err.response.data);
    else console.error("Webhook 设置异常:", err.message);
  }
});
