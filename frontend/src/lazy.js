import {lazy} from 'react';

// A component whose code downloads only when first shown (React.lazy), plus
// preload() to fetch it ahead of time, so the first click still feels instant.
export function lazyComponent(load){
  let pending=null;
  const fetch=()=>pending??=load().catch(err=>{pending=null;throw err;});
  const Component=lazy(fetch);
  Component.preload=()=>{fetch().catch(()=>{});};
  return Component;
}

// Runs once the browser is idle (or after a short delay), so preloading never
// competes with the first paint or with typing.
export function whenIdle(fn,timeout=4000){
  if(typeof window.requestIdleCallback==='function'){
    const id=window.requestIdleCallback(fn,{timeout});
    return ()=>window.cancelIdleCallback?.(id);
  }
  const id=setTimeout(fn,1500);
  return ()=>clearTimeout(id);
}
