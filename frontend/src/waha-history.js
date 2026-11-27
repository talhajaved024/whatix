import {mentionedIds} from "./group-mentions.js";
import {messageAuthor} from "./group-members.js";
import { authorizedFetch } from "./auth.js";
import { receivedMedia } from "./media.js";
import { useEffect, useState } from "react";
import { SESSION } from "./sender.js";
import { isGroupChat, quotedMessageId } from "./conversations.js";
import { receipt } from "./receipts.js";

// Read at call time: the open inbox can change without a page reload.
const base = () => "/api/" + encodeURIComponent(SESSION) + "/chats";
const limit = 50;
const direct = /^\d+@(?:c\.us|lid|s\.whatsapp\.net)$/;

async function page(path, offset, signal, size = limit) {
  const messages = path.endsWith("/messages");
  const url = base() + path + "?limit=" + size + "&offset=" + offset + "&downloadMedia=";
  let response = await authorizedFetch(url + messages, {signal});
  if ([502,503,504].includes(response.status)) {
    await response.body?.cancel();
    signal.throwIfAborted();
    response = await authorizedFetch(url + "false", {signal});
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const reason = typeof detail?.error === "string" ? " " + detail.error.slice(0,240) : "";
    const source = messages ? "Conversation history" : "Chat list";
    throw new Error(source + " (offset " + offset + ") returned HTTP " + response.status + "." + reason);
  }
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("WAHA returned an invalid history page.");
  return data;
}

