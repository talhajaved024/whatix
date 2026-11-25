// All auth tokens live in HttpOnly cookies; never save credentials or JWTs in localStorage.
// Refresh runs only (a) on a timer ~60 s before the access token expires, (b) once after a 401 while
// the session is alive, or (c) on load when /me says the access token is gone but a refresh cookie exists.
let renewing=null, expiration=0, expiryTimer=null, alive=false, idle=null, checking=null, joining=null;
const listeners=new Set(), idleListeners=new Set();
const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('wa-auth'):null;
export function onAuthChange(fn){listeners.add(fn);return ()=>listeners.delete(fn);}
export function onIdleChange(fn){idleListeners.add(fn);return ()=>idleListeners.delete(fn);}
export const idleDeadlines=()=>idle;
const notify=(state)=>listeners.forEach(fn=>fn(state));
const setIdle=(next,share)=>{idle=next;idleListeners.forEach(fn=>fn(idle));if(share&&next)channel?.postMessage({type:'idle',...next});};
// Deadlines are server-clock ms; shift them onto this machine's clock using serverNow. The server stamped
// serverNow somewhere between `sent` and now, so anchoring on `sent` errs early by the round trip — a slow
// response can make the warning appear slightly early, never late. The server only moves deadlines forward
// within a session, so anything earlier than what we hold is stale.
function adopt(data,{force=false,warn=false,sent=Date.now()}={}){
  if(!Number.isFinite(data?.idleWarningAt)||!Number.isFinite(data?.idleExpiresAt))return;
  const skew=Number.isFinite(data.serverNow)?data.serverNow-sent:0;
  const next={warningAt:data.idleWarningAt-skew,expiresAt:data.idleExpiresAt-skew,warn};
  if(!force&&!warn&&idle&&next.expiresAt<idle.expiresAt-1000)return;
  setIdle(next,true);
}
const schedule=(seconds)=>{
  const s=Number(seconds)>0?Number(seconds):900;
  alive=true;expiration=Date.now()+s*1000;clearTimeout(expiryTimer);
  expiryTimer=setTimeout(()=>{refreshSession().catch(()=>{});},Math.max(5000,(s-60)*1000));
};
const EXPIRED='Your session has expired. Please sign in again.';
const REVOKED='Your session was ended by the administrator. Please sign in again.';
// Who is signed in, from login / refresh / GET /api/auth/me, so role-gated UI survives a reload.
let user=null;
export const currentUser=()=>user;
const remember=data=>{if(typeof data?.username==='string')user={username:data.username,
  name:typeof data.name==='string' && data.name.trim()?data.name.trim().slice(0,80):data.username,
  role:['super_user','admin'].includes(data.role)?data.role:'user'};};
let endReason='';
export const takeEndReason=()=>{const r=endReason;endReason='';return r;};
// The server revoked this session (admin). Cookies are already invalid server-side; drop local state and tell sibling tabs.
export const sessionRevoked=()=>end(true,REVOKED);
const end=(share=true,reason='')=>{const was=alive;alive=false;expiration=0;user=null;clearTimeout(expiryTimer);setIdle(null,false);
  if(was){endReason=reason;if(share)channel?.postMessage({type:'ended',reason});notify(false);}};
