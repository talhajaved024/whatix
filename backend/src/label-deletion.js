import express from 'express';

function chatId(row){
  const jid=row?.id ?? row?.jid ?? row?.JID ?? row;
  const raw=typeof jid==='string'?jid:jid?._serialized || (jid?.user && jid.server && jid.user+'@'+jid.server);
  if(typeof raw!=='string' || !/^(?:\d+@(?:lid|c\.us|s\.whatsapp\.net)|\d+(?:-\d+)?@g\.us)$/.test(raw))
    throw new Error('WhatsApp returned an unrecognized chat. Review the label membership.');
  return raw.replace(/@s\.whatsapp\.net$/,'@c.us');
}

export function labelDeletionRoutes({base,session,headers,store,adminAccess,visible,personal=()=>({})}){
  const router=express.Router(),active=new Set(),adding=new Map();
  const root=base+'/api/'+encodeURIComponent(session);
  let writes=Promise.resolve();
  async function read(){
    const value=await store.get('state');
    return value?JSON.parse(value):{labels:{},chats:{}};
  }
  function record(section,key,value){
    const next=writes.then(async()=>{
      const state=await read();
      state[section]??={};
      state[section][key]=value;
      await store.put('state',JSON.stringify(state));
    });
    writes=next.catch(()=>{});
    return next;
  }
  async function upstream(path,method='GET'){
    const response=await fetch(root+path,{method,headers:headers(),redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok){
      await response.body?.cancel();
      throw new Error('WhatsApp could not '+(method==='DELETE'?'delete':'read')+' '+path.split('/')[1]+' (HTTP '+response.status+').');
    }
    if(method==='GET')return response.json();
    const text=await response.text();
    if(text.trim()){
      let result;
      try{result=JSON.parse(text);}catch{throw new Error('Unexpected deletion response from WhatsApp.');}
      if(result===false || result?.success===false)throw new Error('WhatsApp declined deletion.');
    }
  }
  async function members(path){
    const rows=await upstream(path+'/chats');
    if(!Array.isArray(rows))throw new Error('WhatsApp returned an invalid member list.');
    return [...new Set(rows.map(chatId))].sort();
  }
  router.post('/:id/contacts',(req,res,next)=>{
    const {id}=req.params;
    if(active.has(id))return res.status(409).json({error:'This label is being deleted.'});
    adding.set(id,(adding.get(id)||0)+1);
    const finish=()=>{
      const count=adding.get(id)-1;
      if(count)adding.set(id,count);else adding.delete(id);
      res.off('close',finish);
      res.off('finish',finish);
    };
    res.once('close',finish);res.once('finish',finish);next();
  });
  router.get('/history-changes',async(req,res)=>{
    try{
      const state=await read();
      res.json({labels:state.labels,chats:Object.fromEntries(Object.entries(state.chats).filter(([id])=>visible(req,id))),personalChats:await personal(req)});
    }catch{res.status(503).json({error:'Could not load history changes.'});}
  });
  router.get('/:id/deletion-preview',adminAccess,async(req,res)=>{
    if(!/^[\w-]+$/.test(req.params.id))return res.sendStatus(400);
    try{res.json({chats:await members('/labels/'+req.params.id)});}
    catch(err){res.status(502).json({error:err.message});}
  });
  router.delete('/:id',adminAccess,async(req,res)=>{
    const {id}=req.params,{scope,expectedChats}=req.body || {};
    if(!/^[\w-]+$/.test(id)||Object.hasOwn(Object.prototype,id)||!['label','history','chats'].includes(scope)||
        (scope==='chats'&&!Array.isArray(expectedChats)))return res.status(400).json({error:'Invalid label deletion request.'});
    if(active.has(id))return res.status(409).json({error:'Deletion is already in progress for this label.'});
    if(adding.has(id))return res.status(409).json({error:'Contacts are being added to this label. Retry when the additions finish.'});
    active.add(id);
    const path='/labels/'+id;
    let deleted=0;
    try{
      const labels=await upstream('/labels');
      if(!labels.some(label=>String(label.id)===id)){
        const state=await read();
        const prior=state.pending?.[id] || state.labels[id];
        if(prior?.scope!==scope)return res.status(404).json({error:'Label no longer exists.'});
        await record('labels',id,prior);
        return res.json({deleted});
      }
      if(scope==='chats'){
        const targets=await members(path);
        if(JSON.stringify(targets)!==JSON.stringify([...expectedChats].sort()))
          return res.status(409).json({error:'Label membership changed. Review the updated chat count and confirm again.'});
        for(const chat of targets){
          await upstream('/chats/'+encodeURIComponent(chat),'DELETE');
          deleted++;
          await record('chats',chat,Date.now());
        }
        const remaining=await members(path);
        const confirmed=new Set(targets);
        if(remaining.some(chat=>!confirmed.has(chat)))throw new Error('New chats joined this label. Review the updated membership.');
      }
      const change={scope,at:Date.now()};
      await record('pending',id,change);
      await upstream(path,'DELETE');
      await record('labels',id,change);
      res.json({deleted});
    }catch(err){res.status(502).json({error:(deleted?deleted+' chat(s) deleted. ':'')+err.message});}
    finally{active.delete(id);}
  });
  return router;
}
