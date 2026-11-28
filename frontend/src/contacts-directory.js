import {authorizedFetch} from "./auth.js";
import {SESSION} from "./sender.js";
import {campaignApi} from "./inbox.js";
import {isSystemRow} from "./waha-history.js";
// Every direct WhatsApp chat of the session as {phone, name}, phone as plain digits.
// LID-only chats are resolved through WAHA's /lids lookup; ones without a known phone are counted, not listed.
// Another campaign's directory is addressed explicitly; the open inbox uses relative paths.
const baseFor=session=>!session||session===SESSION?"/api/"+encodeURIComponent(SESSION):campaignApi(session,"/api/"+encodeURIComponent(session));
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
// One request (the server's chat-list.js) returns the chats, the newest rows of
// every chat whose latest row is a system notice, and the phone behind each
// linked ID. A list built in the last few minutes is accepted (stale=1): who
// the contacts are changes slowly.
// A chat whose newest row is a system notice ("messages are end-to-end encrypted",
// templates) may hold no conversation at all: WhatsApp Web keeps such notice-only
// chats, for example ones opened by a lookup, but the phone does not list them.
// Same rule as the chat list (waha-history.js): it is kept only if one of its
// latest rows is a real message. One the server could not read is kept.
export async function loadDirectContacts(signal,session){
 // Always addressed by name, so the answer is that campaign's own list whichever inbox is open.
 const response=await authorizedFetch(campaignApi(session||SESSION,"/api/chat-list?stale=1&phones=1"),{signal,cache:"no-store"});
 const body=await response.json().catch(()=>null);
 if(!response.ok)throw new Error(typeof body?.error==="string"?body.error:"The WhatsApp contact list could not be loaded (HTTP "+response.status+").");
 if(!Array.isArray(body?.chats))throw new Error("WAHA returned an invalid chat list.");
 const found=new Map();
 let empty=0,unresolved=0;
 const keep=(phone,name)=>{if(!found.has(phone)||name&&!found.get(phone).name)found.set(phone,{phone,name});};
 const linked=[];
 for(const chat of body.chats){
  const id=idOf(chat),phone=phoneId.exec(id)?.[1],lid=lidId.exec(id)?.[1];
  if(!phone&&!lid)continue;
  const rows=isSystemRow(chat.lastMessage)?body.recent?.[id]:null;
  if(Array.isArray(rows)&&rows.every(isSystemRow)){empty++;continue;}
  const name=typeof chat.name==="string"?chat.name.trim():"";
  if(phone)keep(phone,name);
  else linked.push({lid,name});
 }
 // After the phone-keyed chats, so a customer known both ways is listed once.
 for(const {lid,name} of linked){
  const phone=body.phones?.[lid];
  if(phone)keep(phone,name);
  else unresolved++;
 }
 const contacts=[...found.values()].filter(c=>/^[1-9]\d{0,14}$/.test(c.phone));
 contacts.sort((a,b)=>(!a.name-!b.name)||(a.name||a.phone).localeCompare(b.name||b.phone));
 return {contacts,unresolved,empty};
}
