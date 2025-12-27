import express from "express";
import axios from "axios";
import fs from "fs";

const app = express();
app.use(express.json());

// ===================== 配置 =====================
const TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = String(process.env.GROUP_CHAT_ID);
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const API = `https://api.telegram.org/bot${TOKEN}`;

// ===================== 持久化存储 =====================
const MAPPING_FILE = "./mapping.json";

const customerToTopic = new Map();          // customerId -> topicId
const topicToCustomer = new Map();          // topicId -> customerId
const customerMsgToGroupMsg = new Map();    // customerMsgId -> groupMsgId
const groupMsgToCustomer = new Map();       // groupMsgId -> { customerId, customerMsgId }

// ===================== 加载映射 =====================
function loadMapping() {
  if (!fs.existsSync(MAPPING_FILE)) return;

  try {
    const data = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf8"));
    data.customerToTopic?.forEach(([k, v]) => customerToTopic.set(k, v));
    data.topicToCustomer?.forEach(([k, v]) => topicToCustomer.set(k, v));
    data.customerMsgToGroupMsg?.forEach(([k, v]) => customerMsgToGroupMsg.set(k, v));
    data.groupMsgToCustomer?.forEach(([k, v]) => groupMsgToCustomer.set(k, v));
    console.log("📥 映射已加载");
  } catch (e) {
    console.error("❌ 映射读取失败", e.message);
  }
}

function saveMapping() {
  const data = {
    customerToTopic: [...customerToTopic],
    topicToCustomer: [...topicToCustomer],
    customerMsgToGroupMsg: [...customerMsgToGroupMsg],
    groupMsgToCustomer: [...groupMsgToCustomer],
  };
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(data, null, 2));
}

loadMapping();

// ===================== Webhook =====================
async function setWebhook() {
  try {
    await axios.get(`${API}/setWebhook`, {
      params: { url: WEBHOOK_URL },
    });
    console.log("✅ Webhook 已设置");
  } catch (e) {
    console.error("❌ Webhook 设置失败", e.response?.data || e.message);
  }
}
setWebhook();

// ===================== 安全删除 =====================
async function safeDelete(chatId, messageId) {
  if (!chatId || !messageId) return;

  try {
    await axios.post(`${API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch {
    // 超过48小时 / 已删除 / 无权限，全部忽略
  }
}

// ===================== 创建 / 获取话题 =====================
async function getOrCreateTopic(customerId) {
  if (customerToTopic.has(customerId)) {
    return customerToTopic.get(customerId);
  }

  const res = await axios.post(`${API}/createForumTopic`, {
    chat_id: GROUP_CHAT_ID,
    name: `客户 ${customerId}`,
  });

  const topicId = res.data?.result?.message_thread_id;
  if (!topicId) throw new Error("未获取 topicId");

  customerToTopic.set(customerId, topicId);
  topicToCustomer.set(topicId, customerId);
  saveMapping();

  // ⚠️ 给 Telegram 时间稳定话题
  await new Promise(r => setTimeout(r, 300));

  return topicId;
}

// ===================== Webhook 入口 =====================
app.post("/webhook", async (req, res) => {
  const update = req.body;

  // ===================== 同步删除处理 =====================
  if (update.deleted_messages) {
    for (const m of update.deleted_messages) {
      const msgId = m.message_id;

      // 客户删 → 群删
      if (customerMsgToGroupMsg.has(msgId)) {
        const groupMsgId = customerMsgToGroupMsg.get(msgId);

        await safeDelete(GROUP_CHAT_ID, groupMsgId);

        customerMsgToGroupMsg.delete(msgId);
        groupMsgToCustomer.delete(groupMsgId);
        saveMapping();
      }

      // 客服删 → 客户删
      if (groupMsgToCustomer.has(msgId)) {
        const { customerId, customerMsgId } = groupMsgToCustomer.get(msgId);

        await safeDelete(customerId, customerMsgId);

        groupMsgToCustomer.delete(msgId);
        customerMsgToGroupMsg.delete(customerMsgId);
        saveMapping();
      }
    }

    return res.sendStatus(200);
  }

  // ===================== 普通消息 =====================
  const msg = update.message;
  if (!msg) return res.sendStatus(200);

  const chatType = msg.chat.type;

  // ===================== 1. 客户私聊 =====================
  if (chatType === "private") {
    const customerId = msg.from.id;

    if (!msg.text) return res.sendStatus(200);

    if (msg.text === "/start") {
      await axios.post(`${API}/sendMessage`, {
        chat_id: customerId,
        text: "Hola soy Lia, ¿cómo debería llamarte?",
      });
      return res.sendStatus(200);
    }

    try {
      const topicId = await getOrCreateTopic(customerId);

      const sent = await axios.post(`${API}/sendMessage`, {
        chat_id: GROUP_CHAT_ID,
        message_thread_id: topicId,
        text: msg.text,
      });

      const groupMsgId = sent.data.result.message_id;

      customerMsgToGroupMsg.set(msg.message_id, groupMsgId);
      groupMsgToCustomer.set(groupMsgId, {
        customerId,
        customerMsgId: msg.message_id,
      });
      saveMapping();
    } catch (e) {
      console.error("❌ 客户消息处理失败", e.response?.data || e.message);
    }

    return res.sendStatus(200);
  }

  // ===================== 2. 客服群回复 =====================
  if (chatType === "supergroup") {
    if (String(msg.chat.id) !== GROUP_CHAT_ID) return res.sendStatus(200);
    if (!msg.message_thread_id) return res.sendStatus(200);
    if (msg.from.is_bot) return res.sendStatus(200);

    const customerId = topicToCustomer.get(msg.message_thread_id);
    if (!customerId) return res.sendStatus(200);

    try {
      // 引用回复
      if (msg.reply_to_message) {
        const map = groupMsgToCustomer.get(msg.reply_to_message.message_id);
        if (map) {
          await axios.post(`${API}/sendMessage`, {
            chat_id: customerId,
            text: msg.text,
            reply_to_message_id: map.customerMsgId,
          });
          return res.sendStatus(200);
        }
      }

      // 普通回复
      if (msg.text) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: msg.text,
        });
      }
    } catch (e) {
      console.error("❌ 客服回复失败", e.response?.data || e.message);
    }

    return res.sendStatus(200);
  }

  return res.sendStatus(200);
});

// ===================== 启动 =====================
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Bot 已启动（已支持同步删除）");
});
