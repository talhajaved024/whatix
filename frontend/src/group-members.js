import {authorizedFetch} from "./auth.js";
import {SESSION} from "./sender.js";

export function memberId(value) {
  const raw = typeof value === "string" ? value : value?._serialized ||
    (value?.user && value.server ? value.user + "@" + value.server : "");
  return raw.replace(/:\d+(?=@)/, "").replace(/@s\.whatsapp\.net$/, "@c.us");
}

export function phoneId(value) {
  const match = /^\+?([1-9]\d{0,14})(?:@c\.us)?$/.exec(memberId(value));
  return match ? match[1] + "@c.us" : "";
}

export function messageAuthor(msg) {
  const data = msg._data;
  const ids = [msg.participantAlt, data?.key?.participantAlt, data?.Info?.SenderAlt,
    msg.participant?.pn, msg.participant?.id, msg.participant, msg.author, data?.author, data?.key?.participant, data?.Info?.Sender];
  return {
    participantLid: [msg.participantLid,...ids].map(memberId).find(id => /^\d+@lid$/.test(id)),
    participant: ids.map(phoneId).find(Boolean) || ids.map(memberId).find(id => /^\d+@lid$/.test(id)),
    participantName: [msg.participantName,data?.notifyName,data?.pushName,data?.Info?.PushName]
      .find(name => typeof name === "string" && name.trim())
  };
}

export function groupMember(row) {
  const id = memberId(row?.id ?? row);
  const phone = [row?.pn,row?.phoneNumber,id].map(phoneId).find(Boolean);
  const role = row?.role || row?.admin || (row?.isSuperAdmin ? "superadmin" : row?.isAdmin ? "admin" :
    (typeof row?.isAdmin === "boolean" || row?.admin === null) ? "participant" : "");
  const roles = {superadmin:"Super admin",admin:"Admin",participant:"Member"};
  return {id,phone,role:roles[role] || "Role unavailable",
    name:[row?.name,row?.pushName,row?.notifyName].find(name => typeof name === "string" && name.trim())};
}

export async function loadGroupMembers(id,signal) {
  const path = "/api/" + encodeURIComponent(SESSION) + "/groups/" + encodeURIComponent(id) + "/participants";
  let response = await authorizedFetch(path + "/v2",{signal,cache:"no-store"});
  if ([404,405,501].includes(response.status)) response = await authorizedFetch(path,{signal,cache:"no-store"});
  if (!response.ok) throw new Error("Could not load group members (HTTP " + response.status + ").");
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("WhatsApp returned an unreadable member list.");
  return rows.filter(row => row?.role !== "left").map(groupMember);
}
