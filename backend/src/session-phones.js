// Which business phone each WAHA session is paired to, shared by every
// request. Regular users' access checks run on every request and on every
// live WhatsApp event, so the answer is cached briefly and concurrent lookups
// share one WAHA request. Pass {fresh:true} where a stale answer would matter
// (admin writes), or {maxAgeMs} to accept only a recent one (the browser's 5 s
// availability probe, shared by all tabs); a session.status event drops the
// cached answer at once.
export const campaignPhone=session=>
  session?.status==='WORKING' && /^(\d+)(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/.exec(session.me?.id)?.[1] || null;

export function sessionPhones({base,headers,ttlMs=15000,errorTtlMs=2000,now=Date.now}){
  const cache=new Map(); // name -> {at, value} | {at, error} | {pending}
  async function lookup(name){
    const response=await fetch(base+'/api/sessions/'+encodeURIComponent(name),{headers:headers(),redirect:'error',signal:AbortSignal.timeout(6000)});
    if(!response.ok){
      await response.body?.cancel();
      throw Object.assign(Error('WhatsApp data unavailable'),{status:response.status===404?404:502});
    }
    const row=await response.json();
    return row?.name===name?campaignPhone(row):null;
  }
  function phone(name,{fresh=false,maxAgeMs=ttlMs}={}){
    const hit=cache.get(name);
    if(hit?.pending)return hit.pending;
    if(hit && !fresh && now()-hit.at<(hit.error?errorTtlMs:Math.min(ttlMs,maxAgeMs)))
      return hit.error?Promise.reject(hit.error):Promise.resolve(hit.value);
    const pending=lookup(name).then(
      value=>{cache.set(name,{at:now(),value});return value;},
      error=>{cache.set(name,{at:now(),error});throw error;});
    cache.set(name,{pending});
    return pending;
  }
  return {phone,invalidate:name=>{if(!cache.get(name)?.pending)cache.delete(name);}};
}
