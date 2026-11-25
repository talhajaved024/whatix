import {useCallback,useEffect,useRef,useState} from 'react';
import {authorizedFetch} from './auth.js';
import ContactAvatar from './components/ContactAvatar.jsx';

function fields(profile){
 return {name:profile.name??'',username:profile.username,phoneNumber:String(profile.phoneNumber??''),
  password:'',banLogin:!!profile.banLogin,isAdmin:!!profile.isAdmin};
}

async function profileError(response){
 if(response.status===409)return 'That username is already taken. Choose another.';
 if(response.status===503)return 'The user workbook is unavailable. Please try again.';
 if(response.status===400)return 'Check the name, username, phone number and new password, then try again.';
 const body=await response.json().catch(()=>null);
 return body?.error||'The request failed (HTTP '+response.status+'). Please try again.';
}
const networkError='Could not reach the server. Check your connection and try again.';

export default function UserProfile({accountId,handled,onClose,onUpdated,superUser,signedInUsername}){
 const url='/api/admin/users/'+encodeURIComponent(accountId);
 const [profile,setProfile]=useState(null),[form,setForm]=useState(null);
 const [error,setError]=useState(''),[note,setNote]=useState(''),[pending,setPending]=useState('');
 const [attempt,setAttempt]=useState(0);
 const dialog=useRef(null);
 const populate=useCallback(data=>{setProfile(data);setForm(fields(data));},[]);
 const checkResponse=useCallback(response=>{
  if(handled(response))return true;
  if(response.status===404){onClose('This account no longer exists.');return true;}
  return false;
 },[handled,onClose]);

 useEffect(()=>{
  const controller=new AbortController();
  async function load(){
   setError('');
   try{
    const response=await authorizedFetch(url,{cache:'no-store',signal:controller.signal});
    if(controller.signal.aborted||checkResponse(response))return;
    if(!response.ok){const message=await profileError(response);if(!controller.signal.aborted)setError(message);return;}
    const data=await response.json();
    if(!controller.signal.aborted)populate(data);
   }catch{if(!controller.signal.aborted)setError(networkError);}
  }
  load();return ()=>controller.abort();
 },[url,attempt,checkResponse,populate]);

 const changes={};
 if(form){
  const original=fields(profile);
  for(const key of Object.keys(original)){
   const value=key==='name'?form.name.trim():form[key];
   if(value!==original[key])changes[key]=key==='phoneNumber'?(value===''?null:Number(value)):value;
  }
 }
 const editable=profile&&profile.username!==signedInUsername&&!profile.isSuperUser&&(superUser||!profile.isAdmin);
 const dirty=Object.keys(changes).length>0,locked=!editable||!!pending;
 function edit(key,value){setForm(previous=>({...previous,[key]:value}));setError('');setNote('');}
 async function mutate(method){
  if(locked||(method==='PATCH'&&!dirty))return;
  setPending(method);setError('');setNote('');
  try{
   const options=method==='PATCH'?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(changes)}:{method};
   const response=await authorizedFetch(url,options);
   if(checkResponse(response))return;
   if(method==='DELETE'&&response.status===204){onClose('Deleted '+profile.username+'.');return;}
   if(method==='PATCH'&&response.status===200){
    populate(await response.json());setNote('Profile updated.');await onUpdated();return;
   }
   setError(await profileError(response));
  }catch{setError(networkError);}
  finally{dialog.current?.close();setPending('');}
 }
 return <>
  <header className="admin-head"><div><h1 className="profile-title">{profile&&<ContactAvatar contactId={profile.phoneNumber} className="admin-avatar"/>}{profile?'Profile for '+profile.username:'User profile'}</h1>
   {profile?.isSuperUser&&<p>The super user profile is read-only.</p>}</div>
   <button type="button" className="admin-refresh" onClick={()=>onClose('')} disabled={!!pending}>Back to users</button></header>
  {error&&<div role="alert" className="admin-msg error">{error} {!profile&&<button type="button" className="admin-refresh" onClick={()=>setAttempt(n=>n+1)}>Retry</button>}</div>}
  {note&&<div role="status" className="admin-msg">{note}</div>}
  {!profile&&!error&&<p role="status">Loading profile…</p>}
  {profile&&<>
   <dl className="um-profile-details">
    <div><dt>ID</dt><dd>{profile.id}</dd></div>
    <div><dt>Date created</dt><dd>{profile.dateCreated?new Date(profile.dateCreated).toLocaleString():'—'}</dd></div>
    <div><dt>Last login IP</dt><dd>{profile.userIp??'—'}</dd></div>
    <div><dt>Session status</dt><dd>{profile.sessionId!=null?'Signed in':'Offline'}</dd></div>
   </dl>
   <form className="um-form" aria-label="User profile" onSubmit={event=>{event.preventDefault();void mutate('PATCH');}}>
    <label className="um-field">Name<input required maxLength={128} pattern={'.*\\S.*'} value={form.name} disabled={locked} onChange={e=>edit('name',e.target.value)}/></label>
    <label className="um-field">Username<input required maxLength={64} pattern={'\\S(?:.*\\S)?'} title={superUser?'Remove leading and trailing spaces.':'Only the super user can change usernames.'} value={form.username} disabled={locked||!superUser} onChange={e=>edit('username',e.target.value)}/></label>
    <label className="um-field">Phone number<input type="tel" inputMode="numeric" maxLength={15} pattern="[1-9][0-9]{0,14}" title="Enter a positive number of up to 15 digits." value={form.phoneNumber} disabled={locked} onChange={e=>edit('phoneNumber',e.target.value)}/></label>
    <label className="um-field">New password<input type="password" autoComplete="new-password" minLength={8} maxLength={256} aria-describedby="profile-password-hint" value={form.password} disabled={locked} onChange={e=>edit('password',e.target.value)}/>
     <small id="profile-password-hint">Leave blank to keep the current password.</small></label>
    <div className="um-checks">
     <label><input type="checkbox" checked={form.banLogin} disabled={locked} onChange={e=>edit('banLogin',e.target.checked)}/>Ban login</label>
     <label><input type="checkbox" checked={form.isAdmin} disabled={locked||!superUser} onChange={e=>edit('isAdmin',e.target.checked)}/>Is admin</label>
    </div>
    {editable&&<div className="um-form-actions um-profile-actions">
     <button type="submit" className="um-primary" disabled={!dirty||locked}>{pending==='PATCH'?'Updating…':'Update'}</button>
     <button type="button" className="admin-end" disabled={locked} onClick={()=>dialog.current.showModal()}>Delete</button>
    </div>}
   </form>
   {editable&&<dialog ref={dialog} className="idle-dialog um-dialog" aria-labelledby="delete-title" aria-describedby="delete-description" onCancel={e=>{if(pending)e.preventDefault();}}>
    <h2 id="delete-title">Delete {profile.username}?</h2>
    <p id="delete-description">This permanently removes the account and signs them out.</p>
    <div className="idle-actions"><button type="button" className="idle-leave" autoFocus disabled={locked} onClick={()=>dialog.current.close()}>Cancel</button>
     <button type="button" className="um-danger" disabled={locked} onClick={()=>mutate('DELETE')}>{pending==='DELETE'?'Deleting…':'Delete user'}</button></div>
   </dialog>}
  </>}
 </>;
}
