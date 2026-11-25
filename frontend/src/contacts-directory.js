import {authorizedFetch} from "./auth.js";
import {SESSION} from "./sender.js";
// Every direct WhatsApp chat of the session as {phone, name}, phone as plain digits.
// LID-only chats are resolved through WAHA's /lids lookup; ones without a known phone are counted, not listed.
const base="/api/"+SESSION;
const limit=50;
const phoneId=/^(\d+)@(?:c\.us|s\.whatsapp\.net)$/,lidId=/^(\d+)@lid$/;
const idOf=chat=>typeof chat?.id==="string"?chat.id:chat?.id?._serialized||"";
async function read(path,signal){
 const response=await authorizedFetch(base+path,{signal,cache:"no-store"});
 if(!response.ok){
  const body=await response.json().catch(()=>null);
  throw new Error(typeof body?.error==="string"?body.error:"The WhatsApp contact list could not be loaded (HTTP "+response.status+").");
 }
 return response.json();
}
export async function resolveLid(lid,signal){
 try{const {pn}=await read("/lids/"+encodeURIComponent(lid),signal);return phoneId.exec(pn||"")?.[1]||null;}
 catch(err){if(signal?.aborted)throw err;return null;}
}
export async function loadDirectContacts(signal){
 const found=new Map(),lids=[];
 for(let offset=0;;offset+=limit){
  const page=await read("/chats/overview?limit="+limit+"&offset="+offset,signal);
  if(!Array.isArray(page))throw new Error("WAHA returned an invalid chat list.");
  for(const chat of page){
   const id=idOf(chat),name=typeof chat.name==="string"?chat.name.trim():"";
   const phone=phoneId.exec(id)?.[1];
   if(phone){if(!found.has(phone)||name&&!found.get(phone).name)found.set(phone,{phone,name});}
   else{const lid=lidId.exec(id)?.[1];if(lid)lids.push({lid,name});}
  }
  if(page.length<limit)break;
 }
 let unresolved=0;
 // A few lookups at a time keeps WAHA responsive on large accounts.
 for(let i=0;i<lids.length;i+=6){
  const batch=lids.slice(i,i+6);
  const phones=await Promise.all(batch.map(item=>resolveLid(item.lid,signal)));
  batch.forEach((item,index)=>{
   const phone=phones[index];
   if(!phone){unresolved++;return;}
   if(!found.has(phone)||item.name&&!found.get(phone).name)found.set(phone,{phone,name:item.name});
  });
 }
 const contacts=[...found.values()].filter(c=>/^[1-9]\d{0,14}$/.test(c.phone));
 contacts.sort((a,b)=>(!a.name-!b.name)||(a.name||a.phone).localeCompare(b.name||b.phone));
 return {contacts,unresolved};
}
