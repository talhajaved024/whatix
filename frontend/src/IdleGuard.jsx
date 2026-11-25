import {useEffect,useRef,useState} from 'react';
import {checkSession,idleDeadlines,keepSession,logout,onIdleChange,reportActivity} from './auth.js';
const THROTTLE=15000, MARGIN=2000, RECHECK=5000;
const NET='Could not reach the server. Check your connection and try again.';
const clock=ms=>{const s=Math.max(0,Math.ceil(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
export default function IdleGuard(){
 const [idle,setIdle]=useState(idleDeadlines);const[now,setNow]=useState(Date.now);const[busy,setBusy]=useState('');const[error,setError]=useState('');
 const dialog=useRef(null),idleRef=useRef(idle),openRef=useRef(false),cancelRef=useRef(()=>{}),announce=useRef('');
 const open=!!idle&&(idle.warn||now>=idle.warningAt);
 idleRef.current=idle;openRef.current=open;
 useEffect(()=>onIdleChange(next=>{setIdle(next);setNow(Date.now());}),[]);
 // Activity: trusted input only, leading send + one trailing send per throttle window. Never while the warning is up.
 useEffect(()=>{
  let last=0,timer=0,pending=false,inflight=null;
  const send=()=>{
   clearTimeout(timer);timer=0;pending=false;
   if(openRef.current)return;
   last=Date.now();inflight=new AbortController();
   reportActivity(inflight.signal).catch(()=>{}).finally(()=>{inflight=null;if(pending)plan();});
  };
  // Trailing send lands before the warning time, so input just before it still counts as activity.
  const plan=()=>{if(timer)return;const d=idleRef.current;timer=setTimeout(send,Math.max(0,Math.min(last+THROTTLE,d?d.warningAt-MARGIN:Infinity)-Date.now()));};
  // Chromium fires trusted mousemoves when content shifts under a still cursor (new messages, re-sorted lists).
  // Only a pointer that actually changed position counts as the user moving the mouse.
  let px=null,py=null;
  const input=e=>{if(!e.isTrusted||openRef.current)return;
   if(e.type==='mousemove'){const moved=px!==e.screenX||py!==e.screenY;px=e.screenX;py=e.screenY;if(!moved)return;}
   pending=true;if(inflight)return;Date.now()-last>=THROTTLE?send():plan();};
  cancelRef.current=()=>{clearTimeout(timer);timer=0;pending=false;inflight?.abort();};
  const types=['mousemove','pointerdown','keydown'];
  types.forEach(t=>window.addEventListener(t,input,{capture:true,passive:true}));
  return ()=>{cancelRef.current();types.forEach(t=>window.removeEventListener(t,input,{capture:true}));};
 },[]);
 useEffect(()=>{if(open)cancelRef.current();},[open]);
 // Clock: recompute from the deadline every tick, so suspension can't skew it. Wake, focus and the
 // displayed expiry only re-read /me; they never extend the session and never send a logout.
 useEffect(()=>{
  let prev=Date.now(),lastCheck=0;
  const check=()=>{lastCheck=Date.now();checkSession().then(()=>setError(e=>e===NET?'':e),()=>setError(NET));};
  const tick=()=>{const t=Date.now(),d=idleRef.current;setNow(t);
   if(t-prev>RECHECK)check();else if(d&&t>=d.expiresAt&&t-lastCheck>=RECHECK)check();prev=t;};
  const wake=()=>{if(document.visibilityState==='visible')check();};
  const id=setInterval(tick,1000);
  document.addEventListener('visibilitychange',wake);window.addEventListener('focus',wake);
  return ()=>{clearInterval(id);document.removeEventListener('visibilitychange',wake);window.removeEventListener('focus',wake);};
 },[]);
 useEffect(()=>{const d=dialog.current;if(!d)return;
  if(open&&!d.open){setError('');announce.current='';d.showModal();}else if(!open&&d.open)d.close();},[open]);
 async function stay(){setBusy('keep');setError('');
  try{await keepSession();}catch(e){setError(e instanceof TypeError?NET:e.message);}finally{setBusy('');}}
 async function leave(){setBusy('logout');setError('');
  try{await logout();}catch{setError('Could not log out. Check your connection and try again.');}finally{setBusy('');}}
 const left=idle?idle.expiresAt-now:0,secs=Math.max(0,Math.ceil(left/1000));
 if(open&&secs%30===0)announce.current=secs?clock(left)+' remaining before sign-out.':'Checking your session…';
 return <dialog ref={dialog} className="idle-dialog" aria-labelledby="idle-title" aria-describedby="idle-desc" onCancel={e=>e.preventDefault()}>
  <div className="idle-ring" style={{'--p':Math.max(0,Math.min(1,left/120000))}}><span role="timer" aria-atomic="true">{clock(left)}</span></div>
  <h2 id="idle-title">Are you still there?</h2>
  <p id="idle-desc">You've been inactive for a while. For your security you'll be signed out when the timer runs out.</p>
  <p className="idle-sr" aria-live="polite">{announce.current}</p>
  {error&&<p className="idle-error" role="alert">{error}</p>}
  <div className="idle-actions">
   <button type="button" className="idle-keep" disabled={!!busy} onClick={stay}>{busy==='keep'?'Keeping session…':'Keep session'}</button>
   <button type="button" className="idle-leave" disabled={!!busy} onClick={leave}>{busy==='logout'?'Logging out…':'Log out'}</button>
  </div>
 </dialog>;
}
