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
const MAPPING_FILE = "./mapping.json";

// ===================== 映射 =====================
const customerToTopic = new Map();
const topicToCustomer = new Map();
const customerMsgToGroupMsg = new Map();
const groupMsgToCustomer = new Map();

// ===================== 映射持久化 =====================
function loadMapping() {
  if (!fs.existsSync(MAPPING_FILE)) return;
  const d = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf8"));
  d.customerToTopic?.forEach(([k, v]) => customerToTopic.set(k, v));
  d.topicToCustomer?.forEach(([k, v]) => topicToCustomer.set(k, v));
  d.customerMsgToGroupMsg?.forEach(([k, v]) => customerMsgToGroupMsg.set(k, v));
  d.groupMsgToCustomer?.forEach(([k, v]) => groupMsgToCustomer.set(k, v));
  console.log("📥 映射已加载");
}

function saveMapping() {
  fs.writeFileSync(
    MAPPING_FILE,
    JSON.stringify({
      customerToTopic: [...customerToTopic],
      topicToCustomer: [...topicToCustomer],
      customerMsgToGroupMsg: [...customerMsgToGroupMsg],
      groupMsgToCustomer: [...groupMsgToCustomer],
    }, null, 2)
  );
}

loadMapping();

// ===================== Webhook =====================
axios.get(`${API}/setWebhook`, { params: { url: WEBHOOK_URL } })
  .then(() => console.log("✅ Webhook 已设置"))
  .catch(e => console.error("❌ Webhook 失败", e.message));

