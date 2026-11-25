import ContactName from "./ContactName.jsx";
import {useCallback,useEffect,useRef,useState} from 'react';
import {authorizedFetch,checkSession} from '../auth.js';
import ContactAvatar from './ContactAvatar.jsx';
// Regular users: the numbers an admin assigned to them. Direct-chat keys are plain digits, so a click opens that chat.
const message=err=>err instanceof TypeError?'Could not reach the server. Check your connection and try again.':err.message;
export default function AssignedList({onOpen,onLoaded,current,disabled}){
 const [rows,setRows]=useState(null);const[error,setError]=useState('');const[loading,setLoading]=useState(false);
 const live=useRef(true),busy=useRef(null);
 const load=useCallback(()=>{
  busy.current??=(async()=>{
   setLoading(true);
   try{
    const response=await authorizedFetch('/api/assigned-numbers',{cache:'no-store'});
    if(!live.current)return;
    if(response.status===401){checkSession().catch(()=>{});return;}
    if(!response.ok){const body=await response.json().catch(()=>null);throw new Error(typeof body?.error==='string'?body.error:'Your assigned numbers could not be loaded (HTTP '+response.status+').');}
    const body=await response.json();if(!live.current)return;
    const list=Array.isArray(body?.assignments)?body.assignments:[];
    setRows([...list].sort((a,b)=>a.phoneNumber-b.phoneNumber));setError('');
    onLoaded?.(new Set(list.map(row=>String(row.phoneNumber))));
   }catch(err){if(live.current)setError(message(err));}
   finally{if(live.current)setLoading(false);}
  })().finally(()=>busy.current=null);
  return busy.current;
 },[onLoaded]);
 useEffect(()=>{
  live.current=true;load();
  window.addEventListener('focus',load);
  return ()=>{live.current=false;window.removeEventListener('focus',load);};
 },[load]);
 return <section className="assigned-list" aria-labelledby="assigned-heading">
  <div className="assigned-head"><h3 id="assigned-heading">Assigned numbers</h3>
   <button type="button" className="admin-refresh" disabled={loading} onClick={load}>{loading?'Refreshing…':'Refresh'}</button></div>
  {error?<div className="assigned-error" role="alert"><small className="error">{error}</small><button type="button" className="admin-refresh" disabled={loading} onClick={load}>Retry</button></div>
  :rows===null?<small role="status">Loading assigned numbers…</small>
  :!rows.length?<small role="status">No numbers have been assigned to you yet.</small>
  :<ul>{rows.map(row=>{const key=String(row.phoneNumber);
   return <li key={row.id}><button type="button" className="chat-row" disabled={disabled} aria-current={key===current?'true':undefined} onClick={()=>onOpen(key)}>
    <ContactAvatar contactId={key}/><span className="row-copy"><strong><ContactName id={key}>+{key}</ContactName></strong></span></button></li>;})}</ul>}
 </section>;
}
