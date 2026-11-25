export function personalChats(store){
  const pending=new Map();
  const read=async userId=>JSON.parse(await store.get(String(userId)) ?? '{}');
  function remove(userId,ids){
    const previous=pending.get(userId) || Promise.resolve();
    const next=previous.catch(()=>{}).then(async()=>{
      const state=await read(userId);
      const at=Date.now();
      for(const id of ids)state[id]=at;
      await store.put(String(userId),JSON.stringify(state));
      return state;
    });
    pending.set(userId,next);
    return next.finally(()=>{if(pending.get(userId)===next)pending.delete(userId);});
  }
  return {read,remove};
}
