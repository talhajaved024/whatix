import {useRef,useState} from 'react';
import {changePassword} from '../auth.js';

// The signed-in user's name pill (NAME column). Clicking it opens "Change
// password": everyone, the super user included, can rotate their own password.
export default function AccountMenu({name}){
 const dialog=useRef(null);
 const [form,setForm]=useState({current:'',next:'',confirm:''});
 const [error,setError]=useState(''),[saving,setSaving]=useState(false);
 const initials=name.split(/\s+/).filter(Boolean).slice(0,2).map(word=>[...word][0].toUpperCase()).join('');
 const edit=(key,value)=>{setForm(previous=>({...previous,[key]:value}));setError('');};
 function open(){setForm({current:'',next:'',confirm:''});setError('');dialog.current?.showModal();}
 async function submit(event){
  event.preventDefault();
  if(saving)return;
  if(form.next!==form.confirm)return setError('The new passwords do not match.');
  if(form.next===form.current)return setError('Choose a password different from the current one.');
  setSaving(true);setError('');
  try{await changePassword(form.current,form.next);}   // success signs out, with a note on the sign-in page
  catch(err){setError(err?.message||'Could not change the password. Try again.');}
  finally{setSaving(false);}
 }
 return <>
  <button type="button" className="user-pill" title={'Signed in as '+name+' · Change password'} aria-haspopup="dialog" onClick={open}>
   <span className="user-pill-initials" aria-hidden="true">{initials}</span><span className="user-pill-name">{name}</span>
  </button>
  <dialog ref={dialog} className="idle-dialog um-dialog" aria-labelledby="pw-title" onCancel={e=>{if(saving)e.preventDefault();}}>
   <h2 id="pw-title">Change password</h2>
   <p>Signed in as {name}. You will sign in again with the new password.</p>
   <form className="pw-form" onSubmit={submit}>
    <label className="um-field">Current password<input type="password" autoComplete="current-password" required maxLength={256}
     value={form.current} disabled={saving} onChange={e=>edit('current',e.target.value)}/></label>
    <label className="um-field">New password<input type="password" autoComplete="new-password" required minLength={8} maxLength={256}
     value={form.next} disabled={saving} onChange={e=>edit('next',e.target.value)}/></label>
    <label className="um-field">Confirm new password<input type="password" autoComplete="new-password" required minLength={8} maxLength={256}
     value={form.confirm} disabled={saving} onChange={e=>edit('confirm',e.target.value)}/></label>
    {error&&<div role="alert" className="admin-msg error">{error}</div>}
    <div className="idle-actions">
     <button type="button" className="idle-leave" disabled={saving} onClick={()=>dialog.current?.close()}>Cancel</button>
     <button type="submit" className="um-primary" disabled={saving}>{saving?'Changing…':'Change password'}</button>
    </div>
   </form>
  </dialog>
 </>;
}
