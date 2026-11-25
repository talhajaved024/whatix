import {useCallback,useEffect,useRef,useState} from 'react';
import {authorizedFetch,checkSession} from './auth.js';
import UserProfile from './UserProfile.jsx';
import ContactAvatar from './components/ContactAvatar.jsx';
// Super-user user directory: every account (online, offline, banned), ending sessions
// (optionally banning), and toggling a saved ban. Polling is a plain authorized GET, never counted as activity.
// Ids: the numeric account `id` addresses the account (ban); the opaque `sessionId` addresses one sign-in (end).
const POLL=10000,DASH='—';
const show=v=>v===null||v===undefined||v===''?DASH:String(v);
const date=v=>{if(v===null||v===undefined)return DASH;const d=new Date(v);return isNaN(d)?DASH:d.toLocaleString([],{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});};
const json=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const offline=err=>err instanceof TypeError?'Could not reach the server. Check your connection and try again.':err.message;
const failure=async(response,fallback)=>{const body=await response.json().catch(()=>null);return new Error(typeof body?.error==='string'?body.error:fallback+' (HTTP '+response.status+').');};
export default function Users({id,labelledBy,onForbidden,superUser,signedInUsername}){
 const [users,setUsers]=useState(null);const[error,setError]=useState('');const[note,setNote]=useState('');const[updated,setUpdated]=useState(0);
 const [saving,setSaving]=useState(()=>new Set());
 const [selected,setSelected]=useState(null);
 const [target,setTarget]=useState(null);const[ban,setBan]=useState(false);const[ending,setEnding]=useState(false);const[endError,setEndError]=useState('');
 const busy=useRef(null),live=useRef(true),dialog=useRef(null);
 // 401: authorizedFetch already tried one refresh; checkSession settles it (back to login when the session is gone).
 const handled=useCallback(response=>{
  if(response.status===403){onForbidden();return true;}
  if(response.status===401){checkSession().catch(()=>{});return true;}
  return false;
 },[onForbidden]);
 const load=useCallback(()=>{
  busy.current??=(async()=>{
   try{
    const response=await authorizedFetch('/api/admin/users',{cache:'no-store'});
    if(!live.current||handled(response))return;
    if(!response.ok)throw await failure(response,'The user directory could not be loaded');
    const body=await response.json();if(!live.current)return;
    const list=Array.isArray(body?.users)?body.users:[];
    list.sort((a,b)=>(b.isSuperUser-a.isSuperUser)||(b.isAdmin-a.isAdmin)||((b.sessionId!=null)-(a.sessionId!=null))||String(a.name??a.username).localeCompare(String(b.name??b.username)));
    setUsers(list);setError('');setUpdated(Date.now());
   }catch(err){if(live.current)setError(offline(err));}
  })().finally(()=>busy.current=null);
  return busy.current;
 },[handled]);
 const refreshAfterChange=useCallback(async()=>{
  await busy.current;
  if(live.current)await load();
 },[load]);
 const closeProfile=useCallback(message=>{
  setSelected(null);setNote(message);
  if(message)void refreshAfterChange();
 },[refreshAfterChange]);
 useEffect(()=>{
  live.current=true;load();
  const poll=setInterval(()=>{if(document.visibilityState==='visible')load();},POLL);
  const shown=()=>{if(document.visibilityState==='visible')load();};
  document.addEventListener('visibilitychange',shown);
  return ()=>{live.current=false;clearInterval(poll);document.removeEventListener('visibilitychange',shown);};
 },[load]);
 // Controlled by the saved value: on failure nothing changes, so the box keeps showing what the server holds.
 async function toggleBan(u,next){
  setSaving(s=>new Set(s).add(u.id));setNote('');setError('');
  try{
   const response=await authorizedFetch('/api/admin/users/'+encodeURIComponent(u.id)+'/ban',json({banLogin:next}));
   if(handled(response))return;
   if(response.status===204){
    setUsers(list=>list&&list.map(x=>x.id===u.id?{...x,banLogin:next,sessionId:next?null:x.sessionId}:x));
    setNote(next?`${u.username} can no longer sign in.`:`${u.username} can sign in again.`);load();return;
   }
   if(response.status===404){setNote(`${u.username}'s account no longer exists.`);load();return;}
   throw await failure(response,`Could not ${next?'ban':'unban'} ${u.username}`);
  }catch(err){setError(offline(err));}
  finally{if(live.current)setSaving(s=>{const n=new Set(s);n.delete(u.id);return n;});}
 }
 function openEnd(u){setTarget(u);setBan(false);setEndError('');setEnding(false);}
 useEffect(()=>{const d=dialog.current;if(!d)return;if(target&&!d.open)d.showModal();else if(!target&&d.open)d.close();},[target]);
 async function confirmEnd(){
  if(!target||ending)return;const u=target,banLogin=ban;
  setEnding(true);setEndError('');
  try{
   const response=await authorizedFetch('/api/admin/sessions/'+encodeURIComponent(u.sessionId)+'/end',json({banLogin}));
   if(handled(response)){setTarget(null);return;}
   if(response.status===204){setTarget(null);setNote(banLogin?`Ended ${u.username}'s session and banned the account.`:`Ended ${u.username}'s session.`);await load();return;}
   if(response.status===404){setTarget(null);setNote(`${u.username}'s session had already ended.`);await load();return;}
   throw await failure(response,'Could not end the session');
  }catch(err){setEndError(offline(err));}
  finally{setEnding(false);}
 }
 const online=users?.filter(u=>u.sessionId!=null).length??0;
 if(selected!==null)return <section id={id} role="tabpanel" aria-labelledby={labelledBy} className="admin-panel">
  <UserProfile key={selected} accountId={selected} superUser={superUser} signedInUsername={signedInUsername} handled={handled} onClose={closeProfile} onUpdated={refreshAfterChange}/>
 </section>;
 return <section id={id} role="tabpanel" aria-labelledby={labelledBy} className="admin-panel">
  <header className="admin-head">
   <div><h1>Users</h1><p>{users===null?'Loading accounts…':`${users.length} account${users.length===1?'':'s'} · ${online} signed in`}{updated>0&&<span> · Updated {new Date(updated).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>}</p></div>
   <div className="um-head-actions">
    <button type="button" className="admin-refresh" onClick={load}>Refresh</button>
   </div>
  </header>
  {error&&<div className="admin-msg error" role="alert">{error}</div>}
  {note&&<div className="admin-msg" role="status">{note}</div>}
  {users===null?<div className="admin-empty" aria-busy="true"><span className="admin-spin" aria-hidden="true"/>Loading…</div>
  :!users.length?<div className="admin-empty"><h2>No accounts</h2><p>Register a user to get started.</p></div>
  :<div className="admin-table-wrap"><table className="admin-table um-table">
   <caption className="idle-sr">All accounts</caption>
   <thead><tr><th scope="col">User</th><th scope="col">Status</th><th scope="col">Phone</th><th scope="col">Created</th><th scope="col">Last IP</th><th scope="col">Ban login</th><th scope="col"><span className="idle-sr">Actions</span></th></tr></thead>
   <tbody>{users.map(u=>{
    const on=u.sessionId!=null,showControls=!u.isSuperUser&&u.username!==signedInUsername,managed=superUser||!u.isAdmin;
    return <tr key={u.id} className={u.banLogin?'um-banned':undefined}>
    <th scope="row"><button type="button" className="admin-user um-profile-link" aria-label={`Open profile for ${u.username}`} onClick={()=>setSelected(u.id)}><ContactAvatar className="admin-avatar" contactId={u.phoneNumber} fallback={String(u.name||u.username||'?').slice(0,1).toUpperCase()}/>
     <span className="um-who"><strong>{show(u.name)}</strong><small>@{show(u.username)}</small>
      {(u.isSuperUser||u.isAdmin)&&<span className="um-badges">{u.isSuperUser&&<span className="um-badge super">Super user</span>}{u.isAdmin&&!u.isSuperUser&&<span className="um-badge">Admin</span>}</span>}</span></button></th>
    <td><span className={'um-status'+(on?' on':'')}>{on?'Signed in':'Offline'}</span>{u.banLogin&&<span className="um-badge banned">Banned</span>}</td>
    <td className="um-mono">{show(u.phoneNumber)}</td>
    <td>{date(u.dateCreated)}</td>
    <td className="um-mono">{show(u.userIp)}</td>
    <td>{showControls?<label className="um-switch" title={managed?undefined:'Only the super user can change an admin’s login access.'}><input type="checkbox" checked={!!u.banLogin} disabled={!managed||saving.has(u.id)} onChange={e=>toggleBan(u,e.target.checked)}
      aria-label={`Ban login for ${u.username}`}/><span aria-hidden="true"/>{saving.has(u.id)&&<small>Saving…</small>}</label>:u.banLogin?'Yes':'No'}</td>
    <td>{showControls&&on&&<button type="button" className="admin-end" disabled={!managed} title={managed?undefined:'Only the super user can end an admin’s session.'} onClick={()=>openEnd(u)} aria-label={`End ${u.username}'s session`}>End session</button>}</td>
   </tr>;})}</tbody>
  </table></div>}
  <dialog ref={dialog} className="idle-dialog um-dialog" aria-labelledby="um-end-title" aria-describedby="um-end-desc" onCancel={e=>{if(ending)e.preventDefault();else setTarget(null);}} onClose={()=>setTarget(null)}>
   {target&&<>
    <h2 id="um-end-title">End {target.name||target.username}'s session?</h2>
    <p id="um-end-desc">{target.name&&target.name!==target.username?<>@{target.username} </>:null}will be signed out of every open tab right away.</p>
    <label className="um-ban-option"><input type="checkbox" checked={ban} disabled={ending} onChange={e=>setBan(e.target.checked)}/>
     <span><strong>Ban user</strong><small>Blocks future sign-ins until the ban is removed in the user directory.</small></span></label>
    {endError&&<p className="idle-error" role="alert">{endError}</p>}
    <div className="idle-actions">
     <button type="button" className="idle-leave" disabled={ending} onClick={()=>setTarget(null)}>Cancel</button>
     <button type="button" className="um-danger" disabled={ending} onClick={confirmEnd}>{ending?'Ending…':ban?'End and ban':'End session'}</button>
    </div>
   </>}
  </dialog>
 </section>;
}
