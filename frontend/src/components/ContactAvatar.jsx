import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {authorizedFetch,onAuthChange} from '../auth.js';
import Icon from './Icon.jsx';

const lifetime=2*60*1000;
const photos=new Map();

async function refresh(contactId,entry){
 try{
  const response=await authorizedFetch('/api/contacts/profile-picture?'+new URLSearchParams({contactId}),{signal:entry.controller.signal,cache:'no-store'});
  const body=response.ok?await response.json():null;
  entry.url=typeof body?.profilePictureURL==='string'?body.profilePictureURL:null;
 }catch{entry.url=null;}
 if(photos.get(contactId)!==entry)return;
 entry.listeners.forEach(notify=>notify());
 entry.timer=setTimeout(()=>{
  if(entry.listeners.size)void refresh(contactId,entry);
  else photos.delete(contactId);
 },lifetime);
}
function subscribe(contactId,notify){
 if(!contactId)return ()=>{};
 let entry=photos.get(contactId);
 if(!entry){
  entry={url:null,listeners:new Set(),controller:new AbortController(),timer:null};
  photos.set(contactId,entry);
  void refresh(contactId,entry);
 }
 entry.listeners.add(notify);
 return ()=>entry.listeners.delete(notify);
}
onAuthChange(signedIn=>{
 if(signedIn)return;
 for(const entry of photos.values()){
  clearTimeout(entry.timer);
  entry.controller.abort();
  entry.url=null;
  entry.listeners.forEach(notify=>notify());
 }
 photos.clear();
});

function Photo({url}){
 const [loaded,setLoaded]=useState(false);
 return <img className="contact-photo" alt="" src={url} style={{visibility:loaded?'visible':'hidden'}}
  onLoad={()=>setLoaded(true)} onError={()=>setLoaded(false)}/>;
}
export default function ContactAvatar({contactId,broadcast=false,className='block-avatar',fallback,children}){
 const element=useRef(null),[visible,setVisible]=useState(false);
 const id=!broadcast&&contactId?String(contactId):'';
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
