import { authorizedFetch } from "./auth.js";
import {SESSION} from "./inbox.js";
export {SESSION};
const MAX_BODY_BYTES = 50 * 1024 * 1024;

function recipientId(number) {
  return /@(g\.us|lid|c\.us|s\.whatsapp\.net)$/.test(number) ? number : number + "@c.us";
}

function mediaPayload(kind, number, file, caption, convert = false) {
  const payload = { chatId: recipientId(number), file, mentions: null, reply_to: null, caption, session: SESSION };
  if (kind === "voice") return {chatId:recipientId(number),file,session:SESSION,convert};
  if (kind === "video") Object.assign(payload, { asNote: false, convert });
  return payload;
}

export function uploadSizeError(kind, number, file, caption, convert = false) {
  const metadata = { filename: file.name, mimetype: file.type || "application/octet-stream", data: "" };
  const envelope = JSON.stringify(mediaPayload(kind, number, metadata, caption, convert));
  const bytes = new TextEncoder().encode(envelope).length + 4 * Math.ceil(file.size / 3);
  if (bytes <= MAX_BODY_BYTES) return "";
  return `Encoded request (${bytes.toLocaleString()} bytes) exceeds WAHA's 50 MiB limit. Choose a smaller file or send it as a media link.`;
}

export function parseRecipients(input) {
  const numbers = new Set();
  const invalid = [];
  for (const token of input.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean)) {
    const number = token.replace(/^\+/, "").replace(/[ ()-]/g, "");
    if (/^[1-9]\d{6,14}$/.test(number)) numbers.add(number);
    else invalid.push(token);
  }
  return { numbers: [...numbers], invalid };
}

async function postMessage(endpoint, payload) {
  const response = await authorizedFetch(endpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = await response.text();
    let detail = body;
    try {
      const error = JSON.parse(body);
      const messages = [error?.exception?.message, error?.error?.message, error?.message, error?.error].flat()
        .filter(value => typeof value === "string");
      if (messages.length) detail = [...new Set(messages)].join(" · ");
    } catch { /* Some proxy errors are plain text. */ }
    const failure = new Error(["HTTP " + response.status, detail.slice(0, 500)].filter(Boolean).join(" · "));
    if (payload.file) {
      const file = { ...payload.file };
      if (file.data) file.data = "[Base64 upload: " + file.data.length + " characters]";
      failure.request = "POST " + endpoint + "\n" + JSON.stringify({ ...payload, file }, null, 2);
    }
    throw failure;
  }
  return response.json().catch(() => null);
}

export function sendText(number, text) {
  const chatId = recipientId(number);
  return postMessage("/api/sendText", { chatId, id: chatId, mentions: null, reply_to: null,
    text, linkPreview: true, linkPreviewHighQuality: false, session: SESSION });
}

export function sendImage(number, file, caption) {
  return postMessage("/api/sendImage", mediaPayload("image", number, file, caption));
}

export function sendVoice(number,file,convert) {
  return postMessage("/api/sendVoice",mediaPayload("voice",number,file,"",convert));
}

export function sendVideo(number, file, caption, convert = false) {
  return postMessage("/api/sendVideo", mediaPayload("video", number, file, caption, convert));
}

export function sendSeen(sender) {
  const chatId = sender.replace(/@s\.whatsapp\.net$/, "@c.us");
  return postMessage("/api/sendSeen", { session: SESSION, chatId });
}

// Tells the backend a staff member opened this chat, so no automatic
// "representatives will be with you shortly" reply is sent to it.
export function markAttended(sender) {
  const chatId = sender.includes("@") ? sender.replace(/@s\.whatsapp\.net$/, "@c.us") : sender + "@c.us";
  return postMessage("/api/chats/attended", { chatId });
}

export function sendFile(number, file, caption) {
  return postMessage("/api/sendFile", mediaPayload("document", number, file, caption));
}
