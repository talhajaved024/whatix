import {useEffect,useState} from 'react';
import {authorizedFetch} from './auth.js';
import {bindHistory} from './history.js';

// Whether `session` (the open inbox) is connected, as {account} once checked:
// undefined while this session is being checked, account null if unavailable.
export function useInboxAvailability(username,session){
  const [verified,setVerified]=useState(null);
  useEffect(()=>{
    if(!username)return;
    let active=true,request,timer;
    const unavailable=()=>setVerified({username,session,account:null});
    function cancel(){
      clearTimeout(timer);
      request?.abort();
    }
    async function check(){
      cancel();
      if(!navigator.onLine){unavailable();return;}
      const controller=new AbortController();
      request=controller;
      try{
        const response=await authorizedFetch('/api/inbox-availability',{cache:'no-store',
          signal:AbortSignal.any([controller.signal,AbortSignal.timeout(6000)])});
        const account=response.ok?(await response.json()).account:null;
        if(!active || controller.signal.aborted)return;
        // Refused: this user no longer holds this inbox's campaign. Re-read
        // their campaigns now, so the view moves on without waiting.
        if(response.status===403)window.dispatchEvent(new Event('whatix-campaigns-changed'));
        if(!account)unavailable();
        else if(bindHistory(account))setVerified({username,session,account});
        else{
          // A session name has been paired to a different phone. Dispose of
          // in-flight work and all module-level contact, media and history caches.
          unavailable();
          location.reload();
          return;
        }
      }catch{if(active && !controller.signal.aborted)unavailable();}
      // Paused while the tab is hidden; showing it again checks at once (visibilitychange below).
      if(active && !controller.signal.aborted && !document.hidden)timer=setTimeout(check,5000);
    }
    function invalidate(){cancel();unavailable();check();}
    const visible=()=>{if(!document.hidden)check();};
    check();
    window.addEventListener('offline',invalidate);
    window.addEventListener('online',check);
    window.addEventListener('whatix-inbox-status',invalidate);
    window.addEventListener('focus',check);
    window.addEventListener('pageshow',check);
    document.addEventListener('visibilitychange',visible);
    return ()=>{
      active=false;cancel();
      window.removeEventListener('offline',invalidate);
      window.removeEventListener('online',check);
      window.removeEventListener('whatix-inbox-status',invalidate);
      window.removeEventListener('focus',check);
      window.removeEventListener('pageshow',check);
      document.removeEventListener('visibilitychange',visible);
    };
  },[username,session]);
  return username && verified?.username===username && verified.session===session?verified:undefined;
}
