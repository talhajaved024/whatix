import { mergeAck } from "./receipts.js";
import { onInboxChange } from "./inbox.js";

let database,accountKey;
// Another inbox has another history: close this one; the next account binds afresh.
onInboxChange(() => {
  const open = database;
  database = undefined; accountKey = undefined;
  open?.then(db => db.close()).catch(() => {});
});
export function bindHistory(account){
  if(!/^[0-9a-f]{64}$/.test(account))return false;
  if(accountKey && accountKey!==account)return false;
  accountKey=account;
  return true;
}
function open() {
  if (!accountKey) throw Error('Select a connected WhatsApp account first');
  if (!database) database = new Promise((resolve,reject) => {
    const request = indexedDB.open("dispatch-account-history-" + accountKey, 3);
    request.onupgradeneeded = () => {
      for (const name of ["messages","receipts","seen","contacts","viewed","reactions"])
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
  return database;
}

export async function save(store, key, value) {
  const db = await open();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(store,"readwrite");
    const records = tx.objectStore(store);
    if (store === "receipts") {
      const read = records.get(key);
      read.onsuccess = () => records.put(mergeAck(read.result,value), key);
    } else if (store === "reactions") {
      const read = records.get(key);
      read.onsuccess = () => { if (!read.result || read.result.at <= value.at) records.put(value,key); };
    } else if (store === "messages" && value.job) {
      // A slower poll from a second tab can finish after a newer snapshot was saved.
      const read = records.get(key);
      read.onsuccess = () => {
        const previous = read.result?.job;
        if (previous && (previous.processed > value.job.processed ||
            ["completed","completed_with_errors","rejected"].includes(previous.status))) return;
        records.put(value,key);
      };
    } else records.put(value,key);
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
}

// How long this browser keeps its own copy of the history. Everything is read
// into memory at startup, so without a limit startup slows down as months of
// history pile up. Older messages are still in WhatsApp (WAHA) and appear when
// a chat is opened; what goes is only the local extras (broadcast grouping,
// delivery ticks, read markers, reactions) of items older than this.
export const HISTORY_DAYS = 90;
const DAY_MS = 86400000;
const finishedJob = status => ["completed","completed_with_errors","rejected"].includes(status);

// Reads the saved history and, in the same pass, drops items older than
// HISTORY_DAYS together with their receipts, read markers and reactions.
// Kept whatever their age: broadcasts still running, items without a time,
// and the contacts mapping (linked IDs to phones).
export async function loadHistory(now = Date.now()) {
  const db = await open();
  const cutoff = now - HISTORY_DAYS * DAY_MS;
  const stores = ["messages","receipts","seen","contacts","viewed","reactions"];
  const tx = db.transaction(stores,"readwrite");
  const done = new Promise((resolve,reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  const maps = Object.fromEntries(stores.map(name => [name,new Map()]));
  const dropped = new Set();   // message keys, their WAHA IDs and receipt IDs
  const expired = item => Number.isFinite(item?.timestamp) && item.timestamp < cutoff && !(item.job && !finishedJob(item.job.status));
  const reactionTime = value => { const at = Number(value?.at); return at > 0 && at < 1e12 ? at * 1000 : at; };
  const keep = {
    messages: (key,value) => {
      if (!expired(value)) return true;
      dropped.add(String(key)); dropped.add(String(key).replace(/^(?:incoming|remote):/,""));
      for (const result of value.results || []) if (result?.id) dropped.add(String(result.id));
      return false;
    },
    receipts: key => !dropped.has(String(key)),
    seen: key => !dropped.has(String(key)),
    viewed: key => !dropped.has(String(key)),
    contacts: () => true,
    reactions: (key,value) => !dropped.has(String(key).split("|")[0]) && !(reactionTime(value) < cutoff)
  };
  // Messages first, so the other stores know which IDs went with them.
  function scan(name,next) {
    const request = tx.objectStore(name).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return next?.();
      if (keep[name](cursor.key,cursor.value)) maps[name].set(cursor.key,cursor.value);
      else cursor.delete();
      cursor.continue();
    };
  }
  scan("messages",() => { for (const name of stores.slice(1)) scan(name); });
  await done;
  const time = item => Number.isFinite(item.timestamp) ? item.timestamp : 0;
  return {messages:[...maps.messages.values()].sort((a,b)=>time(a)-time(b)),
    reactions:maps.reactions,receipts:maps.receipts,seen:maps.seen,contacts:maps.contacts,viewed:new Set([...maps.seen.keys(),...maps.viewed.keys()])};
}

export async function saveViewed(ids) {
  const db = await open();
  return new Promise((resolve,reject) => {
    const tx = db.transaction("viewed","readwrite");
    for (const id of ids) tx.objectStore("viewed").put(true,id);
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
}

export function chatDeletionTimes(changes,contacts){
  const times=new Map();
  const normalized=id=>id.replace(/@(c\.us|s\.whatsapp\.net)$/,"");
  for(const [raw,at] of Object.entries(changes?.chats || {})){
    const key=contacts.get(raw) || normalized(raw);
    times.set(key,Math.max(times.get(key)||0,at));
  }
  return times;
}

export function applyHistoryChange(item,changes,chatTimes,contacts){
  const label=changes?.labels?.[item.labelId];
  if(label && item.timestamp<=label.at && label.scope!=="label")return null;
  const raw=item.sender || item.chatId || (item.recipients?.length===1 && item.recipients[0]);
  if(raw){
    const key=contacts.get(raw) || String(raw).replace(/@(c\.us|s\.whatsapp\.net)$/,"");
    if(item.timestamp<=chatTimes.get(key))return null;
  }
  if(label && item.timestamp<=label.at)return {...item,labelId:undefined,formerLabel:true};
  return item;
}

export async function cleanSavedHistory(changes,times,contacts){
  const db=await open();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("messages","readwrite");
    const req=tx.objectStore("messages").openCursor();
    req.onsuccess=()=>{
      const cursor=req.result;
      if(!cursor)return;
      const row=cursor.value,next=applyHistoryChange(row,changes,times,contacts);
      if(!next)cursor.delete();
      else if(next!==row)cursor.update(next);
      cursor.continue();
    };
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });
}
