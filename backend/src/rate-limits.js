// In-process sliding-window limiter keyed by user (or any key). The backend is
// a single process (see broadcasts.js), so memory is the right place for it.
export function windowLimiter({limit,windowMs}){
  const hits=new Map();
  const prune=(list,now)=>{while(list.length && now-list[0]>=windowMs)list.shift();};
  const sweep=setInterval(()=>{
    const now=Date.now();
    for(const [key,list] of hits){prune(list,now);if(!list.length)hits.delete(key);}
  },Math.max(windowMs,1000));
  sweep.unref?.();
  return {
    take(key){
      const now=Date.now();
      let list=hits.get(key);
      if(!list)hits.set(key,list=[]);
      prune(list,now);
      if(list.length>=limit)return false;
      list.push(now);
      return true;
    },
    retryAfter(key){
      const list=hits.get(key);
      return list?.length?Math.max(1,Math.ceil((list[0]+windowMs-Date.now())/1000)):1;
    }
  };
}
