import {inboxUrl} from "./inbox.js";

export function receivedMedia(message) {
  const media = message.media || {};
  const mime = String(media.mimetype || message._data?.mimetype || "").toLowerCase();
  const hint = message._data?.type || message.type;
  const voice = hint === "ptt" || hint === "audio" || mime.startsWith("audio/");
  if (!voice && !message.hasMedia && !message.media) return {};
  const kind = voice ? "voice" : mime.startsWith("image/") || hint === "image" ? "image"
    : mime.startsWith("video/") || hint === "video" ? "video" : "document";
  let src;
  if (typeof media.url === "string") {
    try {
      const url = new URL(media.url,"http://localhost:3000");
      const path=url.pathname+url.search;
      if (path.startsWith("/api/files/")) src = inboxUrl(path);
    } catch { /* WAHA can report unavailable media. */ }
  }
  return {kind, src, filename:media.filename || message._data?.filename ||
    (src && decodeFilename(src)) || (kind === "document" ? "Attachment" : kind)};
}

function decodeFilename(path) {
  const name = path.split("/").pop();
  try { return decodeURIComponent(name); } catch { return name; }
}
