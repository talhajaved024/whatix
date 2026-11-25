import {memberId,phoneId} from "./group-members.js";

export function mentionedIds(message) {
  const data = message._data;
  const content = data?.message || data?.Message || {};
  const lists = [message.mentions,message.mentionedIds,data?.mentionedJidList,data?.mentionedIds,
    ...Object.values(content).map(part => part?.contextInfo?.mentionedJid)];
  return [...new Set(lists.filter(Array.isArray).flat().map(memberId)
    .filter(id => /^\d+@(lid|c\.us)$/.test(id)))];
}

export function isSelfMention(id, identity, mappedPhone) {
  if (!identity || !id) return false;
  if (identity.lid && memberId(id) === identity.lid) return true;
  const ownPhone = phoneId(identity.number);
  return !!ownPhone && (phoneId(id) === ownPhone || phoneId(mappedPhone) === ownPhone);
}

export function mentionParts(text, ids, knownId) {
  if (typeof text !== "string" || !text.includes("@")) return [text];
  const mentions = new Map(ids.map(memberId).map(id => [id.split("@")[0],id]));
  const parts = [];
  let offset = 0;
  const token = /(?<![\p{L}\p{N}_.+@/-])@(\d+)(?:@(lid|c\.us|s\.whatsapp\.net))?(?![\p{L}\p{N}_@]|\.[\p{L}\p{N}])/gu;
  for (const match of text.matchAll(token)) {
    const digits = match[1];
    const id = match[2] ? memberId(digits + "@" + match[2]) : mentions.get(digits) || knownId(digits);
    if (!id) continue;
    parts.push(text.slice(offset,match.index),{id});
    offset = match.index + match[0].length;
  }
  parts.push(text.slice(offset));
  return parts;
}
