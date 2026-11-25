import {createHash} from 'node:crypto';

export function validMessageId(id){
  return typeof id==='string' && /^[A-Za-z0-9_@.:-]{1,512}$/.test(id) && id!=='.' && id!=='..';
}

export function sentMessages(store,session){
  const pending=new Map();
  const key=id=>createHash('sha256').update(JSON.stringify([session,id])).digest('hex');
  const read=async id=>JSON.parse(await store.get(key(id)) ?? 'null');
  const save=(id,entry)=>store.put(key(id),JSON.stringify(entry));
  function change(id,fn){
    const previous=pending.get(id)??Promise.resolve();
    const next=previous.catch(()=>{}).then(fn);
    pending.set(id,next);
    return next.finally(()=>{if(pending.get(id)===next)pending.delete(id);});
  }
  function state(entry,userId){
    const mine=!!entry && entry.userId===userId;
    return {mine,hidden:mine && entry.hidden,revocationRequested:entry?.revocationRequested??false};
  }
  return {
    record(id,chatId,userId){
      return change(id,async()=>{
        if(!await read(id))await save(id,{userId,chatId,hidden:false,revocationRequested:false});
      });
    },
    async states(ids,userId){
      return Promise.all(ids.map(async id=>({id,...state(await read(id),userId)})));
    },
    remove(id,userId,scope,revoke){
      return change(id,async()=>{
        const entry=await read(id);
        if(!entry || entry.userId!==userId)return {status:404,error:'No matching sent message'};
        if(scope==='everyone' && !entry.revocationRequested){
          const failure=await revoke(entry.chatId,id);
          if(failure)return failure;
          entry.revocationRequested=true;
        }else if(scope==='me')entry.hidden=true;
        await save(id,entry);
        return {status:200,...state(entry,userId)};
      });
    }
  };
}
