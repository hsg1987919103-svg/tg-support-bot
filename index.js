import express from "express";
import TelegramBot from "node-telegram-bot-api";
import pkg from "pg";

const { Pool } = pkg;

// ================== 配置 ==================
const TOKEN = process.env.BOT_TOKEN;          // Telegram 机器人 Token
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID; // 客服群 ID
const DATABASE_URL = process.env.DATABASE_URL;   // PostgreSQL 连接字符串

// ================== 初始化 ==================
const app = express();
app.use(express.json());

const bot = new TelegramBot(TOKEN, { polling: false });
const pool = new Pool({ connectionString: DATABASE_URL });

// ================== 数据库工具函数 ==================

async function ensureUser(telegramId, name) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT * FROM users WHERE telegram_id=$1",
      [telegramId]
    );
    if (res.rows.length === 0) {
      await client.query(
        "INSERT INTO users (telegram_id, name) VALUES ($1, $2)",
        [telegramId, name]
      );
    }
  } finally {
    client.release();
  }
}

async function createThread(userId, topicId) {
  const client = await pool.connect();
  try {
    await client.query(
      "INSERT INTO threads (user_id, topic_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [userId, topicId]
    );
  } finally {
    client.release();
  }
}

async function getThreadUser(topicId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT user_id FROM threads WHERE topic_id=$1",
      [topicId]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0].user_id;
  } finally {
    client.release();
  }
}

async function saveMessage(threadId, sender, content, type, file_id = null) {
  const client = await pool.connect();
  try {
    await client.query(
      "INSERT INTO messages (thread_id, sender, content, type, file_id) VALUES ($1,$2,$3,$4,$5)",
      [threadId, sender, content, type, file_id]
    );
  } finally {
    client.release();
  }
}

async function getThreadIdByTopic(topicId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT id FROM threads WHERE topic_id=$1",
      [topicId]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0].id;
  } finally {
    client.release();
  }
}

// ================== Webhook 接口 ==================

app.post("/webhook", async (req, res) => {
  const message = req.body.message || req.body.edited_message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const fromName = message.from?.first_name || "未知用户";

  try {
    // ===== 客户发消息给机器人 =====
    if (message.chat.type === "private") {
      await ensureUser(chatId, fromName);

      let sentMessage;

      // 文本消息
      if (message.text) {
        sentMessage = await bot.sendMessage(GROUP_CHAT_ID, `📨 来自 ${fromName} 的消息：\n${message.text}`, {
          message_thread_id: undefined // 自动创建话题
        });
      }

      // 图片消息
      if (message.photo) {
        const file_id = message.photo[message.photo.length - 1].file_id;
        sentMessage = await bot.sendPhoto(GROUP_CHAT_ID, file_id, {
          caption: `📸 来自 ${fromName} 的图片`,
          message_thread_id: undefined
        });
      }

      // 文件消息
      if (message.document) {
        const file_id = message.document.file_id;
        sentMessage = await bot.sendDocument(GROUP_CHAT_ID, file_id, {
          caption: `📄 来自 ${fromName} 的文件: ${message.document.file_name}`,
          message_thread_id: undefined
        });
      }

      // 语音消息
      if (message.voice) {
        const file_id = message.voice.file_id;
        sentMessage = await bot.sendVoice(GROUP_CHAT_ID, file_id, {
          caption: `🎤 来自 ${fromName} 的语音`,
          message_thread_id: undefined
        });
      }

      // 保存话题信息
      await createThread(chatId, sentMessage.message_thread_id);
      const threadId = await getThreadIdByTopic(sentMessage.message_thread_id);

      // 保存消息记录
      let type = message.text ? "text" : message.photo ? "photo" : message.document ? "document" : message.voice ? "voice" : "text";
      let content = message.text || "";
      let file_id = message.photo ? message.photo[message.photo.length - 1].file_id : message.document ? message.document.file_id : message.voice ? message.voice.file_id : null;

      await saveMessage(threadId, "customer", content, type, file_id);
    }

    // ===== 客服群话题消息 =====
    if (chatId == GROUP_CHAT_ID && message.message_thread_id) {
      const threadId = await getThreadIdByTopic(message.message_thread_id);
      if (!threadId) return res.sendStatus(200);

      const userId = await getThreadUser(message.message_thread_id);
      if (!userId) return res.sendStatus(200);

      // 文本消息
      if (message.text) {
        await bot.sendMessage(userId, message.text);
        await saveMessage(threadId, "agent", message.text, "text");
      }

      // 图片消息
      if (message.photo) {
        const file_id = message.photo[message.photo.length - 1].file_id;
        await bot.sendPhoto(userId, file_id);
        await saveMessage(threadId, "agent", "", "photo", file_id);
      }

      // 文件消息
      if (message.document) {
        const file_id = message.document.file_id;
        await bot.sendDocument(userId, file_id);
        await saveMessage(threadId, "agent", message.document.file_name, "document", file_id);
      }

      // 语音消息
      if (message.voice) {
        const file_id = message.voice.file_id;
        await bot.sendVoice(userId, file_id);
        await saveMessage(threadId, "agent", "", "voice", file_id);
      }
    }

  } catch (err) {
    console.error("处理消息错误:", err);
  }

  res.sendStatus(200);
});

// ================== 启动服务 ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
