import {authorizedFetch} from "./auth.js";
import {SESSION} from "./sender.js";
import {campaignApi} from "./inbox.js";
import {isSystemRow} from "./waha-history.js";
// Every direct WhatsApp chat of the session as {phone, name}, phone as plain digits.
// LID-only chats are resolved through WAHA's /lids lookup; ones without a known phone are counted, not listed.
// Another campaign's directory is addressed explicitly; the open inbox uses relative paths.
const baseFor=session=>!session||session===SESSION?"/api/"+encodeURIComponent(SESSION):campaignApi(session,"/api/"+encodeURIComponent(session));
const limit=50;
const phoneId=/^(\d+)@(?:c\.us|s\.whatsapp\.net)$/,lidId=/^(\d+)@lid$/;
const idOf=chat=>typeof chat?.id==="string"?chat.id:chat?.id?._serialized||"";
async function read(path,signal,session){
 const response=await authorizedFetch(baseFor(session)+path,{signal,cache:"no-store"});
 if(!response.ok){
  const body=await response.json().catch(()=>null);
  throw new Error(typeof body?.error==="string"?body.error:"The WhatsApp contact list could not be loaded (HTTP "+response.status+").");
 }
 return response.json();
}
export async function resolveLid(lid,signal,session){
 try{const {pn}=await read("/lids/"+encodeURIComponent(lid),signal,session);return phoneId.exec(pn||"")?.[1]||null;}
 catch(err){if(signal?.aborted)throw err;return null;}
}
// A chat whose newest row is a system notice ("messages are end-to-end encrypted",
// templates) may hold no conversation at all: WhatsApp Web keeps such notice-only
// chats, for example ones opened by a lookup, but the phone does not list them.
// Same rule as the chat list (waha-history.js lookBack): look at its latest rows
// and keep it only if one is a real message. A failed lookup keeps the chat.
async function hasConversation(id,signal,session){
 try{
  const rows=await read("/chats/"+encodeURIComponent(id)+"/messages?limit=10&offset=0&downloadMedia=false",signal,session);
  return !Array.isArray(rows)||rows.some(row=>!isSystemRow(row));
 }catch(err){if(signal?.aborted)throw err;return true;}
}
export async function loadDirectContacts(signal,session){
 const found=new Map(),lids=[],chats=[],noticeOnly=[];
 for(let offset=0;;offset+=limit){
  const page=await read("/chats/overview?limit="+limit+"&offset="+offset,signal,session);
  if(!Array.isArray(page))throw new Error("WAHA returned an invalid chat list.");
  for(const chat of page){
   const id=idOf(chat);
   if(!phoneId.test(id)&&!lidId.test(id))continue;
   (isSystemRow(chat.lastMessage)?noticeOnly:chats).push({id,name:typeof chat.name==="string"?chat.name.trim():""});
  }
  if(page.length<limit)break;
 }
 // Only this number's own chats are read (never another session's IDs, which would create empty chats there).
 let empty=0;
 for(let i=0;i<noticeOnly.length;i+=6){
  const batch=noticeOnly.slice(i,i+6);
  const kept=await Promise.all(batch.map(chat=>hasConversation(chat.id,signal,session)));
  batch.forEach((chat,index)=>kept[index]?chats.push(chat):empty++);
 }
 for(const {id,name} of chats){
  const phone=phoneId.exec(id)?.[1];
  if(phone){if(!found.has(phone)||name&&!found.get(phone).name)found.set(phone,{phone,name});}
  else lids.push({lid:lidId.exec(id)[1],name});
 }
 let unresolved=0;
 // A few lookups at a time keeps WAHA responsive on large accounts.
 for(let i=0;i<lids.length;i+=6){
  const batch=lids.slice(i,i+6);
  const phones=await Promise.all(batch.map(item=>resolveLid(item.lid,signal,session)));
  batch.forEach((item,index)=>{
   const phone=phones[index];
   if(!phone){unresolved++;return;}
   if(!found.has(phone)||item.name&&!found.get(phone).name)found.set(phone,{phone,name:item.name});
  });
 }
 const contacts=[...found.values()].filter(c=>/^[1-9]\d{0,14}$/.test(c.phone));
 contacts.sort((a,b)=>(!a.name-!b.name)||(a.name||a.phone).localeCompare(b.name||b.phone));
 return {contacts,unresolved,empty};
}