// WAHA returns some older history messages that WhatsApp Web has not fully
// loaded (ackName UNKNOWN) without `timestamp` or `_data.t`; in practice these
// were messages containing links. Multiplying undefined gave NaN, which the
// chronological sort cannot place, so such a message stuck to the end of the
// thread like the latest one. Seconds since the epoch, or null when unknown:
function seconds(msg) {
  for (const value of [msg?.timestamp, msg?._data?.t, msg?._data?.mediaKeyTimestamp]) {
    const number = Number(value);
    if (value != null && Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

// Milliseconds for each row of a WAHA message page. A row without a time is
// placed between its neighbours, since WAHA returns the page in time order.
export function pageTimestamps(rows) {
  const known = rows.map(seconds);
  const dated = known.filter(value => value != null);
  const newestFirst = dated.length < 2 || dated[0] >= dated.at(-1);
  return known.map((value, index) => {
    if (value != null) return value * 1000;
    let before = null, after = null;
    for (let j = index - 1; j >= 0 && before == null; j--) before = known[j];
    for (let j = index + 1; j < known.length && after == null; j++) after = known[j];
    const newer = newestFirst ? before : after, older = newestFirst ? after : before;
    if (newer != null && older != null) return (newer + older) * 500;
    if (older != null) return older * 1000 + 1;
    if (newer != null) return newer * 1000 - 1;
    return null;
  });
}

// WhatsApp keeps housekeeping rows in the message list: the "messages are
// end-to-end encrypted" / "security code changed" notices, system templates,
// group events, protocol rows and reaction rows. The phone shows them as small
// notices or not at all; they were never sent or received, so they are not
// shown as message bubbles here (reactions appear on the message they react to).
const systemRows = new Set(["e2e_notification","notification_template","notification","gp2","protocol",
  "broadcast_notification","pinned_message","keep_in_chat","reaction","debug","newsletter_notification"]);
const rowType = msg => msg?._data?.type || msg?.type || "";
export const isSystemRow = msg => systemRows.has(rowType(msg));
// What to show for a row with no text and no loaded media, by WhatsApp type.
const placeholders = {image:"Photo",video:"Video",sticker:"Sticker",document:"Document",ptt:"Voice message",audio:"Audio",
  location:"Location",vcard:"Contact card",multi_vcard:"Contact cards",revoked:"This message was deleted",
  ciphertext:"Waiting for this message",call_log:"Call",poll_creation:"Poll"};

export function historicalMessage(chatId, msg, fallback = null) {
  if ((!direct.test(chatId) && !isGroupChat(chatId)) || !msg || isSystemRow(msg)) return null;
  const {id,ack} = receipt(msg);
  if (!id) return null;
  const number = chatId.replace(/@(?:c\.us|s\.whatsapp\.net)$/, "");
  const known = seconds(msg);
  const timestamp = known != null ? known * 1000 : fallback;
  if (!Number.isFinite(timestamp)) return null;
  const media = receivedMedia(msg);
  const item = { id:(msg.fromMe ? "remote:" : "incoming:") + id, remote:true,
    ...(isGroupChat(chatId) ? {mentions:mentionedIds(msg)} : {}),
    reactions:Array.isArray(msg._data?.reactions) ? msg._data.reactions.map(r => ({actor:r.key?.fromMe ? "self" : "peer",text:r.text,at:Number(r.senderTimestampMs)||0})) : [],
    text:media.kind==="voice" ? "" : msg.body || (msg.hasMedia ? "" : placeholders[rowType(msg)] || "Message"), ...media, timestamp,
    time:new Date(timestamp).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) };
  if (!msg.fromMe) return {...item,sender:chatId,...(isGroupChat(chatId) ? messageAuthor(msg) : {}),alreadyRead:ack >= 3,quotedId:quotedMessageId(msg)};
  return {...item,chatId,recipients:[number],total:1,results:[{number,id,ack,ok:true}]};
}

// A non-numeric time must never reach the comparator: NaN leaves items unsorted.
export const byTime = (a, b) => (Number.isFinite(a.timestamp) ? a.timestamp : 0) - (Number.isFinite(b.timestamp) ? b.timestamp : 0);

export function mergeHistory(local, remote) {
  const ids = new Set(local.map(item=>item.id));
  for (const item of local) for (const r of item.results || []) if (r.id && !(item.formerLabel && item.recipients?.length>1)) ids.add("remote:"+r.id);
  const enriched = local.map(item => {
    const quote = !item.quotedId && item.sender && remote.get(item.id)?.quotedId;
    const media = !item.src && remote.get(item.id);
    const restored = media?.src ? {...item,src:media.src,kind:media.kind,filename:media.filename} : item;
    const match = remote.get(item.id) || (item.results?.length === 1 && remote.get("remote:"+item.results[0].id));
    const withMentions = match?.mentions?.length ? {...restored,mentions:match.mentions} : restored;
    const row = quote ? {...withMentions,quotedId:quote} : withMentions;
    if (!isGroupChat(item.sender) || !remote.get(item.id)?.participant) return row;
    const author = remote.get(item.id);
    return {...row, participantAlt:author.participant, participantLid:author.participantLid || row.participantLid, participantName:row.participantName || author.participantName};
  });
  return [...enriched,...[...remote.values()].filter(item=>!ids.has(item.id))].sort(byTime);
}

export function useWahaHistory(selectedId, contacts, includeGroups) {
  const [messages,setMessages] = useState(new Map());
  const [directory,setDirectory] = useState(new Map());
  // When each chat was last active, including system notices, so a chat whose
  // latest row is a notice keeps its place in the list.
  const [activity,setActivity] = useState(new Map());
  const chatId = directory.has(selectedId) ? selectedId : [...directory.keys()].find(id =>
    contacts.has(id) && contacts.get(id)+"@c.us" === selectedId) || selectedId;
  const [overviewError,setOverviewError] = useState("");
  const [messageError,setMessageError] = useState("");
  const [retry,setRetry] = useState(0);
  const [more,setMore] = useState(null);
  const [request,setRequest] = useState(null);
  function append(items) {
    setMessages(previous => {
      const next = new Map(previous);
      for (const item of items) if (item && (item.src || !next.get(item.id)?.src)) next.set(item.id,item);
      return next;
    });
  }
  useEffect(() => {
    const controller = new AbortController();
    setOverviewError("");
    // Chats whose latest row is a system notice: look back for their newest
    // real message. One with none is notice-only, which the phone does not list.
    async function lookBack(chats) {
      const queue = [...chats];
      const worker = async () => {
        for (let c; (c = queue.shift());) {
          try {
            const rows = await page("/"+encodeURIComponent(c.id)+"/messages",0,controller.signal,10);
            const times = pageTimestamps(rows);
            const real = rows.map((msg,index)=>historicalMessage(c.id,msg,times[index])).filter(Boolean);
            if (real.length) append(real);
            else setDirectory(previous => { const next = new Map(previous); next.delete(c.id); return next; });
          } catch (err) { if (controller.signal.aborted) throw err; /* keep the chat; it is ordered by activity */ }
        }
      };
      await Promise.all([worker(),worker(),worker()]);
    }
    async function load() {
      const noticesLast = [];
      for (let offset=0;;offset+=limit) {
        const chats = await page("/overview",offset,controller.signal);
        const visibleChats = chats.filter(chat=>direct.test(chat.id) || (includeGroups && isGroupChat(chat.id)));
        setDirectory(previous => new Map([...previous,...visibleChats.map(c=>[c.id,c.name || c._chat?.name || c.id])]));
        setActivity(previous => new Map([...previous,...visibleChats.map(c=>[c.id,(Number(c._chat?.t) || Number(c.lastMessage?.timestamp) || 0)*1000])]));
        // The chat's own time (_chat.t) stands in if its last message has none.
        append(visibleChats.map(c=>historicalMessage(c.id,c.lastMessage,Number(c._chat?.t)*1000)));
        noticesLast.push(...visibleChats.filter(c=>isSystemRow(c.lastMessage)));
        if (chats.length < limit) break;
      }
      await lookBack(noticesLast);
    }
    load().catch(err=>{if (!controller.signal.aborted) setOverviewError(err.message);});
    return () => controller.abort();
  }, [retry,includeGroups]);
  useEffect(() => {
    setMessageError("");
    setMore(null);
    if (!chatId) return;
    const offset = request?.chatId === chatId ? request.offset : 0;
    const controller = new AbortController();
    page("/"+encodeURIComponent(chatId)+"/messages",offset,controller.signal).then(rows=>{
      const times = pageTimestamps(rows);
      append(rows.map((msg,index)=>historicalMessage(chatId,msg,times[index])));
      if (rows.length >= limit) setMore({chatId,offset:offset+limit});
    }).catch(err=>{if (!controller.signal.aborted) setMessageError(err.message);});
    return () => controller.abort();
  },[chatId,request,retry]);
  return {messages,directory,activity,error:overviewError || messageError,retry:()=>setRetry(n=>n+1),
    older:more?.chatId === chatId && more ? ()=>setRequest(more) : null};
}
