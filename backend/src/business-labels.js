import express from 'express';
import {setTimeout as delay} from 'node:timers/promises';
import {previewLabelWorkbook} from './label-import.js';

function contactId(value){
  if(typeof value!=='string')return null;
  const input=value.trim();
  if(/^\d{1,20}@(lid|c\.us|s\.whatsapp\.net)$/.test(input))return input.replace(/@s\.whatsapp\.net$/,'@c.us');
  const digits=input.replace(/[ ()-]/g,'').replace(/^\+/,'');
  return /^[1-9]\d{6,14}$/.test(digits)?digits+'@c.us':null;
}

// WAHA's labels API also returns WhatsApp's built-in chat filters (Unread,
// Favourites, Groups: types 1-3). Only these types are business labels.
export const isBusinessLabel=label=>label?.id!=null && label.isActive!==false && [0,4,5,16].includes(Number(label.type??0));

export function businessLabelRoutes(base,session,headers,adminAccess){
  const router=express.Router();
  const endpoint=base+'/api/'+encodeURIComponent(session)+'/labels';
  const pending=new Map();
  async function request(url=endpoint,method='GET',body){
    const response=await fetch(url,{
      method,headers:{...headers(),...(body?{'Content-Type':'application/json'}:{})},
      body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15000)
    });
    if(!response.ok){
      const detail=await response.json().catch(()=>null);
      const status=[400,404,409,422,429].includes(response.status)?response.status:502;
      // Name WAHA's status so an import's failures can be told apart.
      const message=typeof detail?.message==='string' && status!==502?detail.message.slice(0,220):'WAHA could not complete the label request (HTTP '+response.status+')';
      throw Object.assign(new Error(message),{status});
    }
    if(method==='PUT'){await response.body?.cancel();return;}
    return response.json();
  }
  function failure(res,error){
    res.status(error.status||502).json({error:error.status?error.message:'WAHA label service unavailable'});
  }
  router.post('/import-preview',express.raw({type:'application/octet-stream',limit:'10mb'}),async(req,res)=>{
    if(!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({error:'Upload an Excel .xlsx workbook.'});
    try{
      const country=typeof req.query.country==='string'?req.query.country:'';
      const preview=await previewLabelWorkbook(req.body,{country});
      res.set('Cache-Control','no-store').json(preview);
    }catch(error){failure(res,error);}
  });
  router.post('/',adminAccess,async(req,res)=>{
    const {name,color=0}=req.body||{};
    if(typeof name!=='string'||!name.trim()||!Number.isInteger(color)||color<0||color>19)
      return res.status(400).json({error:'Enter a campaign name and a color number from 0 to 19'});
    try{
      const label=await request(endpoint,'POST',{name:name.trim(),color});
      if(label?.id==null)throw new Error('Missing label ID');
      res.status(201).json({...label,id:String(label.id)});
    }catch(error){failure(res,error);}
  });
  router.post('/:id/contacts',async(req,res)=>{
    const id=req.params.id;
    let chatId=contactId(req.body?.contactId);
    if(!/^[A-Za-z0-9_-]+$/.test(id)||!chatId)return res.status(400).json({error:'Enter an international phone number or direct chat ID'});
    if(chatId.endsWith('@c.us')){
      try{
        const query=new URLSearchParams({phone:chatId.split('@')[0],session});
        const contact=await request(base+'/api/contacts/check-exists?'+query);
        if(contact?.numberExists===false)return res.status(422).json({error:'This number is not registered on WhatsApp'});
        const resolved=contactId(contact?.chatId);
        if(contact?.numberExists!==true||!resolved)throw new Error('Invalid WhatsApp contact lookup');
        chatId=resolved;
      }catch(error){return failure(res,error);}
    }
    // WAHA replaces the entire set. Serialize local additions to the same chat.
    const prior=pending.get(chatId)??Promise.resolve();
    const update=prior.catch(()=>{}).then(async()=>{
      const labels=await request();
      const target=labels.find(label=>String(label.id)===id);
      if(!target)throw Object.assign(new Error('Label no longer exists'),{status:404});
      if(!isBusinessLabel(target))
        throw Object.assign(new Error('Choose an active business label'),{status:422});
      const path=endpoint+'/chats/'+encodeURIComponent(chatId);
      const readIds=async()=>{
        const list=await request(path);
        if(!Array.isArray(list)||list.some(label=>label?.id==null))throw new Error('Invalid chat labels');
        return list.map(label=>String(label.id));
      };
      const ids=await readIds();
      if(ids.includes(id))return 'already_added';
      await request(path,'PUT',{labels:[...new Set([...ids,id])].map(id=>({id}))});
      for(const wait of [0,250,750]){
        if(wait)await delay(wait);
        if((await readIds()).includes(id))return 'added';
      }
      const members=await request(endpoint+'/'+encodeURIComponent(id)+'/chats');
      if(Array.isArray(members)&&members.some(chat=>{
        const jid=typeof chat==='string'?chat:chat?.id??chat?.jid??chat?.JID;
        const value=typeof jid==='string'?jid:jid?._serialized||(jid?.user && jid.server?jid.user+'@'+jid.server:null);
        return contactId(value)===chatId;
      }))return 'added';
      throw Object.assign(new Error('WhatsApp has not confirmed this chat under the label. Refresh its members and retry if it is missing.'),{status:409});
    });
    pending.set(chatId,update);
    try{res.json({labelId:id,chatId,status:await update});}
    catch(error){failure(res,error);}
    finally{if(pending.get(chatId)===update)pending.delete(chatId);}
  });
  return router;
}
