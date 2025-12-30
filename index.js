import express from "express";
import axios from "axios";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
app.use(express.json());

// ================= 配置 =================
const TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const PORT = process.env.PORT || 3000;
const TG_API = `https://api.telegram.org/bot${TOKEN}`;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ================= 工具函数 =================
async function tg(method, data) {
  return axios.post(`${TG_API}/${method}`, data);
}

async function getOrCreateSession(chatId) {
  const { rows } = await pool.query(
    "SELECT * FROM sessions WHERE customer_chat_id=$1",
    [chatId]
  );

  if (rows.length) return rows[0];

  const topic = await tg("createForumTopic", {
    chat_id: GROUP_CHAT_ID,
    name: `客户 ${chatId}`,
  });

  const topicId = topic.data.result.message_thread_id;

  const insert = await pool.query(
    "INSERT INTO sessions (customer_chat_id, topic_id) VALUES ($1,$2) RETURNING *",
    [chatId, topicId]
  );

  return insert.rows[0];
}

async function saveMessage(sessionId, sender, type, content) {
  await pool.query(
    "INSERT INTO messages (session_id, sender, message_type, content) VALUES ($1,$2,$3,$4)",
    [sessionId, sender, type, content]
  );
}

async function forwardToGroup(session, msg) {
  const base = {
    chat_id: GROUP_CHAT_ID,
    message_thread_id: session.topic_id,
  };

  if (msg.text) {
    await tg("sendMessage", { ...base, text: msg.text });
    await saveMessage(session.id, "customer", "text", msg.text);
  } else if (msg.photo) {
    const file = msg.photo.at(-1).file_id;
    await tg("sendPhoto", { ...base, photo: file, caption: msg.caption });
    await saveMessage(session.id, "customer", "photo", file);
  } else if (msg.voice) {
    await tg("sendVoice", { ...base, voice: msg.voice.file_id });
    await saveMessage(session.id, "customer", "voice", msg.voice.file_id);
  } else if (msg.document) {
    await tg("sendDocument", { ...base, document: msg.document.file_id });
    await saveMessage(session.id, "customer", "document", msg.document.file_id);
  } else if (msg.video) {
    await tg("sendVideo", { ...base, video: msg.video.file_id });
    await saveMessage(session.id, "customer", "video", msg.video.file_id);
  }
}

async function forwardToCustomer(session, msg) {
  const base = { chat_id: session.customer_chat_id };

  if (msg.text) {
    await tg("sendMessage", { ...base, text: msg.text });
    await saveMessage(session.id, "agent", "text", msg.text);
  } else if (msg.photo) {
    await tg("sendPhoto", {
      ...base,
      photo: msg.photo.at(-1).file_id,
      caption: msg.caption,
    });
    await saveMessage(session.id, "agent", "photo", msg.photo.at(-1).file_id);
  } else if (msg.voice) {
    await tg("sendVoice", { ...base, voice: msg.voice.file_id });
    await saveMessage(session.id, "agent", "voice", msg.voice.file_id);
  } else if (msg.document) {
    await tg("sendDocument", { ...base, document: msg.document.file_id });
    await saveMessage(session.id, "agent", "document", msg.document.file_id);
  } else if (msg.video) {
    await tg("sendVideo", { ...base, video: msg.video.file_id });
    await saveMessage(session.id, "agent", "video", msg.video.file_id);
  }
}

// ================= Webhook =================
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg) return res.sendStatus(200);

  try {
    // 客户私聊
    if (msg.chat.type === "private") {
      const session = await getOrCreateSession(msg.chat.id);
      await forwardToGroup(session, msg);
    }

    // 客服群话题回复
    if (
      msg.chat.id.toString() === GROUP_CHAT_ID &&
      msg.message_thread_id
    ) {
      const { rows } = await pool.query(
        "SELECT * FROM sessions WHERE topic_id=$1",
        [msg.message_thread_id]
      );

      if (rows.length) {
        await forwardToCustomer(rows[0], msg);
      }
    }
  } catch (e) {
    console.error(e.message);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log("Bot running on port", PORT);
});
