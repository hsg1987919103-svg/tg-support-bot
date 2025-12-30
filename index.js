import express from "express";
import axios from "axios";
import fs from "fs";

const app = express();
app.use(express.json());

// ===================== 配置 =====================
const TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = Number(process.env.GROUP_CHAT_ID);
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const API = `https://api.telegram.org/bot${TOKEN}`;

console.log("🔧 BOT_TOKEN =", TOKEN ? "OK" : "MISSING");
console.log("🔧 GROUP_CHAT_ID =", GROUP_CHAT_ID);
console.log("🔧 WEBHOOK_URL =", WEBHOOK_URL);

// ===================== mapping =====================
const MAP_FILE = "./mapping.json";

const loadMap = () => {
  try {
    return fs.existsSync(MAP_FILE)
      ? JSON.parse(fs.readFileSync(MAP_FILE, "utf8"))
      : {};
  } catch {
    return {};
  }
};

const saveMap = (map) =>
  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));

// ===================== 消息解析 =====================
function extractText(msg) {
  if (msg.text) return msg.text;
  if (msg.caption) return msg.caption;
  if (msg.photo) return "[图片]";
  if (msg.voice) return "[语音]";
  if (msg.video) return "[视频]";
  if (msg.document) return "[文件]";
  return "[未知消息]";
}

// ===================== Webhook =====================
async function setWebhook() {
  try {
    const res = await axios.post(`${API}/setWebhook`, {
      url: WEBHOOK_URL,
    });
    console.log("✅ Webhook 设置成功");
  } catch (e) {
    console.error(
      "⚠️ Webhook 设置失败（可忽略）:",
      e.response?.data || e.message
    );
  }
}
setWebhook();

// ===================== Webhook Handler =====================
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg) return res.sendStatus(200);

    // ========== 用户私聊 ==========
    if (msg.chat.type === "private") {
      const userId = msg.chat.id;
      const text = extractText(msg);

      console.log(`👤 用户 ${userId}: ${text}`);

      const sent = await axios.post(`${API}/sendMessage`, {
        chat_id: GROUP_CHAT_ID,
        text: `👤 客户 ${userId}\n\n${text}`,
      });

      const map = loadMap();
      map[sent.data.result.message_id] = userId;
      saveMap(map);

      return res.sendStatus(200);
    }

    // ========== 客服回复 ==========
    if (
      msg.chat.id === GROUP_CHAT_ID &&
      msg.reply_to_message &&
      !msg.from.is_bot
    ) {
      const map = loadMap();
      const userId = map[msg.reply_to_message.message_id];
      if (!userId) return res.sendStatus(200);

      const text = extractText(msg);

      await axios.post(`${API}/sendMessage`, {
        chat_id: userId,
        text: `💬 客服回复：\n${text}`,
      });
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(
      "❌ Webhook处理失败：",
      e.response?.data || e.message
    );
    res.sendStatus(200);
  }
});

// ===================== 启动 =====================
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Bot 已启动");
});
