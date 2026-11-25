import {ContactHighlight} from "./components/LabelHighlights.jsx";
import {useCallback,useEffect,useRef,useState} from 'react';
import {authorizedFetch,checkSession} from './auth.js';
import ContactAvatar from './components/ContactAvatar.jsx';
import AssignContacts from './components/AssignContacts.jsx';
// Admin / super-user tab: which phone numbers each regular user may work with.
// Only regular users can be assignees; the backend rejects admins and super users with 422.
const POLL=30000,PHONE=/^[1-9]\d{0,14}$/;
const json=(method,body)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const offline=err=>err instanceof TypeError?'Could not reach the server. Check your connection and try again.':err.message;
const failure=async(response,fallback)=>{const body=await response.json().catch(()=>null);return new Error(typeof body?.error==='string'?body.error:fallback+' (HTTP '+response.status+').');};
// "+92 300 123-4567" → "923001234567"
export const phoneDigits=value=>String(value??'').replace(/[+\s()\-]/g,'');
export default function AssignedNumbers({id,labelledBy,onForbidden}){
 const [rows,setRows]=useState(null);const[users,setUsers]=useState(null);const[filter,setFilter]=useState('');
 const [error,setError]=useState('');const[note,setNote]=useState('');const[updated,setUpdated]=useState(0);
 const [form,setForm]=useState(null);const[formError,setFormError]=useState('');const[saving,setSaving]=useState(false);
 const [adding,setAdding]=useState(false);
 const [target,setTarget]=useState(null);const[deleting,setDeleting]=useState(false);const[deleteError,setDeleteError]=useState('');
 const live=useRef(true),seq=useRef(0),formDialog=useRef(null),deleteDialog=useRef(null);
 const handled=useCallback(response=>{
  if(response.status===403){onForbidden();return true;}
  if(response.status===401){checkSession().catch(()=>{});return true;}
  return false;
 },[onForbidden]);
 // The newest request wins, so a slow response for an old filter can't overwrite the current one.
 const load=useCallback(async()=>{
  const mine=++seq.current;
  try{
   const response=await authorizedFetch('/api/assigned-numbers'+(filter?'?'+new URLSearchParams({username:filter}):''),{cache:'no-store'});
   if(!live.current||mine!==seq.current||handled(response))return;
   if(!response.ok)throw await failure(response,'The assigned numbers could not be loaded');
   const body=await response.json();if(!live.current||mine!==seq.current)return;
   const list=Array.isArray(body?.assignments)?body.assignments:[];
   list.sort((a,b)=>String(a.username).localeCompare(String(b.username))||a.phoneNumber-b.phoneNumber);
   setRows(list);setError('');setUpdated(Date.now());
  }catch(err){if(live.current&&mine===seq.current)setError(offline(err));}
 },[filter,handled]);
 const loadUsers=useCallback(async()=>{
  try{
   const response=await authorizedFetch('/api/admin/users',{cache:'no-store'});
   if(!live.current||handled(response))return;
   if(!response.ok)throw await failure(response,'The user list could not be loaded');
   const body=await response.json();if(!live.current)return;
   const list=(Array.isArray(body?.users)?body.users:[]).filter(u=>!u.isAdmin&&!u.isSuperUser);
   list.sort((a,b)=>String(a.name||a.username).localeCompare(String(b.name||b.username)));
   setUsers(list);
  }catch(err){if(live.current)setError(offline(err));}
 },[handled]);
 useEffect(()=>{live.current=true;return ()=>{live.current=false;};},[]);
 useEffect(()=>{loadUsers();},[loadUsers]);
 useEffect(()=>{
  setRows(null);load();
  const shown=()=>{if(document.visibilityState==='visible'){load();loadUsers();}};
  const poll=setInterval(()=>{if(document.visibilityState==='visible')load();},POLL);
  document.addEventListener('visibilitychange',shown);
  return ()=>{clearInterval(poll);document.removeEventListener('visibilitychange',shown);};
 },[load,loadUsers]);
 useEffect(()=>{const d=formDialog.current;if(!d)return;if(form&&!d.open)d.showModal();else if(!form&&d.open)d.close();},[form]);
 useEffect(()=>{const d=deleteDialog.current;if(!d)return;if(target&&!d.open)d.showModal();else if(!target&&d.open)d.close();},[target]);
 const byName=new Map((users??[]).map(u=>[u.username,u]));
 const who=username=>{const u=byName.get(username);return u?.name&&u.name!==username?u.name:username;};
 function openAdd(){setAdding(true);setNote('');}
 function openEdit(row){setForm({row,phone:'+'+row.phoneNumber,username:row.username});setFormError('');setNote('');}
 const closeAdd=useCallback(message=>{setAdding(false);if(message){setNote(message);void load();}},[load]);
 const digits=form?phoneDigits(form.phone):'';
 const phoneValid=PHONE.test(digits);
 const changes=form?.row?{...(phoneValid&&Number(digits)!==form.row.phoneNumber?{phoneNumber:Number(digits)}:{}),...(form.username!==form.row.username?{username:form.username}:{})}:null;
 const canSave=!!form&&!saving&&phoneValid&&!!form.username&&(!form.row||Object.keys(changes).length>0);
 async function save(e){
  e.preventDefault();if(!canSave)return;
  const editing=form.row;
  setSaving(true);setFormError('');
  try{
   const response=editing
    ?await authorizedFetch('/api/admin/assigned-numbers/'+encodeURIComponent(editing.id),json('PATCH',changes))
    :await authorizedFetch('/api/admin/assigned-numbers',json('POST',{phoneNumber:Number(digits),username:form.username}));
   if(handled(response)){setForm(null);return;}
   if(editing&&response.status===404){setForm(null);setNote('That assignment no longer exists.');await load();return;}
   if(!response.ok)throw await failure(response,editing?'Could not update the assignment':'Could not assign the number');
   const row=await response.json().catch(()=>null);
   setForm(null);
   setNote(`${editing?'Updated':'Assigned'} +${row?.phoneNumber??digits} ${editing?'for':'to'} ${who(row?.username??form.username)}.`);
   await load();
  }catch(err){setFormError(offline(err));}
  finally{if(live.current)setSaving(false);}
 }
 async function confirmDelete(){
  if(!target||deleting)return;const row=target;
  setDeleting(true);setDeleteError('');
  try{
   const response=await authorizedFetch('/api/admin/assigned-numbers/'+encodeURIComponent(row.id),{method:'DELETE'});
   if(handled(response)){setTarget(null);return;}
   if(response.status===204||response.status===404){
    setTarget(null);setNote(response.status===404?`+${row.phoneNumber} had already been removed.`:`Removed +${row.phoneNumber} from ${who(row.username)}.`);
    await load();return;
   }
   throw await failure(response,'Could not remove the assignment');
  }catch(err){setDeleteError(offline(err));}
  finally{if(live.current)setDeleting(false);}
 }
 const pending=saving||deleting||adding;
 return <section id={id} role="tabpanel" aria-labelledby={labelledBy} className="admin-panel">
  <header className="admin-head">
   <div><h1>Assigned numbers</h1><p>{rows===null?'Loading assignments…':`${rows.length} number${rows.length===1?'':'s'}${filter?' for '+who(filter):''}`}{updated>0&&<span> · Updated {new Date(updated).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>}</p></div>
   <div className="um-head-actions">
    <label className="an-filter"><span className="idle-sr">Show numbers for</span>
     <select value={filter} disabled={pending} onChange={e=>setFilter(e.target.value)}>
      <option value="">All users</option>
      {filter&&users&&!byName.has(filter)&&<option value={filter}>@{filter}</option>}
      {users?.map(u=><option key={u.id} value={u.username}>{u.name&&u.name!==u.username?`${u.name} (@${u.username})`:'@'+u.username}</option>)}
     </select></label>
    <button type="button" className="admin-refresh" disabled={pending} onClick={()=>{load();loadUsers();}}>Refresh</button>
    <button type="button" className="um-primary" disabled={pending||!users?.length} onClick={openAdd}>Assign contacts</button>
   </div>
  </header>
  {error&&<div className="admin-msg error" role="alert">{error}</div>}
  {note&&<div className="admin-msg" role="status">{note}</div>}
  {users&&!users.length&&<div className="admin-msg" role="status">There are no regular users yet. Register one before assigning numbers.</div>}
  {rows===null?<div className="admin-empty" aria-busy="true"><span className="admin-spin" aria-hidden="true"/>Loading…</div>
  :!rows.length?<div className="admin-empty"><h2>No assigned numbers</h2><p>{filter?`${who(filter)} has no numbers yet.`:'Assign a number to a user to get started.'}</p></div>
  :<div className="admin-table-wrap"><table className="admin-table">
   <caption className="idle-sr">Assigned numbers</caption>
   <thead><tr><th scope="col">ID</th><th scope="col">Phone</th><th scope="col">User</th><th scope="col"><span className="idle-sr">Actions</span></th></tr></thead>
   <tbody>{rows.map(row=>{const u=byName.get(row.username);
    return <tr key={row.id}>
     <th scope="row" data-label="ID" className="um-mono">{row.id}</th>
     <td data-label="Phone"><span className="admin-user"><ContactAvatar className="admin-avatar" contactId={String(row.phoneNumber)} fallback="#"/><span className="um-mono"><ContactHighlight id={String(row.phoneNumber)}>+{row.phoneNumber}</ContactHighlight></span></span></td>
     <td data-label="User"><span className="um-who"><strong>{u?.name||row.username}</strong><small>@{row.username}</small></span></td>
     <td><div className="an-actions">
      <button type="button" className="admin-refresh" disabled={pending} onClick={()=>openEdit(row)} aria-label={`Edit +${row.phoneNumber} for ${row.username}`}>Edit</button>
      <button type="button" className="admin-end" disabled={pending} onClick={()=>{setTarget(row);setDeleteError('');setNote('');}} aria-label={`Delete +${row.phoneNumber} for ${row.username}`}>Delete</button>
     </div></td>
    </tr>;})}</tbody>
  </table></div>}
  <dialog ref={formDialog} className="idle-dialog um-dialog" aria-labelledby="an-form-title" onCancel={e=>{if(saving)e.preventDefault();else setForm(null);}} onClose={()=>setForm(null)}>
   {form&&<form onSubmit={save} noValidate>
    <h2 id="an-form-title">{form.row?'Edit assigned number':'Assign a number'}</h2>
    <div className="an-fields">
     <label className="um-field">Phone number
      <input type="tel" inputMode="tel" autoComplete="off" value={form.phone} disabled={saving} placeholder="+92 300 1234567" aria-invalid={!!form.phone&&!phoneValid} aria-describedby="an-phone-hint"
       onChange={e=>setForm(f=>({...f,phone:e.target.value}))} autoFocus/>
      <small id="an-phone-hint" className={form.phone&&!phoneValid?'um-error':undefined}>{form.phone&&!phoneValid?'Enter the country code and number: up to 15 digits, not starting with 0.':'Include the country code. Spaces, dashes and brackets are fine.'}</small>
     </label>
     <label className="um-field">User
      <select value={form.username} disabled={saving} onChange={e=>setForm(f=>({...f,username:e.target.value}))}>
       <option value="" disabled>Choose a user</option>
       {form.username&&!byName.has(form.username)&&<option value={form.username}>@{form.username}</option>}
       {users?.map(u=><option key={u.id} value={u.username}>{u.name&&u.name!==u.username?`${u.name} (@${u.username})`:'@'+u.username}</option>)}
      </select>
     </label>
    </div>
    {formError&&<p className="idle-error" role="alert">{formError}</p>}
    {form.row&&!formError&&phoneValid&&!Object.keys(changes).length&&<p className="an-hint" role="status">No changes yet.</p>}
    <div className="idle-actions">
     <button type="button" className="idle-leave" disabled={saving} onClick={()=>setForm(null)}>Cancel</button>
     <button type="submit" className="um-primary" disabled={!canSave}>{saving?'Saving…':form.row?'Save':'Assign'}</button>
    </div>
   </form>}
  </dialog>
  {adding&&users&&<AssignContacts users={users} initialUsername={filter} handled={handled} onClose={closeAdd}/>}
  <dialog ref={deleteDialog} className="idle-dialog um-dialog" aria-labelledby="an-del-title" aria-describedby="an-del-desc" onCancel={e=>{if(deleting)e.preventDefault();else setTarget(null);}} onClose={()=>setTarget(null)}>
   {target&&<>
    <h2 id="an-del-title">Remove +{target.phoneNumber}?</h2>
    <p id="an-del-desc">{who(target.username)} (@{target.username}) will no longer see this number in their chat sidebar.</p>
    {deleteError&&<p className="idle-error" role="alert">{deleteError}</p>}
    <div className="idle-actions">
     <button type="button" className="idle-leave" disabled={deleting} onClick={()=>setTarget(null)}>Cancel</button>
     <button type="button" className="um-danger" disabled={deleting} onClick={confirmDelete}>{deleting?'Removing…':'Remove'}</button>
    </div>
   </>}
  </dialog>
 </section>;
}
