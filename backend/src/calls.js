const ringWindowMs=60_000;
export const callEvents=['call.received','call.accepted','call.rejected'];

function phoneNumber(jid){
  const digits=typeof jid==='string' && /^(\d{1,15})@(?:c\.us|s\.whatsapp\.net)$/.exec(jid);
  return digits ? '+'+digits[1] : null;
}

export function createCalls(waha,session,headers){
  const base=waha+'/api/'+encodeURIComponent(session);
  const calls=new Map();
  const listeners=new Set();

  function publish(name,data){
    for(const listener of listeners)listener(name,data);
  }

  // Every browser has its own upstream socket. Retain ended IDs briefly so
  // a delayed duplicate from another socket cannot reopen a dismissed call.
  function end(id){
    const previous=calls.get(id);
    if(previous?.ended)return;
    clearTimeout(previous?.timer);
    calls.set(id,{ended:true,timer:setTimeout(()=>calls.delete(id),ringWindowMs).unref()});
    publish('call.ended',{id});
  }

  async function resolveNumber(call,digits){
    try{
      const response=await fetch(base+'/lids/'+digits,{headers:headers(),redirect:'error',signal:AbortSignal.timeout(3000)});
      if(!response.ok){await response.body?.cancel();return;}
      const number=phoneNumber((await response.json()).pn);
      if(number && calls.get(call.data.id)===call){
        call.data.phoneNumber=number;
        publish('call.received',call.data);
      }
    }catch{ /* The banner and decline action work without a mapped number. */ }
  }

  function observe(event){
    if(event?.session!==session || !callEvents.includes(event.event))return;
    const {id,from,isVideo,isGroup}=event.payload || {};
    if(typeof id!=='string' || !id.length || id.length>512)return;
    // WEBJS generates this event locally after sending the reject signal.
    if(event.event==='call.rejected' && event.payload?._data?.api===true)return;
    if(event.event!=='call.received'){end(id);return;}
    if(calls.has(id) || typeof from!=='string' || !from.length || from.length>256)return;
    const data={id,phoneNumber:phoneNumber(from),isVideo:isVideo===true,isGroup:isGroup===true};
    const call={data,from,timer:setTimeout(()=>end(id),ringWindowMs).unref()};
    calls.set(id,call);
    publish('call.received',data);
    const lid=/^(\d+)@lid$/.exec(from);
    if(lid)void resolveNumber(call,lid[1]);
  }

  async function reject(call){
    const {id}=call.data;
    try{
      const response=await fetch(base+'/calls/reject',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({id,from:call.from})});
      await response.body?.cancel();
      if(response.ok)return calls.get(id)===call ? 202 : 204;
    }catch{ /* Report upstream failures to the client for retry. */ }
    return 502;
  }

  return {observe,subscribe(listener){
    listeners.add(listener);
    for(const call of calls.values())if(!call.ended)listener('call.received',call.data);
    return ()=>listeners.delete(listener);
  },async decline(req,res){
    const id=req.body?.id;
    if(typeof id!=='string' || !id.length || id.length>512)return res.status(400).json({error:'Invalid call ID'});
    const call=calls.get(id);
    if(!call || call.ended)return res.status(409).json({error:'Call is no longer available'});
    const pending=call.pending??=reject(call);
    const status=await pending;
    if(call.pending===pending)delete call.pending;
    if(status===202)return res.status(202).json({status:'requested'});
    if(status===204)return res.status(204).end();
    res.status(status).json({error:'WAHA could not confirm the decline'});
  }};
}
