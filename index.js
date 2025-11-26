import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ===================== 配置 =====================
const TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID; // -100 开头（必须是字符串）

console.log("🔧 BOT_TOKEN =", TOKEN);
console.log("🔧 SUPPORT_CHAT_ID =", SUPPORT_CHAT_ID, "type =", typeof SUPPORT_CHAT_ID);
console.log("🔧 WEBHOOK_URL =", WEBHOOK_URL);

const API = `https://api.telegram.org/bot${TOKEN}`;

// 内存映射（重启会丢失）
const customerToTopic = new Map(); // customerId -> topicId
const topicToCustomer = new Map(); // topicId -> customerId

// ===================== 设置 Webhook =====================
async function setWebhook() {
  try {
    const res = await axios.get(`${API}/setWebhook`, {
      params: { url: WEBHOOK_URL }
    });
    console.log("Webhook 已设置：", res.data);
  } catch (e) {
    console.error("Webhook 设置失败：", e.response?.data || e.message);
  }
}
setWebhook();

// ===================== 日志函数 =====================
function logMessage(prefix, msg) {
  console.log(
    `${prefix} chatId=${msg.chat.id} type=${msg.chat.type} ` +
      `thread=${msg.message_thread_id ?? "-"} from=${msg.from.id} ` +
      `text=${msg.text || "[非文本]"}`
  );
}

// ===================== 创建 / 获取话题 =====================
async function getOrCreateTopic(customer) {
  const customerId = customer.id;

  if (customerToTopic.has(customerId)) {
    return customerToTopic.get(customerId);
  }

  const username = customer.username ? `@${customer.username}` : "无";
  const name =
    `${customer.first_name || ""} ${customer.last_name || ""}`.trim() || "无";
  const title = `客户 #${customerId}（${username}）`;

  console.log("🧵 创建话题：", title, "chat_id =", SUPPORT_CHAT_ID);

  // 可选：调试 getChat，确认 chat_id 是否可用
  try {
    const chatInfo = await axios.get(`${API}/getChat`, {
      params: { chat_id: SUPPORT_CHAT_ID }
    });
    console.log("getChat 结果：", chatInfo.data?.result?.title);
  } catch (e) {
    console.error("getChat 失败：", e.response?.data || e.message);
  }

  const res = await axios.post(`${API}/createForumTopic`, {
    chat_id: SUPPORT_CHAT_ID,
    name: title
  });

  const topicId = res.data?.result?.message_thread_id;
  if (!topicId) throw new Error("createForumTopic 未返回 message_thread_id");

  customerToTopic.set(customerId, topicId);
  topicToCustomer.set(topicId, customerId);

  return topicId;
}

// ===================== 主 Webhook =====================
app.post("/", async (req, res) => {
  const update = req.body;
  const msg = update.message;
  if (!msg) return res.sendStatus(200);

  logMessage("收到消息：", msg);

  const chatType = msg.chat.type;

  // =============== 情况 1：客户私聊机器人 ===============
  if (chatType === "private") {
    const customer = msg.from;
    const customerId = customer.id;

    try {
      // ------------------ 自动欢迎新用户（只发一次） ------------------
      if (!customerToTopic.has(customerId)) {
        const botInfo = await axios.get(`${API}/getMe`);
        const botName =
          botInfo.data?.result?.username ||
          botInfo.data?.result?.first_name ||
          "mi asistente";

        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: `¡Hola cariño! Soy ${botName} 🤖\nEstoy aquí para ayudarte, ¿en qué necesitas apoyo?`
        });
      }

      // ------------------ 创建或获取话题 ------------------
      const topicId = await getOrCreateTopic(customer);

      // ------------------ 构建内容 ------------------
      let content = msg.text || "";
      if (!content) {
        if (msg.photo) content = "[Imagen]";
        else if (msg.document) content = "[Documento]";
        else content = "[Mensaje no textual]";
      }

      const username = customer.username ? `@${customer.username}` : "no";
      const fullName =
        `${customer.first_name || ""} ${customer.last_name || ""}`.trim() ||
        "no";

      const header =
        `📩 Mensaje del cliente\n` +
        `ID: ${customerId}\nUsuario: ${username}\nNombre: ${fullName}\n`;

      // ------------------ 发到话题 ------------------
      await axios.post(`${API}/sendMessage`, {
        chat_id: SUPPORT_CHAT_ID,
        message_thread_id: topicId,
        text: `${header}Contenido:\n${content}`
      });

      // ------------------ 图片处理 ------------------
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: SUPPORT_CHAT_ID,
          message_thread_id: topicId,
          photo: fileId,
          caption: `Imagen enviada por el cliente (ID ${customerId})`
        });
      }
    } catch (e) {
      console.error("处理客户消息失败：", e.response?.data || e.message);
    }

    return res.sendStatus(200);
  }

  // =============== 情况 2：客服在群里回复 ===============
  if (chatType === "supergroup") {
    // 只处理我们的客服群（注意：左边转字符串比较）
    if (String(msg.chat.id) !== SUPPORT_CHAT_ID) {
      return res.sendStatus(200);
    }

    const topicId = msg.message_thread_id;
    if (!topicId) return res.sendStatus(200); // 必须在话题里回复

    if (msg.from.is_bot) return res.sendStatus(200); // 不处理机器人消息

    const customerId = topicToCustomer.get(topicId);
    if (!customerId) {
      console.log("⚠️ 没找到对应客户 topicId =", topicId);
      return res.sendStatus(200);
    }

    try {
      // 图片
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: customerId,
          photo: fileId,
          caption: msg.caption || ""
        });
        return res.sendStatus(200);
      }

      // 文本
      if (msg.text) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: msg.text
        });
      }
    } catch (e) {
      console.error("客服回复失败：", e.response?.data || e.message);
    }

    return res.sendStatus(200);
  }

  // 其他类型忽略
  return res.sendStatus(200);
});

// ===================== 启动服务器 =====================
app.listen(Number(process.env.PORT) || 3000, () => {
  console.log("🚀 Bot 已启动");
});
