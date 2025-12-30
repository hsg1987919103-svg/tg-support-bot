import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const PORT = process.env.PORT || 3000;

// ================= 测试接口 =================
app.get("/", (req, res) => {
  res.send("OK");
});

// ================= Webhook 接口（关键） =================
app.post("/webhook", async (req, res) => {
  try {
    console.log("🔥 Webhook hit");

    const update = req.body;
    console.log(JSON.stringify(update, null, 2));

    // ⚠️ 一定要立刻返回 200
    res.sendStatus(200);

    // 后面逻辑可以慢慢处理
    if (!update.message) return;

    const msg = update.message;

    // 客户私聊机器人
    if (msg.chat.type === "private") {
      await axios.post(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          chat_id: GROUP_CHAT_ID,
          text: `📩 新客户消息\n👤 ${msg.from.first_name}\n🆔 ${msg.from.id}\n\n${msg.text || "[非文本消息]"}`
        }
      );
    }
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    // 这里 **绝对不要** res.send()
  }
});

// ================= 启动 =================
app.listen(PORT, "0.0.0.0", () => {
  console.log("Bot running on port", PORT);
});
