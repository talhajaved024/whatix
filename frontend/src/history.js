import { SESSION } from "./sender.js";
import { mergeAck } from "./receipts.js";

let database;
function open() {
  if (!database) database = new Promise((resolve,reject) => {
    const request = indexedDB.open("dispatch-history-" + SESSION, 3);
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

export async function loadHistory() {
  const db = await open();
  const stores = ["messages","receipts","seen","contacts","viewed","reactions"];
  const tx = db.transaction(stores);
  const maps = await Promise.all(stores.map(name => new Promise((resolve,reject) => {
    const map = new Map();
    const request = tx.objectStore(name).openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(map);
      map.set(cursor.key,cursor.value);
      cursor.continue();
    };
  })));
  const time = item => Number.isFinite(item.timestamp) ? item.timestamp : 0;
  return {messages:[...maps[0].values()].sort((a,b)=>time(a)-time(b)),
    reactions:maps[5],receipts:maps[1],seen:maps[2],contacts:maps[3],viewed:new Set([...maps[2].keys(),...maps[4].keys()])};
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
