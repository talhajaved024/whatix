import {ContactHighlight} from "./components/LabelHighlights.jsx";
import {useCallback,useEffect,useRef,useState} from 'react';
import {authorizedFetch,checkSession} from './auth.js';
import {SESSION,useInboxSession} from './inbox.js';
import {campaignClient,loadCampaigns} from './campaign-directory.js';
import ContactAvatar from './components/ContactAvatar.jsx';
import AssignContacts from './components/AssignContacts.jsx';
import Dropdown from './components/Dropdown.jsx';
import Icon from './components/Icon.jsx';
import Initials from './components/Initials.jsx';
import './campaigns.css';
import Pagination,{pageQuery,useDebounced} from './components/Pagination.jsx';
// Admin / super-user tab: which customers each regular user handles inside one
// campaign number. A user must have the campaign (Assign WA Num tab) first;
// the backend answers 422 otherwise.
const POLL=30000,PHONE=/^[1-9]\d{0,14}$/;
const offline=err=>err instanceof TypeError?'Could not reach the server. Check your connection and try again.':err.message;
const failure=async(response,fallback)=>{const body=await response.json().catch(()=>null);return Object.assign(new Error(typeof body?.error==='string'?body.error:fallback+' (HTTP '+response.status+').'),{status:response.status});};
// "+92 300 123-4567" → "923001234567"
export const phoneDigits=value=>String(value??'').replace(/[+\s()\-]/g,'');
const userOption=u=>({value:u.username,label:u.name||u.username,description:'@'+u.username,icon:'person'});
const when=iso=>{const d=new Date(iso);return isNaN(d)?'':d.toLocaleDateString([],{day:'numeric',month:'short',year:d.getFullYear()===new Date().getFullYear()?undefined:'numeric'});};
export default function AssignedNumbers({id,labelledBy,onForbidden}){
 const [campaigns,setCampaigns]=useState(null);const[selected,setSelected]=useState('');
 const [rows,setRows]=useState(null);const[users,setUsers]=useState(null);const[grantees,setGrantees]=useState(null);const[filter,setFilter]=useState('');
 const [error,setError]=useState('');const[note,setNote]=useState('');const[updated,setUpdated]=useState(0);
 const [form,setForm]=useState(null);const[formError,setFormError]=useState('');const[saving,setSaving]=useState(false);
 const [adding,setAdding]=useState(false);
 const [target,setTarget]=useState(null);const[deleting,setDeleting]=useState(false);const[deleteError,setDeleteError]=useState('');
 const [page,setPage]=useState(1);const[search,setSearch]=useState('');const query=useDebounced(search.trim());
 const [total,setTotal]=useState(0);const[fetching,setFetching]=useState(false);
 const live=useRef(true),seq=useRef(0),shownView=useRef(''),formDialog=useRef(null),deleteDialog=useRef(null);
 const campaign=campaigns?.find(c=>c.name===selected)||null;
 // Follow the WA number chosen in the inbox picker (chat sidebar, Add Number tab): switching
 // there switches this tab and its Assign contacts list too. A choice made here still stands until then.
 const openInbox=useInboxSession();
 useEffect(()=>{setSelected(prev=>campaigns?.some(c=>c.name===openInbox)?openInbox:prev);setPage(1);},[openInbox]);
 const handled=useCallback(status=>{
  if(status===403){onForbidden();return true;}
  if(status===401){checkSession().catch(()=>{});return true;}
  return false;
 },[onForbidden]);
 // Connected campaign numbers; the inbox open in this tab is chosen first.
 const loadNumbers=useCallback(async()=>{
  try{
   const {campaigns:list}=await loadCampaigns();
   if(!live.current)return;
   setCampaigns(list);
   setSelected(prev=>list.some(c=>c.name===prev)?prev:(list.find(c=>c.name===SESSION)||list[0])?.name||'');
  }catch(err){if(live.current&&!handled(err.status))setError(offline(err));}
 },[handled]);
 const loadUsers=useCallback(async()=>{
  try{
   const response=await authorizedFetch('/api/admin/users',{cache:'no-store'});
   if(!live.current||handled(response.status))return;
   if(!response.ok)throw await failure(response,'The user list could not be loaded');
   const body=await response.json();if(!live.current)return;
   const list=(Array.isArray(body?.users)?body.users:[]).filter(u=>!u.isAdmin&&!u.isSuperUser);
   list.sort((a,b)=>String(a.name||a.username).localeCompare(String(b.name||b.username)));
   setUsers(list);
  }catch(err){if(live.current)setError(offline(err));}
 },[handled]);
 // The newest request wins, so a slow response for an old filter or campaign can't overwrite the current one.
 const load=useCallback(async()=>{
  if(!campaign)return;
  const mine=++seq.current,client=campaignClient(campaign),view=[campaign.name,filter,page,query].join('|');
  // Dim the grid only for a new page, search or filter, not for background refreshes.
  if(view!==shownView.current)setFetching(true);
  try{
   const [response,grants]=await Promise.all([
    authorizedFetch(client.url('/api/campaign-contacts?'+pageQuery(page,query,filter?{username:filter}:{})),{cache:'no-store'}),
    client.grants()]);
   if(!live.current||mine!==seq.current||handled(response.status))return;
   if(!response.ok)throw await failure(response,'The assigned numbers could not be loaded');
   const body=await response.json();if(!live.current||mine!==seq.current)return;
   // The number can change if the session is paired to another phone; writes must name the current one.
   if(body.phone&&body.phone!==campaign.phone)setCampaigns(list=>list.map(c=>c.name===campaign.name?{...c,phone:body.phone}:c));
   // Assignments removed elsewhere can leave this page past the end.
   if(body.total>0&&body.page>body.pages){setPage(body.pages);return;}
   shownView.current=view;
   setRows(Array.isArray(body?.assignments)?body.assignments:[]);setTotal(body.total??0);
   setGrantees(new Set((grants?.grants??[]).map(g=>g.userId)));setError('');setUpdated(Date.now());
  }catch(err){if(live.current&&mine===seq.current&&!handled(err.status))setError(offline(err));}
  finally{if(live.current&&mine===seq.current)setFetching(false);}
 },[campaign,filter,page,query,handled]);
 useEffect(()=>{live.current=true;return ()=>{live.current=false;};},[]);
 useEffect(()=>{loadUsers();loadNumbers();},[loadUsers,loadNumbers]);
 // Restart on a different campaign, filter, page or search, not when only the campaign's phone was refreshed.
 const latest=useRef(load);latest.current=load;
 const ready=campaigns!==null;
 // A different campaign or user filter starts again from its first page.
 useEffect(()=>{setPage(1);setRows(null);setGrantees(null);},[selected,filter]);
 useEffect(()=>{
  latest.current();
  const shown=()=>{if(document.visibilityState==='visible'){latest.current();loadUsers();}};
  const poll=setInterval(()=>{if(document.visibilityState==='visible')latest.current();},POLL);
  document.addEventListener('visibilitychange',shown);
  return ()=>{clearInterval(poll);document.removeEventListener('visibilitychange',shown);};
 },[selected,filter,page,query,ready,loadUsers]);
 useEffect(()=>{const d=formDialog.current;if(!d)return;if(form&&!d.open)d.showModal();else if(!form&&d.open)d.close();},[form]);
 useEffect(()=>{const d=deleteDialog.current;if(!d)return;if(target&&!d.open)d.showModal();else if(!target&&d.open)d.close();},[target]);
 const byName=new Map((users??[]).map(u=>[u.username,u]));
 // Only users who have this campaign can receive its customers.
 const assignable=(users??[]).filter(u=>grantees?.has(u.id));
 const who=username=>{const u=byName.get(username);return u?.name&&u.name!==username?u.name:username;};
 function openAdd(){setAdding(true);setNote('');}
 function openEdit(row){setForm({row,phone:'+'+row.phoneNumber,username:row.username});setFormError('');setNote('');}
 const closeAdd=useCallback(message=>{setAdding(false);if(message){setNote(message);void load();}},[load]);
 const digits=form?phoneDigits(form.phone):'';
 const phoneValid=PHONE.test(digits);
 const changes=form?.row?{...(phoneValid&&Number(digits)!==form.row.phoneNumber?{phoneNumber:Number(digits)}:{}),...(form.username!==form.row.username?{username:form.username}:{})}:null;
 const canSave=!!form&&!saving&&phoneValid&&!!form.username&&(!form.row||Object.keys(changes).length>0);
 async function save(e){
  e.preventDefault();if(!canSave||!campaign)return;
  const editing=form.row,client=campaignClient(campaign);
  setSaving(true);setFormError('');
  try{
   const response=await client.write('PATCH','/api/campaign-contacts/'+encodeURIComponent(editing.id),changes);
   if(handled(response.status)){setForm(null);return;}
   if(response.status===404){setForm(null);setNote('That assignment no longer exists.');await load();return;}
   if(!response.ok)throw await failure(response,'Could not update the assignment');
   const row=await response.json().catch(()=>null);
   setForm(null);
   setNote(`Updated +${row?.phoneNumber??digits} for ${who(form.username)}.`);
   await load();
  }catch(err){setFormError(offline(err));}
  finally{if(live.current)setSaving(false);}
 }
 async function confirmDelete(){
  if(!target||deleting||!campaign)return;const row=target;
  setDeleting(true);setDeleteError('');
  try{
   const response=await campaignClient(campaign).write('DELETE','/api/campaign-contacts/'+encodeURIComponent(row.id));
   if(handled(response.status)){setTarget(null);return;}
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
   <div><h1>Assign Contacts</h1><p>{!campaign?(campaigns===null?'Loading campaigns…':'No connected campaign number'):rows===null?'Loading assignments…':`${total} customer${total===1?'':'s'} in +${campaign.phone}${filter?' for '+who(filter):''}`}{updated>0&&<span className="cp-updated"> · Updated {new Date(updated).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>}</p></div>
   <div className="um-head-actions">
    <button type="button" className="admin-refresh" disabled={pending} onClick={()=>{loadNumbers();load();loadUsers();}}>Refresh</button>
    <button type="button" className="um-primary cp-cta" disabled={pending||!campaign||!assignable.length} onClick={openAdd}><Icon name="plus" size={16}/>Assign contacts</button>
   </div>
  </header>
  <div className="cp-toolbar an-toolbar">
   {/* Visible labels sit in front of each filter; the dropdown's own aria-label already says the same words. */}
   <span className="an-field"><span aria-hidden="true">WA number</span>
    <Dropdown variant="pill" icon="phone" label="WA number" value={selected} disabled={pending||!campaigns?.length} menuMinWidth={260}
     placeholder={campaigns?'No connected numbers':'Loading numbers…'} searchPlaceholder="Search numbers" onChange={value=>{setSelected(value);setNote('');}}
     options={(campaigns??[]).map(c=>({value:c.name,label:'+'+c.phone,description:c.name,icon:'phone'}))}/></span>
   <span className="an-field"><span aria-hidden="true">Customers for</span>
    <Dropdown variant="pill" icon="users" label="Customers for" value={filter} disabled={pending} menuMinWidth={240} searchPlaceholder="Search users" onChange={setFilter}
     options={[{value:'',label:'All users',icon:'users'},...(filter&&users&&!byName.has(filter)?[{value:filter,label:'@'+filter}]:[]),...(users??[]).map(userOption)]}/></span>
   <label className="cp-search"><Icon name="search" size={16}/><span className="idle-sr">Search customers by number</span>
    <input type="search" inputMode="tel" value={search} placeholder="Search customer number" onChange={e=>{setSearch(e.target.value);setPage(1);}}/></label>
   {campaign&&grantees&&<small className="cp-count">{assignable.length} of {users?.length??0} users work in this number</small>}
  </div>
  {error&&<div className="admin-msg error" role="alert">{error}</div>}
  {note&&<div className="admin-msg" role="status">{note}</div>}
  {users&&!users.length&&<div className="admin-msg" role="status">There are no regular users yet. Register one before assigning numbers.</div>}
  {campaign&&users?.length>0&&grantees&&!assignable.length&&<div className="admin-msg" role="status">No user has +{campaign.phone} yet. Assign this campaign to a user on the Assign WA Num tab first.</div>}
  {campaigns&&!campaigns.length?<div className="admin-empty"><h2>No connected numbers</h2><p>Connect a WhatsApp number on the Add Number tab, then assign it on the Assign WA Num tab.</p></div>
  :rows===null?<div className="admin-empty" aria-busy="true"><span className="admin-spin" aria-hidden="true"/>Loading…</div>
  :!rows.length?<div className="admin-empty"><span className="cp-empty-icon"><Icon name="contacts" size={28}/></span>{query?<><h2>No customers match</h2><p>No assigned customer number contains “{query}”.</p></>:<><h2>No assigned numbers</h2><p>{filter?`${who(filter)} has no customers in this campaign yet.`:'Assign customers of this campaign number to a user to get started.'}</p></>}</div>
  :<><div className={'admin-table-wrap'+(fetching?' grid-loading':'')} aria-busy={fetching}><table className="admin-table cp-table">
   <caption className="idle-sr">Customers assigned in +{campaign.phone}</caption>
   <thead><tr><th scope="col">Customer</th><th scope="col">Handled by</th><th scope="col">Assigned</th><th scope="col"><span className="idle-sr">Actions</span></th></tr></thead>
   <tbody>{rows.map(row=>{const u=byName.get(row.username);
    return <tr key={row.id}>
     <th scope="row" data-label="Customer"><span className="admin-user"><ContactAvatar className="admin-avatar" contactId={String(row.phoneNumber)} session={campaign?.name} fallback="#"/><span className="um-mono an-phone"><ContactHighlight id={String(row.phoneNumber)}>+{row.phoneNumber}</ContactHighlight></span></span></th>
     <td data-label="Handled by"><span className="cp-user"><Initials name={u?.name||row.username} size={30}/><span className="um-who"><strong>{u?.name||row.username}</strong><small>@{row.username}</small></span></span></td>
     <td data-label="Assigned"><span className="um-who an-when">{row.assignedAt?<><strong>{when(row.assignedAt)}</strong><small>{row.assignedBy?'by '+row.assignedBy:' '}</small></>:<small>Before tracking began</small>}</span></td>
     <td><div className="an-actions">
      <button type="button" className="admin-refresh" disabled={pending} onClick={()=>openEdit(row)} aria-label={`Edit +${row.phoneNumber} for ${row.username}`}>Edit</button>
      <button type="button" className="admin-end" disabled={pending} onClick={()=>{setTarget(row);setDeleteError('');setNote('');}} aria-label={`Delete +${row.phoneNumber} for ${row.username}`}>Delete</button>
     </div></td>
    </tr>;})}</tbody>
  </table></div>
  <Pagination page={page} total={total} onPage={setPage} disabled={fetching} noun="customers"/></>}
  <dialog ref={formDialog} className="idle-dialog um-dialog" aria-labelledby="an-form-title" onCancel={e=>{if(saving)e.preventDefault();else setForm(null);}} onClose={()=>setForm(null)}>
   {form&&<form onSubmit={save} noValidate>
    <h2 id="an-form-title">Edit assigned number</h2>
    {campaign&&<p className="an-hint">Campaign +{campaign.phone} · {campaign.name}</p>}
    <div className="an-fields">
     <label className="um-field">Customer phone number
      <input type="tel" inputMode="tel" autoComplete="off" value={form.phone} disabled={saving} placeholder="+92 300 1234567" aria-invalid={!!form.phone&&!phoneValid} aria-describedby="an-phone-hint"
       onChange={e=>setForm(f=>({...f,phone:e.target.value}))} autoFocus/>
      <small id="an-phone-hint" className={form.phone&&!phoneValid?'um-error':undefined}>{form.phone&&!phoneValid?'Enter the country code and number: up to 15 digits, not starting with 0.':'Include the country code. Spaces, dashes and brackets are fine.'}</small>
     </label>
     <label className="um-field">User
      <Dropdown label="User" value={form.username} disabled={saving} placeholder="Choose a user" searchPlaceholder="Search users"
       onChange={username=>setForm(f=>({...f,username}))}
       options={[...(form.username&&!assignable.some(u=>u.username===form.username)?[{value:form.username,label:'@'+form.username}]:[]),...assignable.map(userOption)]}/>
     </label>
    </div>
    {formError&&<p className="idle-error" role="alert">{formError}</p>}
    {!formError&&phoneValid&&!Object.keys(changes).length&&<p className="an-hint" role="status">No changes yet.</p>}
    <div className="idle-actions">
     <button type="button" className="idle-leave" disabled={saving} onClick={()=>setForm(null)}>Cancel</button>
     <button type="submit" className="um-primary" disabled={!canSave}>{saving?'Saving…':'Save'}</button>
    </div>
   </form>}
  </dialog>
  {adding&&campaign&&<AssignContacts users={assignable} campaign={campaign} initialUsername={assignable.some(u=>u.username===filter)?filter:''} handled={response=>handled(response.status)} onClose={closeAdd}/>}
  <dialog ref={deleteDialog} className="idle-dialog um-dialog" aria-labelledby="an-del-title" aria-describedby="an-del-desc" onCancel={e=>{if(deleting)e.preventDefault();else setTarget(null);}} onClose={()=>setTarget(null)}>
   {target&&<>
    <h2 id="an-del-title">Remove +{target.phoneNumber}?</h2>
    <p id="an-del-desc">{who(target.username)} (@{target.username}) will no longer see this customer in {campaign?'+'+campaign.phone:'this campaign'}.</p>
    {deleteError&&<p className="idle-error" role="alert">{deleteError}</p>}
    <div className="idle-actions">
     <button type="button" className="idle-leave" disabled={deleting} onClick={()=>setTarget(null)}>Cancel</button>
     <button type="button" className="um-danger" disabled={deleting} onClick={confirmDelete}>{deleting?'Removing…':'Remove'}</button>
    </div>
   </>}
  </dialog>
 </section>;
}
