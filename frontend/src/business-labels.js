import {memberId,phoneId} from "./group-members.js";
import { authorizedFetch } from "./auth.js";
import { SESSION } from "./sender.js";
import { resolveLid } from "./contacts-directory.js";

// WAHA label color indices, in API order.
export const labelPalette=['#ff9485','#64c4ff','#ffd429','#dfaef0','#99b6c1','#55ccb3','#ff9dff','#d3a91d','#6d7cce','#d7e752',
  '#00d0e2','#ffc5c7','#93ceac','#f74848','#00a0f2','#83e422','#ffaf04','#b5ebff','#9ba6ff','#9368cf'];

export function labelColor(label){
  return /^#[0-9a-f]{6}$/i.test(label.colorHex) ? label.colorHex : labelPalette[label.color] || labelPalette[0];
}

// Read at call time: the open inbox can change without a page reload.
const base = () => "/api/" + encodeURIComponent(SESSION) + "/labels";

async function write(path,body,status,signal){
  const response=await authorizedFetch('/api/business-labels'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  const result=await response.json().catch(()=>null);
  if(response.status!==status)throw new Error(result?.error||'Label request failed (HTTP '+response.status+').');
  return result;
}
export async function createLabel(name,color,signal){
  const label=await write('',{name,color},201,signal);
  if(label?.id==null)throw new Error('The server did not return the new label ID.');
  return {...label,id:String(label.id),name:label.name||name};
}
// Every Project Type in the workbook, each with its numbers. Nothing is written.
export async function previewLabelWorkbook(file,country,signal){
  if(!/\.xlsx$/i.test(file.name))throw new Error('Choose an Excel .xlsx workbook.');
  if(file.size>10*1024*1024)throw new Error('Choose a workbook of 10 MB or less.');
  const response=await authorizedFetch('/api/business-labels/import-preview?'+new URLSearchParams({country:country||''}),{
    method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file,signal
  });
  const result=await response.json().catch(()=>null);
  if(!response.ok || !Array.isArray(result?.projects))throw new Error(result?.error||'Could not preview this workbook.');
  return result;
}

export async function addLabelContact(id,contactId,signal){
  const result=await write('/'+encodeURIComponent(id)+'/contacts',{contactId},200,signal);
  if(!['added','already_added'].includes(result?.status))throw new Error('The server did not confirm the addition.');
  return result.status;
}

async function read(path, signal, withHeaders = false) {
  const response = await authorizedFetch(base() + path, { cache: "no-store", signal });
  if (!response.ok) throw new Error("WhatsApp label lookup failed (HTTP " + response.status + ").");
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("WAHA returned an unexpected label response.");
  return withHeaders ? {rows, headers: response.headers} : rows;
}

// WAHA's labels API also returns WhatsApp's built-in chat filters (Unread,
// Favourites, Groups: types 1-3); only these types are business labels.
export const isBusinessLabel = row => row?.id != null && !!row.name && row.isActive !== false &&
  [0, 4, 5, 16].includes(Number(row.type ?? 0));

export async function businessLabels(signal) {
  const rows = await read("", signal);
  return rows.filter(isBusinessLabel)
    .map(row => ({ id: String(row.id), name: row.name, colorHex:labelColor(row) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Linked IDs (@lid) resolved to phone numbers; a mapping never changes.
const lidPhones = new Map();
async function phoneForLid(lid, signal) {
  if (lidPhones.has(lid)) return lidPhones.get(lid);
  const phone = await resolveLid(lid.split("@")[0], signal);
  if (phone) lidPhones.set(lid, phone);
  return phone;
}

// Everyone carrying a label, as phone digits where known (else the @lid ID).
// A customer can be in a label both by phone and by linked ID; resolving the
// linked IDs makes them one recipient, so a bulk send reaches them once and
// matches the phone-keyed chat list.
export async function labelRecipients(id, signal) {
  return (await labelAudience(id, signal)).members;
}

// The label's members as above, plus `total`: how many direct chats carry the
// label. For a regular user the server lists only their own customers and
// reports the total as a count, so an empty label can be explained.
export async function labelAudience(id, signal) {
  const {rows: chats, headers} = await read("/" + encodeURIComponent(id) + "/chats", signal, true);
  const members = await labelMembers(chats, signal);
  const header = headers.get("X-Label-Chats"), counted = header === null ? NaN : Number(header);
  return {members, total: Number.isSafeInteger(counted) && counted >= 0 ? counted : null};
}

async function labelMembers(chats, signal) {
  const members = new Set(), lids = [];
  for (const chat of chats) {
    const value = typeof chat === "string" ? chat : chat?.id ?? chat?.jid ?? chat?.JID;
    const jid = typeof value === "string" ? value : value?._serialized ??
      (value?.user && value.server ? value.user + "@" + value.server : "");
    if (!jid) throw new Error("WAHA returned a chat without a recognizable ID.");
    if (/^\d+@lid$/.test(jid)) lids.push(jid);
    else if (/^\d+@(?:c\.us|s\.whatsapp\.net)$/.test(jid)) members.add(jid.replace(/@(?:c\.us|s\.whatsapp\.net)$/, ""));
  }
  // A few lookups at a time keeps WAHA responsive for large labels.
  for (let i = 0; i < lids.length; i += 6) {
    const batch = lids.slice(i, i + 6);
    const phones = await Promise.all(batch.map(lid => phoneForLid(lid, signal)));
    batch.forEach((lid, index) => members.add(phones[index] || lid));
  }
  return [...members].sort();
}

export const labelContactKey=id=>phoneId(id) || memberId(id);

export function contactLabelIndex(labels,members,aliases,contacts){
  const byId=new Map();
  function add(id,label){
    if(!id)return;
    const entry=byId.get(id) || new Map();
    entry.set(label.id,label);byId.set(id,entry);
  }
  for(const label of labels || []){
    for(const id of members.get(label.id) || []){
      add(labelContactKey(id),label);
      add(labelContactKey(contacts.get(id) || aliases.get(id)),label);
    }
  }
  for(const [lid,number] of new Map([...aliases,...contacts])){
    for(const label of byId.get(labelContactKey(number))?.values() || [])add(labelContactKey(lid),label);
  }
  return byId;
}