// ===================== 工具函数 =====================
async function safeDelete(chatId, messageId) {
  try {
    await axios.post(`${API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId
    });
  } catch {}
}

async function getOrCreateTopic(customerId) {
  if (customerToTopic.has(customerId)) {
    return customerToTopic.get(customerId);
  }

  const r = await axios.post(`${API}/createForumTopic`, {
    chat_id: GROUP_CHAT_ID,
    name: `客户 ${customerId}`,
  });

  const topicId = r.data.result.message_thread_id;
  customerToTopic.set(customerId, topicId);
  topicToCustomer.set(topicId, customerId);
  saveMapping();

  await new Promise(r => setTimeout(r, 300));
  return topicId;
}

async function safeSend(method, payload, customerId) {
  let topicId = await getOrCreateTopic(customerId);

  try {
    return await axios.post(`${API}/${method}`, {
      ...payload,
      chat_id: GROUP_CHAT_ID,
      message_thread_id: topicId,
    });
  } catch (e) {
    const desc = e.response?.data?.description || "";
    if (/thread|topic/i.test(desc)) {
      customerToTopic.delete(customerId);
      topicToCustomer.delete(topicId);
      saveMapping();

      topicId = await getOrCreateTopic(customerId);

      return await axios.post(`${API}/${method}`, {
        ...payload,
        chat_id: GROUP_CHAT_ID,
        message_thread_id: topicId,
      });
    }
    throw e;
  }
}

// ===================== Webhook 入口 =====================
app.post("/webhook", async (req, res) => {
  const u = req.body;

  // ===== 删除同步 =====
  if (u.deleted_messages) {
    for (const m of u.deleted_messages) {
      const id = m.message_id;

      if (customerMsgToGroupMsg.has(id)) {
        const gid = customerMsgToGroupMsg.get(id);
        await safeDelete(GROUP_CHAT_ID, gid);
        customerMsgToGroupMsg.delete(id);
        groupMsgToCustomer.delete(gid);
      }

      if (groupMsgToCustomer.has(id)) {
        const { customerId, customerMsgId } = groupMsgToCustomer.get(id);
        await safeDelete(customerId, customerMsgId);
        groupMsgToCustomer.delete(id);
        customerMsgToGroupMsg.delete(customerMsgId);
      }
    }
    saveMapping();
    return res.sendStatus(200);
  }

  const msg = u.message;
  if (!msg) return res.sendStatus(200);

  // ===================== 客户私聊 =====================
  if (msg.chat.type === "private") {
    const customerId = msg.from.id;

    if (msg.text === "/start") {
      if (customerToTopic.has(customerId)) {
        return res.sendStatus(200);
      }

      await axios.post(`${API}/sendMessage`, {
        chat_id: customerId,
        text: "Hola soy Lia, ¿cómo debería llamarte?",
      });
      return res.sendStatus(200);
    }

    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ");
    const username = msg.from.username ? `@${msg.from.username}` : "无用户名";
    const header = `👤 <b>${name || "未知"}</b> (${username} | ${customerId})`;

    let sent;

    try {
      if (msg.text) {
        sent = await safeSend("sendMessage", {
          text: `${header}\n\n${msg.text}`,
          parse_mode: "HTML",
        }, customerId);
      } else if (msg.photo) {
        sent = await safeSend("sendPhoto", {
          photo: msg.photo.at(-1).file_id,
          caption: header,
          parse_mode: "HTML",
        }, customerId);
      } else {
        const map = {
          voice: ["sendVoice", "voice"],
          audio: ["sendAudio", "audio"],
          video: ["sendVideo", "video"],
          video_note: ["sendVideoNote", "video_note"],
          document: ["sendDocument", "document"],
          sticker: ["sendSticker", "sticker"],
        };

        for (const k in map) {
          if (msg[k]) {
            const [method, field] = map[k];
            sent = await safeSend(method, {
              [field]: msg[k].file_id,
              caption: header,
              parse_mode: "HTML",
            }, customerId);
            break;
          }
        }
      }

      if (sent) {
        const gid = sent.data.result.message_id;
        customerMsgToGroupMsg.set(msg.message_id, gid);
        groupMsgToCustomer.set(gid, {
          customerId,
          customerMsgId: msg.message_id
        });
        saveMapping();
      }
    } catch (e) {
      console.error("❌ 客户消息失败", e.response?.data || e.message);
    }

    return res.sendStatus(200);
  }

  // ===================== 客服群（真对话模式） =====================
  if (
    msg.chat.type === "supergroup" &&
    String(msg.chat.id) === GROUP_CHAT_ID &&
    msg.message_thread_id &&
    !msg.from.is_bot
  ) {
    const customerId = topicToCustomer.get(msg.message_thread_id);
    if (!customerId) return res.sendStatus(200);

    try {
      const method =
        msg.text ? "sendMessage" :
        msg.photo ? "sendPhoto" :
        msg.voice ? "sendVoice" :
        msg.audio ? "sendAudio" :
        msg.video ? "sendVideo" :
        msg.video_note ? "sendVideoNote" :
        msg.document ? "sendDocument" :
        msg.sticker ? "sendSticker" :
        null;

      if (!method) return res.sendStatus(200);

      const payload =
        msg.text ? { text: msg.text } :
        msg.photo ? { photo: msg.photo.at(-1).file_id } :
        msg.voice ? { voice: msg.voice.file_id } :
        msg.audio ? { audio: msg.audio.file_id } :
        msg.video ? { video: msg.video.file_id } :
        msg.video_note ? { video_note: msg.video_note.file_id } :
        msg.document ? { document: msg.document.file_id } :
        msg.sticker ? { sticker: msg.sticker.file_id } : {};

      // 🔑 真对话关键：reply 映射
      const replyToGroupMsgId = msg.reply_to_message?.message_id;
      const replyMapping =
        replyToGroupMsgId &&
        groupMsgToCustomer.get(replyToGroupMsgId);

      const sent = await axios.post(`${API}/${method}`, {
        chat_id: customerId,
        ...payload,
        ...(replyMapping && {
          reply_to_message_id: replyMapping.customerMsgId
        }),
      });

      // 🔁 建立双向映射
      const customerMsgId = sent.data.result.message_id;

      groupMsgToCustomer.set(msg.message_id, {
        customerId,
        customerMsgId
      });
      customerMsgToGroupMsg.set(customerMsgId, msg.message_id);
      saveMapping();

    } catch (e) {
      console.error("❌ 客服回复失败", e.response?.data || e.message);
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// ===================== 启动 =====================
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Telegram 客服 Bot（真对话模式）已启动");
});
