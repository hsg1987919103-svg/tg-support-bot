import express from "express";
import { Telegraf } from "telegraf";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

console.log("🔑 BOT_TOKEN =", BOT_TOKEN);
console.log("👥 GROUP_CHAT_ID =", GROUP_CHAT_ID);
console.log("🌐 WEBHOOK_URL =", WEBHOOK_URL);

const bot = new Telegraf(BOT_TOKEN);

// -----------------------------
// A. 客户 → 发消息到机器人
// 自动转发到客服群
// -----------------------------
bot.on("message", async (ctx) => {
    try {
        const msg = ctx.message;

        const userId = msg.from.id;
        const username = msg.from.username ? `@${msg.from.username}` : "无用户名";
        const name = msg.from.first_name || "";
        const text = msg.text || "(非文字消息)";

        const forwardText =
            `📩 客户来信\n` +
            `ID: ${userId}\n` +
            `用户: ${username}\n` +
            `名称: ${name}\n\n` +
            `${text}`;

        await ctx.telegram.sendMessage(GROUP_CHAT_ID, forwardText);
        console.log("✔️ 已转发客户消息到群组");
    } catch (err) {
        console.error("❌ 转发失败:", err);
    }
});

// ------------------------------------------------
// B. 客服在群里回复 → 只把“真正的回复内容”发回客户
// ------------------------------------------------
bot.on("message", async (ctx) => {
    try {
        const msg = ctx.message;
        const chatId = msg.chat.id;

        // 只处理群组消息
        if (chatId.toString() !== GROUP_CHAT_ID) return;

        if (!msg.reply_to_message) return; // 如果没有 reply，不处理

        const repliedText = msg.reply_to_message.text;
        if (!repliedText) return;

        // -----------------------------
        // 解析客户 ID
        // -----------------------------
        const match = repliedText.match(/ID:\s*(\d+)/);
        if (!match) {
            console.log("⚠️ 无法解析客户 ID");
            return;
        }

        const targetUserId = match[1]; // 客户 Telegram ID

        // -----------------------------
        // 客服真正回复的内容 = 当前这条消息
        // 但需要去除前缀信息
        // -----------------------------
        let replyText = msg.text || "";

        // 删除这些固定前缀
        const removePatterns = [
            "📩 Mensaje del cliente",
            "📩 客户来信",
            "ID:",
            "Usuario:",
            "用户:",
            "Nombre:",
            "名称:"
        ];

        removePatterns.forEach(p => {
            replyText = replyText.replace(p, "");
        });

        // 删除可能多余空行
        replyText = replyText.trim();

        if (!replyText) {
            console.log("⚠️ 回复内容为空，忽略发送");
            return;
        }

        // -----------------------------
        // 发送给客户
        // -----------------------------
        await ctx.telegram.sendMessage(targetUserId, replyText);

        console.log("📤 已发送客服回复给客户:", targetUserId);

    } catch (err) {
        console.error("❌ 处理客服回复失败:", err);
    }
});

// -----------------------------
// 设置 Webhook
// -----------------------------
bot.telegram.setWebhook(`${WEBHOOK_URL}`);

app.post("/webhook", (req, res) => {
    bot.handleUpdate(req.body);
    res.sendStatus(200);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});
