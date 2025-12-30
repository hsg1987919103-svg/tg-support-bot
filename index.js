import express from "express";
import axios from "axios";
import fs from "fs";

const app = express();
app.use(express.json());

// ===================== 配置 =====================
const TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = Number(process.env.GROUP_CHAT_ID);
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!TOKEN || !GROUP_CHAT_ID || !WEBHOOK_URL) {
  console.error("❌ 缺少环境变量");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

// ===================== 映射文件 =====================
const MAP_FILE = "./mapping.json";

function loadMap() {
  try {
    if (!fs.existsSync(MAP_FILE)) return {};
    return JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveMap(map) {
  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
}

// ===================== 消息内容解析 =====================
function extractText(msg) {
  if (msg.text) return msg.text;
  if (msg.caption) return msg.caption;
  if (msg.photo) return "[图片]";
  if (msg.voice) return "[语音]";
  if (msg.video) return "[视频]";
  if (msg.document) return "[文件]";
  if (msg.sticker) return "[贴纸]";
  return "[不支持的消息类型]";
}

// ===================== 设置 Webhook =====================
async function setWebhook() {
  try {
    const res = await axios.post(`${API}/setWebhook`, {
      url: WEBHOOK_URL,
    });
    console.log("✅ Webhook 已设置", res.data);
  } catch (e) {
    console.error("❌ Webhook 设置失败", e.response?.data || e.message);
  }
}
setWebhook();

// ===================== Webhook =====================
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    if (!update.message) return res.sendStatus(200);

    const msg = update.message;
    const chatType = msg.chat.type;

    // ===================== 1️⃣ 用户私聊 Bot =====================
    if (chatType === "private") {
      const userId = msg.chat.id;
      const text = extractText(msg);

      console.log(`👤 用户 ${userId}: ${text}`);

      // 转发到客服群
      const sent = await axios.post(`${API}/sendMessage`, {
        chat_id: GROUP_CHAT_ID,
        text: `👤 客户 ${userId}\n\n${text}`,
      });

      // 记录映射：群消息ID → 用户ID
      const map = loadMap();
      map[sent.data.result.message_id] = userId;
      saveMap(map);

      return res.sendStatus(200);
    }

    // ===================== 2️⃣ 客服在群里回复 =====================
    if (
      chatType === "supergroup" &&
      msg.chat.id === GROUP_CHAT_ID &&
      msg.reply_to_message &&
      !msg.from.is_bot
    ) {
      const map = loadMap();
      const repliedMsgId = msg.reply_to_message.message_id;
      const userId = map[repliedMsgId];

      if (!userId) return res.sendStatus(200);

      const text = extractText(msg);
      console.log(`💬 客服 → 用户 ${userId}: ${text}`);

      await axios.post(`${API}/sendMessage`, {
        chat_id: userId,
        text: `💬 客服回复：\n${text}`,
      });

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook 处理失败：", e.response?.data || e.message);
    res.sendStatus(200);
  }
});

// ===================== 启动 =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot 已启动，监听端口 ${PORT}`);
});
