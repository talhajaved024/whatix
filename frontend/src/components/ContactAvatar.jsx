import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {authorizedFetch,onAuthChange} from '../auth.js';
import {campaignApi,onInboxChange} from '../inbox.js';
import Icon from './Icon.jsx';

const lifetime=2*60*1000;
// Keyed by WhatsApp number and contact: a photo is always asked of the number
// the contact belongs to (`session`, or the open inbox when none is named), and
// one number's answer is never shown for another.
const photos=new Map();
const SEPARATOR='\n';
const photoKey=(session,contactId)=>contactId?(session||'')+SEPARATOR+contactId:'';

async function refresh(key,entry){
 const [session,contactId]=key.split(SEPARATOR);
 const path='/api/contacts/profile-picture?'+new URLSearchParams({contactId});
 try{
  const response=await authorizedFetch(session?campaignApi(session,path):path,{signal:entry.controller.signal,cache:'no-store'});
  const body=response.ok?await response.json():null;
  entry.url=typeof body?.profilePictureURL==='string'?body.profilePictureURL:null;
 }catch{entry.url=null;}
 if(photos.get(key)!==entry)return;
 entry.listeners.forEach(notify=>notify());
 entry.timer=setTimeout(()=>{
  if(entry.listeners.size)void refresh(key,entry);
  else photos.delete(key);
 },lifetime);
}
function subscribe(key,notify){
 if(!key)return ()=>{};
 let entry=photos.get(key);
 if(!entry){
  entry={url:null,listeners:new Set(),controller:new AbortController(),timer:null};
  photos.set(key,entry);
  void refresh(key,entry);
 }
 entry.listeners.add(notify);
 return ()=>entry.listeners.delete(notify);
}
function forgetPhotos(){
 for(const entry of photos.values()){
  clearTimeout(entry.timer);
  entry.controller.abort();
  entry.url=null;
  entry.listeners.forEach(notify=>notify());
 }
 photos.clear();
}
onAuthChange(signedIn=>{if(!signedIn)forgetPhotos();});
// Photos asked of the open inbox belong to that WhatsApp number.
onInboxChange(forgetPhotos);

function Photo({url}){
 const [loaded,setLoaded]=useState(false);
 return <img className="contact-photo" alt="" src={url} style={{visibility:loaded?'visible':'hidden'}}
  onLoad={()=>setLoaded(true)} onError={()=>setLoaded(false)}/>;
}
export default function ContactAvatar({contactId,session,broadcast=false,className='block-avatar',fallback,children}){
 const element=useRef(null),[visible,setVisible]=useState(false);
 const id=photoKey(session,!broadcast&&contactId?String(contactId):'');
 useEffect(()=>{
  if(!id)return;
  if(typeof IntersectionObserver==='undefined'){setVisible(true);return;}
  const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting));
  observer.observe(element.current);
  return ()=>observer.disconnect();
 },[Boolean(id)]);
 const key=visible?id:'';
 const listen=useCallback(notify=>subscribe(key,notify),[key]);
 const url=useSyncExternalStore(listen,()=>photos.get(key)?.url??null);
 return <span ref={element} className={className+' contact-avatar'+(broadcast?' broadcast':'')}>
  {fallback??<Icon name={broadcast?'users':'person'}/>}
  {url&&<Photo key={key+':'+url} url={url}/>}
  {children}
 </span>;
}
