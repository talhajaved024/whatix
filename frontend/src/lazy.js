import {lazy} from 'react';

// A component whose code downloads only when first shown (React.lazy), plus
// preload() to fetch it ahead of time, so the first click still feels instant.
// A screen's code can be missing right after a release: this tab still runs the
// previous build, whose files the server no longer has. Reloading the page gets
// the current build. Done once a minute at most, so a real outage shows its
// error instead of reloading forever.
const RELOADED='whatix-code-reload';
function reloadForNewBuild(){
  try{
    if(Date.now()-Number(sessionStorage.getItem(RELOADED)||0)<60000)return;
    sessionStorage.setItem(RELOADED,String(Date.now()));
  }catch{return;}
  location.reload();
}
export function lazyComponent(load){
  let pending=null;
  const fetch=()=>pending??=load().catch(err=>{pending=null;throw err;});
  // Only when the screen is actually being opened; a failed preload stays silent.
  const Component=lazy(()=>fetch().catch(err=>{reloadForNewBuild();throw err;}));
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
