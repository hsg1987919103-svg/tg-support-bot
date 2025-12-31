import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ================== 配置 ==================
const TOKEN = process.env.BOT_TOKEN; // 你的 Telegram Bot Token
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID; // 客服群聊 ID
const WEBHOOK_URL = "https://tg-support-bot-production-6fe5.up.railway.app/webhook"; // 你的 Railway URL
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

// 内存存储聊天记录
const chatHistory = {};

// ================== 工具函数 ==================
async function sendMessage(chat_id, text, replyToMessageId = null) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id,
    text,
    reply_to_message_id: replyToMessageId || undefined,
  });
}

async function sendFile(chat_id, type, file_id, replyToMessageId = null) {
  await axios.post(`${TELEGRAM_API}/send${type}`, {
    chat_id,
    [`${type.toLowerCase()}`]: file_id,
    reply_to_message_id: replyToMessageId || undefined,
  });
}

function saveMessage(userId, message) {
  if (!chatHistory[userId]) chatHistory[userId] = [];
  chatHistory[userId].push({ ...message, timestamp: new Date() });
}

// ================== Webhook 接收消息 ==================
app.post("/webhook", async (req, res) => {
  const update = req.body;

  try {
    // ================== 客户消息 ==================
    if (update.message && update.message.chat) {
      const msg = update.message;
      const fromUserId = msg.from.id;

      let savedMessage = { from: "user", type: "text", message: msg.text };

      if (msg.text) {
        savedMessage.type = "text";
      } else if (msg.photo) {
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
        await sendMessage(
          GROUP_CHAT_ID,
          `用户 ${fromUserId} 说:\n${savedMessage.message}`
        );
      } else {
        await sendFile(GROUP_CHAT_ID, savedMessage.type, savedMessage.file_id);
      }
    }

    // ================== 群里客服回复 ==================
    if (update.message && update.message.chat.id.toString() === GROUP_CHAT_ID) {
      const msg = update.message;

      if (msg.reply_to_message) {
        const match = msg.reply_to_message.text?.match(/用户 (\d+) 说:/);
        if (match) {
          const userId = parseInt(match[1]);

          let savedMessage = { from: "support", type: "text", message: msg.text };

          if (msg.text) {
            savedMessage.type = "text";
          } else if (msg.photo) {
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
            await sendMessage(userId, savedMessage.message);
          } else {
            await sendFile(userId, savedMessage.type, savedMessage.file_id);
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

// ================== 启动服务器 ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Telegram 支持机器人已启动，监听端口 ${PORT}`);

  // 自动设置 Webhook
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${TOKEN}/setWebhook`,
      {},
      { params: { url: WEBHOOK_URL } }
    );
    if (res.data.ok) {
      console.log("Webhook 设置成功:", WEBHOOK_URL);
    } else {
      console.error("Webhook 设置失败:", res.data);
    }
  } catch (err) {
    console.error("Webhook 设置异常:", err.message);
  }
});
