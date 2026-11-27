import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {authorizedFetch,checkSession} from './auth.js';
import {campaignClient,loadCampaigns} from './campaign-directory.js';
import {labelColor} from './business-labels.js';
import Dropdown from './components/Dropdown.jsx';
import Icon from './components/Icon.jsx';
import Initials from './components/Initials.jsx';
import './campaigns.css';
import Pagination,{pageQuery,useDebounced} from './components/Pagination.jsx';
// Admin / super-user tab: which campaign numbers (connected WhatsApp sessions)
// each regular user works in, and which WhatsApp Business labels they see there.
// Customers inside a campaign are assigned on the Assign Contacts tab.
const POLL=30000;
const offline=err=>err instanceof TypeError?'Could not reach the server. Check your connection and try again.':err.message;
const failure=async(response,fallback)=>{const body=await response.json().catch(()=>null);return Object.assign(new Error(typeof body?.error==='string'?body.error:fallback+' (HTTP '+response.status+').'),{status:response.status});};
const sameSet=(a,b)=>!!a&&!!b&&a.size===b.size&&[...a].every(x=>b.has(x));
const plural=(n,word)=>n+' '+word+(n===1?'':'s');
const shortDate=iso=>{const d=new Date(iso);return isNaN(d)?'':d.toLocaleDateString([],{day:'numeric',month:'short',year:d.getFullYear()===new Date().getFullYear()?undefined:'numeric'});};

// Every connected campaign with its grants (userId -> {labels, customers, assignedAt, assignedBy}) and labels.
async function loadDetails(signal){
 const {campaigns,disconnected}=await loadCampaigns(signal);
 const details=await Promise.all(campaigns.map(async campaign=>{
  const client=campaignClient(campaign);
  const [grants,labels]=await Promise.allSettled([client.grants(signal),client.labels(signal)]);
  // The grants response names the number the server sees right now.
  const phone=grants.status==='fulfilled'&&grants.value?.phone||campaign.phone;
  return {...campaign,phone,
   grants:grants.status==='fulfilled'?new Map((grants.value?.grants??[]).map(g=>[g.userId,{...g,labels:Array.isArray(g.labels)?g.labels:null}])):null,
   grantsError:grants.status==='rejected'?offline(grants.reason):'',
   labels:labels.status==='fulfilled'?labels.value:null,
   labelsError:labels.status==='rejected'?offline(labels.reason):''};
 }));
 return {details,disconnected};
}

function LabelDot({campaign,id}){
 const label=campaign.labels?.find(l=>l.id===id);
 return <span className={'cp-label'+(label?'':' missing')}><i style={label?{background:labelColor(label)}:undefined}/>{label?.name||'Unavailable label'}</span>;
}