channel&&(channel.onmessage=({data})=>{
  if(data?.type==='ended')return end(false,data.reason||'');
  if(data?.type!=='idle')return;
  // Another tab signed in or confirmed deadlines. A signed-out tab joins via /me; a signed-in one adopts if newer.
  if(!alive){joining??=initializeSession().then(ok=>{if(ok)notify(true);}).finally(()=>joining=null);return;}
  if(!idle||data.expiresAt>=idle.expiresAt-1000)setIdle({warningAt:data.warningAt,expiresAt:data.expiresAt,warn:!!data.warn},false);
});
const reason=async(response,fallback)=>{const body=await response.json().catch(()=>({}));return body.error||fallback;};
export async function refreshSession(){
  if(renewing)return renewing;
  const renew=async()=>{
    const sent=Date.now(),response=await fetch('/api/auth/refresh',{method:'POST',credentials:'same-origin'});
    if(!response.ok){end(true,EXPIRED);throw new Error(await reason(response,'Session expired'));}
    const data=await response.json();remember(data);schedule(data.expiresIn);adopt(data,{sent});notify(true);return data;
  };
  // Tabs share the refresh cookie. Read it only after an earlier rotation finishes.
  renewing=(globalThis.navigator?.locks ? navigator.locks.request("wa-auth-refresh",renew) : renew()).finally(()=>renewing=null);
  return renewing;
}
export async function initializeSession(){
  try{
    const sent=Date.now(),response=await fetch('/api/auth/me',{credentials:'same-origin',cache:'no-store'});
    if(response.ok){const data=await response.json();if(data.expiresIn>30){remember(data);schedule(data.expiresIn);adopt(data,{force:true,sent});return true;}}
    else if(!(await response.json().catch(()=>({}))).refreshable)return false;
    await refreshSession();return true;
  }catch{return false;}
}
export async function login(username,password){
  // btoa encodes bytes, not encryption. TLS (HTTPS) provides transport confidentiality.
  const bytes=new TextEncoder().encode(JSON.stringify({username,password}));
  let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
  const credentials=btoa(binary);
  const sent=Date.now(),response=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({credentials})});
  if(response.status===429){
    const seconds=response.headers.get('Retry-After');
    if(seconds!==null&&/^\d+$/.test(seconds)){
      const retryAt=new Date(Date.now()+Number(seconds)*1000);
      if(Number.isFinite(retryAt.getTime()))throw new Error('Too many failed login attempts. Try again at '+retryAt.toLocaleTimeString()+'.');
    }
  }
  if(!response.ok)throw new Error(await reason(response,response.status===429?'Too many attempts. Try again later.':'Login failed'));
  const result=await response.json();remember(result);schedule(result.expiresIn);adopt(result,{force:true,sent});notify(true);return result;
}
export async function logout(){
  const response=await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'});
  if(!response.ok) throw new Error('Logout failed');
  end();
}
// Re-reads the session without counting as activity (wake, focus, displayed expiry). 401 → back to login.
export function checkSession(){
  checking??=(async()=>{
    const sent=Date.now(),response=await authorizedFetch('/api/auth/me',{cache:'no-store'});
    if(response.ok){const data=await response.json();remember(data);adopt(data,{force:true,sent});return true;}
    if(response.status===401){end(true,EXPIRED);return false;}
    throw new Error('Session check failed (HTTP '+response.status+')');
  })().finally(()=>checking=null);
  return checking;
}
// Real input only. A 409 means the warning window has started: adopt its deadlines and raise the warning.
export async function reportActivity(signal){
  const sent=Date.now(),response=await authorizedFetch('/api/auth/activity',{method:'POST',signal});
  if(response.ok)return adopt(await response.json(),{sent});
  if(response.status===409)return adopt(await response.json().catch(()=>({})),{warn:true,sent});
  if(response.status===401)end(true,EXPIRED);
}
export async function keepSession(){
  const sent=Date.now(),response=await authorizedFetch('/api/auth/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keepSession:true})});
  if(response.ok){adopt(await response.json(),{force:true,sent});return true;}
  if(response.status===401){end(true,EXPIRED);return false;}
  throw new Error(await reason(response,'Could not keep the session (HTTP '+response.status+').'));
}
export async function authorizedFetch(input,init={}){
  if(alive && Date.now()>expiration-30000) await refreshSession().catch(()=>{});
  let result=await fetch(input,{...init,credentials:'same-origin'});
  // Only a live session earns a retry; once refresh has failed, further 401s don't hammer /refresh.
  if(result.status===401 && alive){try{await refreshSession();result=await fetch(input,{...init,credentials:'same-origin'});}catch{}}
  return result;
}
