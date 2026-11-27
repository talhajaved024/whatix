import {useEffect,useState} from 'react';
const primary=import.meta.env?.VITE_WAHA_SESSION || 'TEST_BULK';
const validName=name=>typeof name==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(name);
const fromLocation=()=>{
  const requested=new URLSearchParams(globalThis.location?.search).get('inbox');
  return requested && requested!==primary && validName(requested)?requested:primary;
};
// The open inbox (WAHA session). These are live bindings: importers always see
// the current value, so switching inboxes needs no page reload.
export let SESSION=fromLocation();
export let secondary=SESSION!==primary;
export const inboxUrl=path=>secondary?'/api/inboxes/'+encodeURIComponent(SESSION)+path:path;

// An API path inside one specific campaign inbox, whichever inbox this page has open.
export const campaignApi=(name,path)=>'/api/inboxes/'+encodeURIComponent(name)+path;
export const campaignNumber=row=>/^(\d+)(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/.exec(row?.me?.id||'')?.[1]||null;

// Modules holding per-inbox caches clear them here; React views re-render via useInboxSession.
const listeners=new Set();
export function onInboxChange(listener){listeners.add(listener);return ()=>listeners.delete(listener);}
function use(name){
  if(name===SESSION)return;
  SESSION=name;secondary=name!==primary;
  for(const listener of [...listeners])listener(name);
}
// Switch inbox in place: the address shows ?inbox=…, Back and Forward move between inboxes.
export function openInbox(name=null,defaultSession=primary,hash=''){
  const target=name===null || name===defaultSession?primary:name;
  const url=new URL(location.href);
  if(target===primary)url.searchParams.delete('inbox');
  else url.searchParams.set('inbox',target);
  url.hash=hash;
  if(url.href!==location.href)history.pushState(history.state,'',url);
  use(target);
}
globalThis.addEventListener?.('popstate',()=>use(fromLocation()));
// Opening a customer in another inbox (e.g. from the Whatix AI tab): switch
// to it, and its chat view opens that customer as soon as it mounts.
let pendingChat=null;
export function openChatIn(name,key,defaultSession=primary){
  pendingChat={session:name===null || name===defaultSession?primary:name,key};
  openInbox(name,defaultSession);
}
export function takePendingChat(session){
  if(pendingChat?.session!==session)return null;
  const {key}=pendingChat;pendingChat=null;return key;
}
export function useInboxSession(){
  const [session,setSession]=useState(SESSION);
  useEffect(()=>{setSession(SESSION);return onInboxChange(setSession);},[]);
  return session;
}

// The campaign a user last chose on this browser, so signing in returns there.
const lastKey=username=>'whatix-last-campaign:'+username;
export function rememberCampaign(username,name){
  try{if(username)localStorage.setItem(lastKey(username),name);}catch{/* storage blocked: start on the default campaign */}
}
export function lastCampaign(username){
  try{return username?localStorage.getItem(lastKey(username)):null;}catch{return null;}
}
// The remembered campaign is shared by every tab, so it is used only once per
// tab: when that tab first opens the app. Afterwards the tab stays wherever the
// user switches it, whatever other tabs choose.
const openedKey=username=>'whatix-campaign-opened:'+username;
export function campaignToResume(username){
  try{
    if(!username || sessionStorage.getItem(openedKey(username)))return null;
    sessionStorage.setItem(openedKey(username),'1');
  }catch{return null;}
  return lastCampaign(username);
}
// Signing out lets the next sign-in in this tab resume the last choice again.
export function forgetResume(username){
  try{if(username)sessionStorage.removeItem(openedKey(username));}catch{/* storage blocked */}
}
