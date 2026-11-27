import {createHmac} from 'node:crypto';
import {senderPhone} from './offline-requirements.js';
import {isBusinessLabel} from './business-labels.js';

const participant=id=>typeof id==='string' && /^(?:true|false)_(\d+@(?:c\.us|lid|s\.whatsapp\.net))_/.exec(id)?.[1];
const chatId=row=>{
  const id=typeof row==='string'?row:row?.id??row?.jid??row?.JID;
  return typeof id==='string'?id:id?._serialized;
};
const LID_CACHE=5000,LID_MISS_MS=60000;
// phones: the shared sessionPhones() cache. Regular users' requests and live
// events check access constantly, so grants are cached per user until the
// store reports a write, and linked IDs (@lid) are resolved once.
// How old a phone answer the availability probe accepts (it polls every 5 s).
export const AVAILABILITY_MAX_AGE_MS=5000;
export function campaignAccess({session,base,headers,store,requirements,primary,secret,sent,phones}){
  const root='/'+encodeURIComponent(session);
  async function json(path){
    const response=await fetch(base+'/api'+path,{headers:headers(),redirect:'error',signal:AbortSignal.timeout(6000)});
    if(!response.ok){await response.body?.cancel();throw Object.assign(Error('WhatsApp data unavailable'),{status:response.status===404?404:502});}
    return response.json();
  }
  const identity=(options)=>phones.phone(session,options);
  const grants=new Map(); // userId -> {version, phone, grant}
  async function load(userId,options){
    const phone=await identity(options);
    if(!phone)return null;
    const version=store.version();
    let hit=grants.get(userId);
    if(!hit || hit.version!==version || hit.phone!==phone){
      hit={version,phone,grant:await store.get(session,phone,userId)};
      if(store.version()===version)grants.set(userId,hit);
    }
    const {grant}=hit;
    if(!grant)return null;
    const numbers=new Set(grant.contacts.map(c=>String(c.phoneNumber)));
    for(const n of await requirements.numbersFor(userId,session,primary))numbers.add(String(n));
    return {phone,labels:grant.labels,numbers,userId};
  }
  // A linked ID's phone never changes; unknown ones are retried after a minute.
  const lids=new Map();
  async function lidPhone(id){
    const hit=lids.get(id);
    if(hit && (hit.phone || Date.now()-hit.at<LID_MISS_MS))return hit.phone;
    const phone=await senderPhone(id,base,session,headers);
    lids.delete(id);
    if(lids.size>=LID_CACHE)lids.delete(lids.keys().next().value);
    lids.set(id,{phone:phone?String(phone):null,at:Date.now()});
    return phone?String(phone):null;
  }
  async function allowed(access,id){
    if(!access || !id)return false;
    const digits=typeof id==='string' && /^\+?(\d+)(?:@(?:c\.us|s\.whatsapp\.net))?$/.exec(id)?.[1];
    if(digits)return access.numbers.has(digits);
    if(!/^\d+@lid$/.test(id))return false;
    const phone=await lidPhone(id);
    return !!phone && access.numbers.has(phone);
  }
  function signature(access,path,chat){
    return createHmac('sha256',secret).update(JSON.stringify([session,access.phone,access.userId,path,chat])).digest('hex');
  }
  function media(access,url,chat){
    if(!url || typeof url!=='string')return;
    const path=new URL(url,'http://localhost').pathname;
    if(path.startsWith('/api/files/'))return path+'?'+new URLSearchParams({chat,proof:signature(access,path,chat)});
  }
  function markMedia(access,msg,chat){
    if(msg?.media?.url)msg.media.url=media(access,msg.media.url,chat);
    return msg;
  }
  // A user sees every business label on their number unless an admin limited them.
  const labelAllowed=(access,id)=>access.labels===null || access.labels.includes(String(id));
  async function gate(req,res,next){
    try{
      // The browser's 5 s availability probe accepts a phone answer at most 5 s old, shared by
      // every tab, so a re-paired number is still noticed within seconds (audit PERF-04).
      const access=await load(req.userId,req.method==='GET' && req.path==='/inbox-availability'?{maxAgeMs:AVAILABILITY_MAX_AGE_MS}:undefined);
      if(!access)return res.status(403).json({error:'This campaign is not assigned to you'});
      req.campaign=access;
      const path=req.path,method=req.method;
      const get=method==='GET',post=method==='POST';
      const check=async id=>(await allowed(access,id))?next():res.sendStatus(403);
      if(get && ['/inbox-availability','/campaign-contacts','/incoming-text','/business-labels/history-changes'].includes(path))return next();
      if(get && path===root+'/labels'){
        const rows=await json(root+'/labels');
        return res.json(rows.filter(l=>isBusinessLabel(l) && labelAllowed(access,l.id)));
      }
      if(get && path.startsWith(root+'/labels/')){
        const m=/^\/labels\/([\w-]+)\/chats$/.exec(path.slice(root.length));
        if(!m || !labelAllowed(access,m[1]))return res.sendStatus(403);
        const rows=await json(path),result=[];
        for(const row of rows)if(await allowed(access,chatId(row)))result.push(row);
        // How many direct chats carry the label (a count only, never who), so the
        // user can be told that chats exist but are not assigned to them.
        const direct=rows.filter(row=>/^\d+@(?:c\.us|lid|s\.whatsapp\.net)$/.test(chatId(row)??'')).length;
        res.set('X-Label-Chats',String(direct));
        return res.json(result);
      }
      if(get && path===root+'/chats/overview'){
        // Fetch only assigned conversations when opened. Returning the scoped
        // directory also keeps an unassigned last-message preview off the wire.
        const offset=Math.max(0,Number(req.query.offset)||0),limit=Math.min(100,Math.max(1,Number(req.query.limit)||50));
        return res.json([...access.numbers].slice(offset,offset+limit).map(n=>({id:n+'@c.us'})));
      }
      if(get && path.startsWith(root+'/chats/')){
        const match=/^\/chats\/(\d+@(?:c\.us|lid|s\.whatsapp\.net))\/messages(?:\/([\w@.:-]+))?$/.exec(decodeURIComponent(path.slice(root.length)));
        if(!match || !(await allowed(access,match[1])))return res.sendStatus(403);
        const query=new URLSearchParams();
        for(const field of ['limit','offset','downloadMedia'])if(typeof req.query[field]==='string')query.set(field,req.query[field]);
        const result=await json(path+'?'+query);
        return res.json(Array.isArray(result)?result.map(m=>markMedia(access,m,match[1])):markMedia(access,result,match[1]));
      }
      if(get && path.startsWith(root+'/lids/'))return check(path.slice((root+'/lids/').length)+'@lid');
      if(get && ['/contacts/name','/contacts/profile-picture'].includes(path))return check(req.query.contactId);
      if((get||method==='HEAD') && path.startsWith('/files/')){
        if(req.query.proof!==signature(access,'/api'+path,req.query.chat))return res.sendStatus(403);
        return check(req.query.chat);
      }
      if(post && /^\/(sendText|sendVoice|sendVideo|sendImage|sendFile|sendSeen|chats\/attended)$/.test(path))return check(req.body?.chatId);
      if(method==='PUT' && path==='/reaction')return check(participant(req.body?.messageId));
      if(post && path==='/messages/deletion-state')return next();
      // A user may file one of their own chats under a label assigned to them.
      const labelled=post && /^\/business-labels\/([\w-]+)\/contacts$/.exec(path);
      if(labelled){
        if(!labelAllowed(access,labelled[1]))return res.sendStatus(403);
        const contact=typeof req.body?.contactId==='string'?req.body.contactId.replace(/[\s()-]/g,''):'';
        return check(contact);
      }
      if(method==='DELETE' && path.startsWith('/messages/'))return check(await sent.chatFor(decodeURIComponent(path.slice(10)),req.userId));
      if(post && path==='/broadcasts' && Array.isArray(req.body?.recipients)){
        for(const id of req.body.recipients)if(!await allowed(access,id))return res.sendStatus(403);
        return next();
      }
      if(get && /^\/broadcasts\/[\w-]+$/.test(path))return next();
      return res.sendStatus(403);
    }catch(error){return res.status(error.status||503).json({error:'Campaign access unavailable'});}
  }
  return {identity,load,allowed,media,gate,readLabels:()=>json(root+'/labels')};
}
