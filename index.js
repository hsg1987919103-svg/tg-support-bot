import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// 环境变量
const TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// 设置 webhook
async function setWebhook() {
    try {
        const res = await axios.get(`${API}/setWebhook`, {
            params: { url: WEBHOOK_URL }
        });
        console.log("Webhook 设置结果：", res.data);
    } catch (err) {
        console.error("Webhook 设置失败：", err.response?.data || err.message);
    }
}
setWebhook();

// ==========================
// 只做一件事：转发用户消息
// ==========================
app.post("/webhook", async (req, res) => {
    res.send("OK");

    const msg = req.body.message;
    if (!msg) return;

    const chatId = msg.chat.id;

    // 👉 仅处理用户私聊（chatId > 0）
    if (chatId > 0) {
        const username = msg.from?.username
            ? `@${msg.from.username}`
            : "无";

        const name = `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim();

        const text = msg.text || "";

        // 发送到客服群
        await axios.post(`${API}/sendMessage`, {
            chat_id: GROUP_CHAT_ID,
            parse_mode: "Markdown",
            text:
                `📩 *Mensaje del cliente*\n` +
                `ID: \`${chatId}\`\n` +
                `Usuario: ${username}\n` +
                `Nombre: ${name}\n` +
                `Contenido:\n${text}`
        });
    }
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("bot 已启动，端口:", PORT);
});
