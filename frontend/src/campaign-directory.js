import {useEffect,useState} from 'react';
import {authorizedFetch,onAuthChange} from './auth.js';
import {campaignApi,campaignNumber} from './inbox.js';
import {isBusinessLabel} from './business-labels.js';
// A campaign is one connected WAHA session; its business number is what admins assign.

const failure=async(response,fallback)=>{
 const body=await response.json().catch(()=>null);
 return Object.assign(new Error(typeof body?.error==='string'?body.error:fallback+' (HTTP '+response.status+').'),{status:response.status});
};

// Admins: every connected campaign number as {name, phone}, plus the default session.
export async function loadCampaigns(signal){
 const response=await authorizedFetch('/api/admin/whatsapp-numbers',{signal,cache:'no-store'});
 if(!response.ok)throw await failure(response,'The WhatsApp numbers could not be loaded');
 const body=await response.json();
 const rows=Array.isArray(body?.sessions)?body.sessions:[];
 const connected=rows.filter(row=>row.status==='WORKING' && campaignNumber(row))
  .map(row=>({name:row.name,phone:campaignNumber(row)}))
  .sort((a,b)=>(b.name===body.defaultSession)-(a.name===body.defaultSession)||a.name.localeCompare(b.name));
 return {campaigns:connected,disconnected:rows.length-connected.length,defaultSession:body.defaultSession};
}

// Who holds which number, and which customers they handle, changed in this
// browser: the chat list's assignee chips reload at once instead of waiting
// for their 30 s poll. Other tabs of this browser hear it too.
const ASSIGNMENTS_CHANGED='whatix-assignments-changed';
const assignmentChannel=typeof BroadcastChannel==='function'?new BroadcastChannel(ASSIGNMENTS_CHANGED):null;
export function announceAssignments(){
 window.dispatchEvent(new Event(ASSIGNMENTS_CHANGED));
 assignmentChannel?.postMessage('changed');
}
export function onAssignmentsChanged(listener){
 window.addEventListener(ASSIGNMENTS_CHANGED,listener);
 const channel=typeof BroadcastChannel==='function'?new BroadcastChannel(ASSIGNMENTS_CHANGED):null;
 if(channel)channel.onmessage=listener;
 return ()=>{window.removeEventListener(ASSIGNMENTS_CHANGED,listener);channel?.close();};
}

// One campaign's API. Writes carry the number the admin was looking at, so a
// session re-paired to another phone in the meantime is refused (409).
// Every successful write (grants, customers) is announced.
export function campaignClient(campaign){
 const url=path=>campaignApi(campaign.name,path);
 const write=async(method,path,body)=>{
  const response=await authorizedFetch(url(path),{method,
   headers:{'Content-Type':'application/json','X-Campaign-Phone':campaign.phone},body:body===undefined?undefined:JSON.stringify(body)});
  if(response.ok)announceAssignments();
  return response;
 };
 return {
  url,write,
  async grants(signal){
   const response=await authorizedFetch(url('/api/campaign-grants'),{signal,cache:'no-store'});
   if(!response.ok)throw await failure(response,'Campaign access could not be loaded for '+campaign.name);
   return response.json();
  },
  async labels(signal){
   const response=await authorizedFetch(url('/api/'+encodeURIComponent(campaign.name)+'/labels'),{signal,cache:'no-store'});
   if(!response.ok)throw await failure(response,'Labels could not be loaded for '+campaign.name);
   const rows=await response.json();
   return (Array.isArray(rows)?rows:[]).filter(isBusinessLabel).map(label=>({...label,id:String(label.id)}));
  }
 };
}

// Regular users: the campaigns assigned to them (names only). Admins: every
// connected number. One poller per tab, shared by everything that needs it
// (the workspace for regular users, the WA number picker for everyone), so
// the list is fetched once, not once per component. It is kept current: every
// 15 s while the page is visible (paused while hidden), when the tab is shown
// or the window regains focus, and at once when an inbox refuses this user
// (an admin removed their campaign). The last list survives inbox switches
// and is dropped at sign-out.
const mine={data:null,error:'',listeners:new Set(),controller:null,timer:null};
onAuthChange(signedIn=>{if(!signedIn){mine.data=null;mine.error='';}});
const notifyMine=()=>{for(const listener of [...mine.listeners])listener();};
async function loadMine(){
 mine.controller?.abort();
 const controller=mine.controller=new AbortController();
 try{
  const response=await authorizedFetch('/api/my-campaigns',{signal:controller.signal,cache:'no-store'});
  if(!response.ok)throw await failure(response,'Your campaigns could not be loaded');
  const body=await response.json();
  if(controller.signal.aborted)return;
  mine.data={sessions:Array.isArray(body?.sessions)?body.sessions:[],defaultSession:body?.defaultSession};mine.error='';
 }catch(error){
  if(controller.signal.aborted)return;
  mine.error=error.message||'Your campaigns could not be loaded';
 }
 notifyMine();
}
const loadIfVisible=()=>{if(document.visibilityState==='visible')loadMine();};
function startMine(){
 loadMine();
 mine.timer=setInterval(loadIfVisible,15000);
 window.addEventListener('focus',loadMine);
 window.addEventListener('whatix-campaigns-changed',loadMine);
 document.addEventListener('visibilitychange',loadIfVisible);
}
function stopMine(){
 mine.controller?.abort();clearInterval(mine.timer);
 window.removeEventListener('focus',loadMine);
 window.removeEventListener('whatix-campaigns-changed',loadMine);
 document.removeEventListener('visibilitychange',loadIfVisible);
}
// Fetch again now (a Retry button).
export const refreshMyCampaigns=()=>loadMine();
// {sessions, defaultSession} once loaded; {error} if the first load failed (a
// later failure keeps the last list); null while loading or when disabled.
export function useMyCampaigns(enabled=true){
 const [,rerender]=useState(0);
 useEffect(()=>{
  if(!enabled)return;
  const listener=()=>rerender(n=>n+1);
  mine.listeners.add(listener);
  if(mine.listeners.size===1)startMine();
  return ()=>{mine.listeners.delete(listener);if(!mine.listeners.size)stopMine();};
 },[enabled]);
 if(!enabled)return null;
 return mine.data ?? (mine.error?{error:mine.error}:null);
}
