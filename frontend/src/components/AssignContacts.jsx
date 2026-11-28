import {ContactHighlight} from "./LabelHighlights.jsx";
import {useEffect,useMemo,useRef,useState} from 'react';
import {authorizedFetch} from '../auth.js';
import {loadDirectContacts} from '../contacts-directory.js';
import ContactAvatar from './ContactAvatar.jsx';
import {campaignClient} from '../campaign-directory.js';
import Dropdown from './Dropdown.jsx';
// Assign one or more WhatsApp contacts of one campaign number to a single regular user. The API takes
// one number per POST, so selections are saved one at a time with a status per contact; failures can be retried.
const PHONE=/^[1-9]\d{0,14}$/;
const digitsOf=value=>String(value??'').replace(/[+\s()\-]/g,'');
const offline=err=>err instanceof TypeError?'Could not reach the server. Check your connection and try again.':err.message;
const statusText={saving:'Saving…',added:'Assigned',already:'Already assigned',failed:'Failed'};
export default function AssignContacts({users,campaign,initialUsername,handled,onClose}){
 const dialog=useRef(null),live=useRef(true),stop=useRef(false);
 const [username,setUsername]=useState(initialUsername||'');
 const [directory,setDirectory]=useState(null);const[directoryError,setDirectoryError]=useState('');const[reload,setReload]=useState(0);
 const [assigned,setAssigned]=useState(null);const[assignedError,setAssignedError]=useState('');
 const [query,setQuery]=useState('');const[checked,setChecked]=useState(()=>new Set());
 const [extra,setExtra]=useState('');const[extras,setExtras]=useState([]);
 const [results,setResults]=useState(null);const[busy,setBusy]=useState(false);const[error,setError]=useState('');
 useEffect(()=>{live.current=true;dialog.current.showModal();return ()=>{live.current=false;stop.current=true;};},[]);
 useEffect(()=>{
  const controller=new AbortController();
  setDirectory(null);setDirectoryError('');
  loadDirectContacts(controller.signal,campaign.name).then(found=>{if(!controller.signal.aborted)setDirectory(found);}).catch(err=>{if(!controller.signal.aborted)setDirectoryError(offline(err));});
  return ()=>controller.abort();
 },[reload,campaign.name]);
 // Numbers this user already has are shown ticked and locked, so they are never sent again (no 409s).
 useEffect(()=>{
  setAssigned(null);setAssignedError('');
  if(!username)return;
  const controller=new AbortController();
  (async()=>{
   const response=await authorizedFetch(campaignClient(campaign).url('/api/campaign-contacts?'+new URLSearchParams({username})),{signal:controller.signal,cache:'no-store'});
   if(controller.signal.aborted)return;
   if(handled(response)){onClose(false);return;}
   const body=await response.json().catch(()=>null);
   if(!response.ok)throw new Error(typeof body?.error==='string'?body.error:'Could not load this user’s numbers (HTTP '+response.status+').');
   setAssigned(new Set((Array.isArray(body?.assignments)?body.assignments:[]).map(r=>String(r.phoneNumber))));
  })().catch(err=>{if(!controller.signal.aborted)setAssignedError(offline(err));});
  return ()=>controller.abort();
 },[username,handled,onClose,campaign]);
 const contacts=useMemo(()=>{
  const list=directory?.contacts??[],known=new Set(list.map(c=>c.phone));
  return [...extras.filter(phone=>!known.has(phone)).map(phone=>({phone,name:''})),...list];
 },[directory,extras]);
 const needle=query.trim().toLowerCase(),needleDigits=digitsOf(query);
 const visible=contacts.filter(c=>!needle||c.name.toLowerCase().includes(needle)||(needleDigits&&/^\d+$/.test(needleDigits)&&c.phone.includes(needleDigits)));
 const isAssigned=phone=>!!assigned?.has(phone)||results?.get(phone)?.status==='added';
 const selectable=visible.filter(c=>!isAssigned(c.phone));
 const selected=[...checked].filter(phone=>!isAssigned(phone));
 const allVisible=selectable.length>0&&selectable.every(c=>checked.has(c.phone));
 const extraDigits=digitsOf(extra),extraValid=PHONE.test(extraDigits);
 const failed=results?[...results].filter(([,r])=>r.status==='failed').map(([phone])=>phone):[];
 const done=results&&[...results.values()].every(r=>r.status!=='saving'&&r.status!=='pending');
 const added=results?[...results.values()].filter(r=>r.status==='added').length:0;
 const locked=busy||!!results;
 function toggle(phone,on){setChecked(prev=>{const next=new Set(prev);on?next.add(phone):next.delete(phone);return next;});}
 function toggleVisible(on){setChecked(prev=>{const next=new Set(prev);for(const c of selectable)on?next.add(c.phone):next.delete(c.phone);return next;});}
 function addExtra(e){
  e?.preventDefault();if(!extraValid)return;
  setExtras(prev=>prev.includes(extraDigits)?prev:[extraDigits,...prev]);toggle(extraDigits,true);setExtra('');
 }
 async function save(phones){
  if(busy||!username||!phones.length)return;
  setBusy(true);setError('');stop.current=false;
  setResults(prev=>{const next=new Map(prev??[]);for(const phone of phones)next.set(phone,{status:'pending'});return next;});
  const update=(phone,status,message='')=>{if(live.current)setResults(prev=>new Map(prev).set(phone,{status,error:message}));};
  try{
   for(const phone of phones){
    if(stop.current)break;
    update(phone,'saving');
    try{
     const response=await campaignClient(campaign).write('POST','/api/campaign-contacts',{phoneNumber:Number(phone),username});
     if(handled(response)){stop.current=true;update(phone,'failed','Your session changed. Sign in again and retry.');break;}
     if(response.status===201){update(phone,'added');continue;}
     const body=await response.json().catch(()=>null);
     const message=typeof body?.error==='string'?body.error:'Could not assign this number (HTTP '+response.status+').';
     if(response.status===409&&/already assigned/i.test(message))update(phone,'already',message);
     else{
      update(phone,'failed',message);
      // These apply to the whole request, not one number: stop instead of repeating the same error.
      // 409 here means the campaign number changed, 422 that the user lost this campaign.
      if([409,422,503].includes(response.status)){setError(message);break;}
     }
    }catch(err){update(phone,'failed',offline(err));}
   }
  }finally{
   if(live.current){
    setBusy(false);
    // Anything still pending after a stop is shown as failed so it can be retried.
    setResults(prev=>{const next=new Map(prev);for(const [phone,r] of next)if(r.status==='pending'||r.status==='saving')next.set(phone,{status:'failed',error:'Not sent.'});return next;});
   }
  }
 }
 const who=users.find(u=>u.username===username);
 const finish=()=>onClose(added>0?`Assigned ${added} number${added===1?'':'s'} to ${who?.name||username}.`:false);
 return <dialog ref={dialog} className="idle-dialog um-dialog an-assign" aria-labelledby="an-assign-title" onCancel={e=>{e.preventDefault();if(!busy)finish();}}>
  <h2 id="an-assign-title">Assign contacts</h2>
  <p className="an-hint">Campaign +{campaign.phone} · {campaign.name}</p>
  <div className="an-fields">
   <label className="um-field">User
    <Dropdown label="User" value={username} disabled={locked} onChange={setUsername} placeholder="Choose a user" searchPlaceholder="Search users"
     options={users.map(u=>({value:u.username,label:u.name||u.username,description:'@'+u.username,icon:'person'}))}/>
    {assignedError&&<small className="um-error" role="alert">{assignedError}</small>}
   </label>
   <fieldset className="an-contacts" disabled={locked||!username}>
    <legend>Contacts{directory&&<small> · {contacts.length}</small>}</legend>
    {!username&&<small role="status">Choose a user first.</small>}
    {directoryError?<div className="assigned-error" role="alert"><small className="um-error">{directoryError}</small><button type="button" className="admin-refresh" onClick={()=>setReload(n=>n+1)}>Retry</button></div>
    :directory===null?<small role="status" aria-busy="true">Loading WhatsApp contacts…</small>
    :<>
     <div className="an-tools">
      <label className="an-search"><span className="idle-sr">Search contacts</span>
       <input type="search" placeholder="Search name or number" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <label className="an-all"><input type="checkbox" checked={allVisible} disabled={!selectable.length} onChange={e=>toggleVisible(e.target.checked)}/>{needle?'Select all shown':'Select all'}</label>
     </div>
     {!visible.length?<small role="status">{contacts.length?'No contacts match your search.':'No direct chats were found in WhatsApp.'}</small>
     :<ul className="an-list">{visible.map(c=>{
      const r=results?.get(c.phone),already=isAssigned(c.phone)&&!r;
      return <li key={c.phone}><label className={already?'an-taken':undefined}>
       <input type="checkbox" checked={already||checked.has(c.phone)} disabled={already||assigned===null} onChange={e=>toggle(c.phone,e.target.checked)}/>
       <ContactAvatar className="admin-avatar" contactId={c.phone} session={campaign.name} fallback={(c.name||'#').slice(0,1).toUpperCase()}/>
       <span className="um-who"><strong><ContactHighlight id={c.phone}>{c.name||'+'+c.phone}</ContactHighlight></strong>{c.name&&<small><ContactHighlight id={c.phone}>+{c.phone}</ContactHighlight></small>}</span>
       {already&&<span className="um-badge">Assigned</span>}
       {r&&<span className={'an-status '+r.status} title={r.error||undefined}>{statusText[r.status]??''}</span>}
      </label>{r?.status==='failed'&&r.error&&<small className="um-error an-row-error">{r.error}</small>}</li>;})}</ul>}
     {directory.empty>0&&<small role="status">{directory.empty} chat{directory.empty===1?'':'s'} with no messages {directory.empty===1?'is':'are'} not listed.</small>}
     {directory.unresolved>0&&<small role="status">{directory.unresolved} chat{directory.unresolved===1?'':'s'} without a known phone number {directory.unresolved===1?'is':'are'} not listed.</small>}
    </>}
    <div className="an-extra">
     <label className="um-field">Number not in the list
      <input type="tel" inputMode="tel" placeholder="+92 300 1234567" value={extra} aria-invalid={!!extra&&!extraValid} onChange={e=>setExtra(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')addExtra(e);}}/>
      {extra&&!extraValid&&<small className="um-error">Enter the country code and number: up to 15 digits, not starting with 0.</small>}
     </label>
     <button type="button" className="admin-refresh" disabled={!extraValid} onClick={addExtra}>Add</button>
    </div>
   </fieldset>
  </div>
  {error&&<p className="idle-error" role="alert">{error}</p>}
  {results&&<p className="an-hint" role="status">{done?`${added} assigned${failed.length?` · ${failed.length} failed`:''}.`:'Saving…'}</p>}
  <div className="idle-actions">
   <button type="button" className="idle-leave" disabled={busy} onClick={finish}>{results?'Done':'Cancel'}</button>
   {results&&done&&failed.length>0
    ?<button type="button" className="um-primary" disabled={busy} onClick={()=>save(failed)}>Retry failed ({failed.length})</button>
    :!results&&<button type="button" className="um-primary" disabled={busy||!username||assigned===null||!selected.length} onClick={()=>save(selected)}>
      {selected.length?`Assign ${selected.length} contact${selected.length===1?'':'s'}`:'Assign'}</button>}
  </div>
 </dialog>;
}