export default function AssignCampaigns({id,labelledBy,onForbidden}){
 const [users,setUsers]=useState(null);const[campaigns,setCampaigns]=useState(null);const[disconnected,setDisconnected]=useState(0);
 const [error,setError]=useState('');const[note,setNote]=useState('');const[updated,setUpdated]=useState(0);
 const [editing,setEditing]=useState(null); // {userId} for one user, {userId:null} to choose
 const [search,setSearch]=useState('');const query=useDebounced(search.trim().toLowerCase());const[focus,setFocus]=useState('');
 const [page,setPage]=useState(1);const[total,setTotal]=useState(0);const[summary,setSummary]=useState(null);const[fetching,setFetching]=useState(false);
 const [picker,setPicker]=useState(null); // every regular user, loaded when "Assign WA Num" opens
 const live=useRef(true),seq=useRef(0),shownView=useRef(''),known=useRef([]);
 const handled=useCallback(status=>{
  if(status===403){onForbidden();return true;}
  if(status===401){checkSession().catch(()=>{});return true;}
  return false;
 },[onForbidden]);
 // One page of regular users (searched and, with a number card chosen, limited to
 // that number's users on the server) plus every campaign's grants and labels.
 const load=useCallback(async()=>{
  const mine=++seq.current,view=[page,query,focus].join('|');
  if(view!==shownView.current)setFetching(true);
  try{
   const card=known.current.find(c=>c.name===focus);
   const params=pageQuery(page,query,{role:'user',...(card?{campaign:card.name,campaignPhone:card.phone}:{})});
   const [response,{details,disconnected}]=await Promise.all([authorizedFetch('/api/admin/users?'+params,{cache:'no-store'}),loadDetails()]);
   if(!live.current||mine!==seq.current||handled(response.status))return;
   if(!response.ok)throw await failure(response,'The user list could not be loaded');
   const body=await response.json();if(!live.current||mine!==seq.current)return;
   if(body.total>0&&body.page>body.pages){setPage(body.pages);return;}
   shownView.current=view;known.current=details;
   setUsers(Array.isArray(body?.users)?body.users:[]);setTotal(body.total??0);setSummary(body.summary??null);
   setCampaigns(details);setDisconnected(disconnected);setError('');setUpdated(Date.now());
  }catch(err){if(live.current&&mine===seq.current&&!handled(err.status))setError(offline(err));}
  finally{if(live.current&&mine===seq.current)setFetching(false);}
 },[handled,page,query,focus]);
 useEffect(()=>{live.current=true;return ()=>{live.current=false;};},[]);
 useEffect(()=>{
  load();
  const shown=()=>{if(document.visibilityState==='visible')load();};
  const poll=setInterval(()=>{if(document.visibilityState==='visible'&&!editing)load();},POLL);
  document.addEventListener('visibilitychange',shown);
  return ()=>{clearInterval(poll);document.removeEventListener('visibilitychange',shown);};
 },[load,editing]);
 const close=useCallback((message,changed)=>{setEditing(null);setPicker(null);if(message)setNote(message);if(changed)void load();},[load]);
 // "Assign WA Num" lists every regular user, not just this page.
 async function openNew(){
  setNote('');
  try{
   const response=await authorizedFetch('/api/admin/users?role=user',{cache:'no-store'});
   if(handled(response.status))return;
   if(!response.ok)throw await failure(response,'The user list could not be loaded');
   const list=(await response.json()).users??[];
   list.sort((a,b)=>String(a.name||a.username).localeCompare(String(b.name||b.username)));
   setPicker(list);setEditing({userId:null});
  }catch(err){setError(offline(err));}
 }
 const loading=users===null||campaigns===null;
 const holds=(u,c)=>!!c.grants?.has(u.id);
 const regularTotal=summary?.total??0;
 // Distinct users holding at least one connected number.
 const assignedCount=useMemo(()=>loading?0:Math.min(regularTotal,new Set(campaigns.flatMap(c=>c.grants?[...c.grants.keys()]:[])).size),[loading,campaigns,regularTotal]);
 const rows=users??[];
 const focused=campaigns?.find(c=>c.name===focus);
 return <section id={id} role="tabpanel" aria-labelledby={labelledBy} className="admin-panel cp-panel">
  <header className="admin-head">
   <div><h1>Assign WA Num</h1><p>Choose the campaign numbers each user works in, and the labels they see there.{updated>0&&<span className="cp-updated"> · Updated {new Date(updated).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>}</p></div>
   <div className="um-head-actions">
    <button type="button" className="admin-refresh" disabled={!!editing} onClick={load}>Refresh</button>
    <button type="button" className="um-primary cp-cta" disabled={!!editing||loading||!regularTotal||!campaigns.length} onClick={openNew}><Icon name="plus" size={16}/>Assign WA Num</button>
   </div>
  </header>
  {error&&<div className="admin-msg error" role="alert">{error}</div>}
  {note&&<div className="admin-msg" role="status">{note}</div>}
  {campaigns?.filter(c=>c.grantsError).map(c=><div key={c.name} className="admin-msg error" role="alert">{c.name}: {c.grantsError}</div>)}
  {loading?<div className="cp-skeleton" aria-busy="true" aria-label="Loading campaigns"><i/><i/><i/><b/><b/><b/></div>
  :<>
   <div className="cp-stats">
    <div className="cp-stat"><span className="cp-stat-icon"><Icon name="phone" size={18}/></span><div><strong>{campaigns.length}</strong><small>Connected {campaigns.length===1?'number':'numbers'}{disconnected>0&&<em> · {disconnected} offline</em>}</small></div></div>
    <div className="cp-stat"><span className="cp-stat-icon"><Icon name="users" size={18}/></span><div><strong>{assignedCount}<span>/{regularTotal}</span></strong><small>Users with a campaign</small></div></div>
    <div className={'cp-stat'+(regularTotal-assignedCount?' warn':' good')}><span className="cp-stat-icon"><Icon name={regularTotal-assignedCount?'userPlus':'check'} size={18}/></span><div><strong>{regularTotal-assignedCount}</strong><small>{regularTotal-assignedCount?'Waiting for a campaign':'Everyone is assigned'}</small></div></div>
   </div>
   {disconnected>0&&<div className="admin-msg" role="status">{plural(disconnected,'WhatsApp number')} {disconnected===1?'is':'are'} not connected. Reconnect on the Add Number tab to assign {disconnected===1?'it':'them'}.</div>}
   {!campaigns.length?<div className="admin-empty"><span className="cp-empty-icon"><Icon name="phone" size={28}/></span><h2>No connected numbers</h2><p>Connect a WhatsApp number on the Add Number tab, then assign it here.</p></div>
   :!regularTotal?<div className="admin-empty"><span className="cp-empty-icon"><Icon name="userPlus" size={28}/></span><h2>No regular users yet</h2><p>Register a user, then give them a campaign number here.</p></div>
   :<>
    <div className="cp-toolbar">
     <label className="cp-search"><Icon name="search" size={16}/><span className="idle-sr">Search users</span>
      <input type="search" value={search} placeholder="Search users" onChange={e=>{setSearch(e.target.value);setPage(1);}}/></label>
     {/* A visible label in front of the number pills, like the filters on Whatix AI and Assign Contacts. */}
     <div className="an-field cp-numbers-field"><span aria-hidden="true">WA numbers</span>
     <ul className="cp-numbers" aria-label="WA numbers. Choose one to show only its users.">
      {campaigns.map(c=>{const count=c.grants?.size??0,on=focus===c.name,labels=c.labels?.length;
       const about=`${c.name} · ${plural(count,'user')}${labels==null?'':' · '+plural(labels,'label')}`;
       return <li key={c.name}><button type="button" className="cp-number" aria-pressed={on} title={on?'Show every user':about}
        aria-label={`+${c.phone}, ${about}${on?'. Showing only its users':''}`} onClick={()=>{setFocus(f=>f===c.name?'':c.name);setPage(1);}}>
        <span className="cp-tile"><Icon name="phone" size={14}/></span><strong>+{c.phone}</strong>
        <span className="cp-number-count" aria-hidden="true"><Icon name="users" size={12}/>{count}</span>
        {on&&<Icon name="close" size={13}/>}
       </button></li>;})}
     </ul></div>
     <small className="cp-count" role="status">{query||focused?`${total} of ${regularTotal} users`:plural(regularTotal,'user')}</small>
    </div>
    {!rows.length?<div className="admin-empty cp-none"><h2>No users match</h2><p>{focused?`Nobody has +${focused.phone} yet.`:'Try another name.'}</p></div>
    :<><div className={'admin-table-wrap'+(fetching?' grid-loading':'')} aria-busy={fetching}><table className="admin-table cp-table">
     <caption className="idle-sr">Campaigns assigned to each user</caption>
     <thead><tr><th scope="col">User</th><th scope="col">Campaign numbers</th><th scope="col"><span className="idle-sr">Actions</span></th></tr></thead>
     <tbody>{rows.map(u=>{const mine=campaigns.filter(c=>holds(u,c));
      return <tr key={u.id}>
       <th scope="row" data-label="User"><span className="cp-user"><Initials name={u.name||u.username}/><span className="um-who"><strong>{u.name||u.username}</strong><small>@{u.username}</small></span></span></th>
       <td data-label="Campaign numbers">{!mine.length?<span className="cp-chip cp-chip-none"><Icon name="userPlus" size={15}/>No campaign yet · sees no chats</span>
        :<ul className="cp-chips">{mine.map(c=>{const g=c.grants.get(u.id);
         return <li key={c.name} className="cp-chip">
          <span className="cp-chip-top"><Icon name="phone" size={14}/><strong>+{c.phone}</strong><small>{c.name}</small></span>
          <span className="cp-chip-foot"><span className="cp-chip-labels">{g.labels===null?<span className="cp-label all"><Icon name="tag" size={12}/>All labels</span>
           :g.labels.length?g.labels.map(l=><LabelDot key={l} campaign={c} id={l}/>):<span className="cp-muted">No labels</span>}</span>
          <span className="cp-chip-meta">{plural(g.customers??0,'customer')}{g.assignedBy&&<> · by {g.assignedBy}</>}{g.assignedAt&&<> · {shortDate(g.assignedAt)}</>}</span></span>
         </li>;})}</ul>}</td>
       <td><div className="an-actions"><button type="button" className="admin-refresh cp-manage" disabled={!!editing} onClick={()=>{setEditing({userId:u.id});setNote('');}}
        aria-label={`${mine.length?'Change':'Assign'} campaigns for ${u.username}`}>{mine.length?'Manage':'Assign'}</button></div></td>
      </tr>;})}</tbody>
    </table></div>
    <Pagination page={page} total={total} onPage={setPage} disabled={fetching} noun="users"/></>}
   </>}
  </>}
  {editing&&campaigns&&<CampaignEditor users={editing.userId===null?picker??[]:rows.filter(u=>u.id===editing.userId)} campaigns={campaigns}
   initialUserId={editing.userId} handled={handled} onClose={close}/>}
 </section>;
}

function CampaignEditor({users,campaigns,initialUserId,handled,onClose}){
 const dialog=useRef(null),live=useRef(true);
 const [userId,setUserId]=useState(initialUserId);
 // Per number: null for every label, or the Set of labels the user is limited to.
 const granted=useCallback(uid=>new Map(campaigns.filter(c=>c.grants?.has(uid)).map(c=>{
  const labels=c.grants.get(uid).labels;return [c.name,labels===null?null:new Set(labels)];})),[campaigns]);
 const [picks,setPicks]=useState(()=>granted(initialUserId));
 const [busy,setBusy]=useState(false);const[errors,setErrors]=useState(new Map());const[changed,setChanged]=useState(false);
 useEffect(()=>{live.current=true;dialog.current.showModal();return ()=>{live.current=false;};},[]);
 const user=users.find(u=>u.id===userId);
 const who=user?user.name||user.username:'';
 function chooseUser(value){const uid=Number(value)||null;setUserId(uid);setPicks(granted(uid));setErrors(new Map());}
 // A newly added number shows every label until the admin limits it.
 function toggleCampaign(name,on){setPicks(prev=>{const next=new Map(prev);on?next.set(name,null):next.delete(name);return next;});}
 function setScope(campaign,limited){setPicks(prev=>new Map(prev).set(campaign.name,limited?new Set(campaign.grants?.get(userId)?.labels??[]):null));}
 function toggleLabel(name,labelId,on){setPicks(prev=>{const next=new Map(prev),set=new Set(next.get(name));on?set.add(labelId):set.delete(labelId);next.set(name,set);return next;});}
 function setAll(campaign,on){setPicks(prev=>new Map(prev).set(campaign.name,new Set(on?campaign.labels.map(l=>l.id):[])));}
 // Labels are compared only for a number the user both holds and keeps; a
 // number they neither hold nor picked (e.g. a first assignment) needs nothing.
 const plan=user?campaigns.filter(c=>c.grants).flatMap(c=>{
  const held=c.grants.has(user.id),on=picks.has(c.name);
  if(!on)return held?[{campaign:c,method:'DELETE'}]:[];
  const before=c.grants.get(user.id)?.labels,after=picks.get(c.name);
  const put=[{campaign:c,method:'PUT',labels:after===null?null:[...after]}];
  if(!held)return put;
  const same=before===null||after===null?before===after:sameSet(new Set(before),after);
  return same?[]:put;
 }):[];
 const removals=plan.filter(step=>step.method==='DELETE');
 const lost=removals.reduce((n,r)=>n+(r.campaign.grants.get(user.id)?.customers??0),0);
 async function save(e){
  e.preventDefault();if(busy||!plan.length)return;
  setBusy(true);setErrors(new Map());
  const failed=new Map();let applied=0;
  for(const step of plan){
   const client=campaignClient(step.campaign);
   try{
    const response=await client.write(step.method,'/api/campaign-grants/'+user.id,step.method==='PUT'?{labels:step.labels}:undefined);
    if(handled(response.status))return;
    if(response.ok){applied++;continue;}
    failed.set(step.campaign.name,(await failure(response,'Could not save this campaign')).message);
   }catch(err){failed.set(step.campaign.name,offline(err));}
  }
  if(!live.current)return;
  setBusy(false);
  if(applied)setChanged(true);
  if(failed.size){setErrors(failed);return;}
  onClose(`Saved campaigns for ${who}.`,true);
 }
 const cancel=()=>{if(!busy)onClose(changed?`Some campaign changes for ${who} were saved.`:'',changed);};
 return <dialog ref={dialog} className="idle-dialog um-dialog cp-dialog" aria-labelledby="cp-title" onCancel={e=>{e.preventDefault();cancel();}}>
  <form onSubmit={save} noValidate>
   <header className="cp-dialog-head">
    {user?<Initials name={who} size={44}/>:<span className="cp-tile big"><Icon name="campaign" size={22}/></span>}
    <div><h2 id="cp-title">{user?who:'Assign WA Num'}</h2><p>{user?'@'+user.username+' · '+plural(picks.size,'campaign number')+' selected':'Choose a user, then the numbers they work in.'}</p></div>
   </header>
   {!initialUserId&&<label className="um-field">User
    <Dropdown label="User" value={userId??''} disabled={busy} onChange={chooseUser} placeholder="Choose a user" searchPlaceholder="Search users"
     options={users.map(u=>({value:u.id,label:u.name||u.username,description:'@'+u.username+(campaigns.some(c=>c.grants?.has(u.id))?'':' · no campaign yet'),icon:'person'}))}/></label>}
   <fieldset className="cp-options" disabled={busy||!user}>
    <legend>Campaign numbers</legend>
    {campaigns.map(c=>{const on=picks.has(c.name),chosen=picks.get(c.name),limited=chosen instanceof Set,err=errors.get(c.name);
     const customers=user?c.grants?.get(user.id)?.customers??0:0;
     const missing=limited?[...chosen].filter(labelId=>!c.labels?.some(l=>l.id===labelId)):[];
     return <div key={c.name} className={'cp-option'+(on?' on':'')+(c.grants?'':' unavailable')}>
      <label className="cp-option-head">
       <span className="cp-tile"><Icon name="phone" size={18}/></span>
       <span className="cp-number-main"><strong>+{c.phone}</strong><small>{c.name}{customers>0&&' · '+plural(customers,'customer')+' assigned'}</small></span>
       <span className="um-switch cp-switch"><input type="checkbox" role="switch" checked={on} disabled={!c.grants} onChange={e=>toggleCampaign(c.name,e.target.checked)}
        aria-label={`${who||'User'} works in +${c.phone}`}/><span/></span>
      </label>
      {!c.grants&&<small className="um-error">{c.grantsError||'Unavailable'}</small>}
      {on&&<div className="cp-option-body">
       <div className="cp-option-caption"><span><Icon name="tag" size={14}/>Labels {who||'they'} can see</span>
        <span className="cp-scope" role="radiogroup" aria-label={`Labels in +${c.phone}`}>
         <button type="button" role="radio" aria-checked={!limited} onClick={()=>setScope(c,false)}>All labels</button>
         <button type="button" role="radio" aria-checked={limited} onClick={()=>setScope(c,true)}>Only selected</button>
        </span></div>
       {!limited?<small className="cp-muted cp-scope-note">{c.labels?.length?`Every label on this number (${c.labels.length}), including labels created later.`:'Every label on this number, including labels created later.'}</small>
       :<>{c.labels?.length>1&&<button type="button" className="cp-link cp-select-all" onClick={()=>setAll(c,chosen.size<c.labels.length)}>{chosen.size<c.labels.length?'Select all':'Clear'}</button>}
       <div className="cp-label-grid" role="group" aria-label={`Chosen labels in +${c.phone}`}>
        {c.labels===null?<small className="um-error">{c.labelsError||'Labels unavailable.'}</small>
        :!c.labels.length&&!missing.length?<small className="cp-muted">This number has no WhatsApp Business labels yet.</small>
        :<>
         {c.labels.map(l=><label key={l.id} className="cp-label-pick"><input type="checkbox" checked={chosen.has(l.id)} onChange={e=>toggleLabel(c.name,l.id,e.target.checked)}/>
          <i style={{background:labelColor(l)}}/>{l.name||'Label '+l.id}<Icon name="check" size={14}/></label>)}
         {missing.map(labelId=><label key={labelId} className="cp-label-pick missing"><input type="checkbox" checked onChange={()=>toggleLabel(c.name,labelId,false)}/><i/>Unavailable label<Icon name="close" size={14}/></label>)}
        </>}
       </div>
       {limited&&!chosen.size&&<small className="cp-muted">With no label chosen, {who||'the user'} sees no labels on this number.</small>}</>}
      </div>}
      {err&&<small className="um-error" role="alert">{err}</small>}
     </div>;})}
   </fieldset>
   {user&&<p className="cp-note"><Icon name="contacts" size={15}/>{who} sees only the customers assigned to them in each number. Picking a label narrows those customers; a bulk send to a label reaches only them.</p>}
   {removals.length>0&&<p className="idle-error" role="status">Turning off {removals.map(r=>'+'+r.campaign.phone).join(', ')} also removes {lost?plural(lost,'customer')+' assigned to '+who:'its customer assignments'}.</p>}
   {errors.size>0&&<p className="idle-error" role="alert">{plural(errors.size,'campaign')} could not be saved. Fix the problem and save again.</p>}
   <div className="idle-actions">
    <button type="button" className="idle-leave" disabled={busy} onClick={cancel}>Cancel</button>
    <button type="submit" className="um-primary" disabled={busy||!user||!plan.length}>{busy?'Saving…':plan.length?'Save changes':'No changes'}</button>
   </div>
  </form>
 </dialog>;
}
