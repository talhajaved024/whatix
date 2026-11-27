import {useEffect,useState} from 'react';
import {authorizedFetch,checkSession} from './auth.js';
import {usernameProblem} from './usernames.js';
const EMPTY={name:'',username:'',password:'',phone:'',isAdmin:false,banLogin:false};
const offline=err=>err instanceof TypeError?'Could not reach the server. Check your connection and try again.':err.message;
function validate(f){
 const e={},digits=f.phone.replace(/[\s()-]/g,'').replace(/^\+/,'');
 if(!f.name.trim())e.name='Enter a name.';else if(f.name.length>128)e.name='Use 128 characters or fewer.';
 const username=usernameProblem(f.username);if(username)e.username=username;
 if(!f.password)e.password='Enter a password.';else if(f.password.length<8)e.password='Use at least 8 characters.';else if(f.password.length>256)e.password='Use 256 characters or fewer.';
 // Required. Stored as a number, so a leading 0 would be silently dropped: require the country code.
 if(!digits)e.phone='Enter the phone number with country code.';
 else if(!/^\d+$/.test(digits))e.phone='Use digits only.';else if(digits.length>15)e.phone='Use at most 15 digits.';
 else if(/^0/.test(digits))e.phone='Include the country code, without a leading 0.';
 else if(digits.length<7)e.phone='Enter the full number with country code (at least 7 digits).';
 return {errors:e,phoneNumber:digits?Number(digits):null};
}
export default function Register({id,labelledBy,onForbidden,onRegistered,superUser}){
 const [form,setForm]=useState(EMPTY);const[errors,setErrors]=useState({});const[busy,setBusy]=useState(false);const[peek,setPeek]=useState(false);
 const [note,setNote]=useState('');const[error,setError]=useState('');
 const username=form.username;
 const [lookup,setLookup]=useState(null);
 const problem=username?usernameProblem(username):'';
 const validUsername=!!username && !problem;
 const availability=!validUsername?'':lookup?.username===username?lookup.status:'checking';
 const hints={checking:'Checking username...',available:'Username is available.',taken:'That username is already taken. Choose another.',unknown:'Availability check unavailable. Registering will check again.'};
 useEffect(()=>{
  if(!validUsername)return;
  const controller=new AbortController();
  const timer=setTimeout(async()=>{
   try{
    const response=await authorizedFetch('/api/admin/username-availability?'+new URLSearchParams({username}),{signal:controller.signal,cache:'no-store'});
    if(!response.ok)throw new Error('Lookup failed');
    const {available}=await response.json();
    if(!controller.signal.aborted)setLookup({username,status:available?'available':'taken'});
   }catch{if(!controller.signal.aborted)setLookup({username,status:'unknown'});}
  },300);
  return ()=>{clearTimeout(timer);controller.abort();};
 },[username,validUsername]);
 const setField=(k,v)=>{if(k==='username')setLookup(null);setForm(f=>({...f,[k]:v}));setErrors(e=>e[k]?{...e,[k]:''}:e);setNote('');};
 async function submit(e){
  e.preventDefault();if(busy||availability==='taken'||availability==='checking')return;
  const {errors:found,phoneNumber}=validate(form);setErrors(found);
  const first=Object.keys(found).find(k=>found[k]);if(first){document.getElementById('reg-'+first)?.focus();return;}
  setBusy(true);setNote('');setError('');
  try{
   const response=await authorizedFetch('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:form.name.trim(),username:form.username,password:form.password,phoneNumber,isAdmin:form.isAdmin,banLogin:form.banLogin})});
   if(response.status===403)return onForbidden();
   if(response.status===401)return void checkSession().catch(()=>{});
   if(response.status===201){setLookup({username,status:'taken'});setForm(f=>({...f,password:''}));setPeek(false);setNote(`Registered ${form.username}. They appear in the Users tab.`);onRegistered?.();return;}
   if(response.status===409){setLookup({username,status:'taken'});setErrors({username:'That username is already taken. Choose another.'});document.getElementById('reg-username')?.focus();return;}
   const body=await response.json().catch(()=>null);
   throw new Error(typeof body?.error==='string'?body.error:'The account could not be registered (HTTP '+response.status+').');
  }catch(err){setError(offline(err));}
  finally{setBusy(false);}
 }
 const describe=k=>errors[k]?'reg-'+k+'-error':k==='username'?'reg-availability':undefined;
 const field=(k,label,hint,input)=><label className="um-field" htmlFor={'reg-'+k}><span className="um-label">{label}</span>
  <input id={'reg-'+k} value={form[k]} onChange={e=>setField(k,e.target.value)} aria-invalid={!!errors[k]||(k==='username'&&(!!problem||availability==='taken')&&!note)||undefined} aria-describedby={describe(k)} {...input}/>
  {hint&&<small className="um-hint">{hint}</small>}
  {k==='username'&&<small id="reg-availability" role="status" className={availability==='taken'||problem?'um-error':undefined}>{!errors[k]&&!note&&(problem||hints[availability])}</small>}
  {errors[k]&&<small id={'reg-'+k+'-error'} className="um-error">{errors[k]}</small>}</label>;
 return <section id={id} role="tabpanel" aria-labelledby={labelledBy} className="admin-panel">
  <header className="admin-head"><div><h1>Register user</h1><p>Create a sign-in for a team member. All fields are required. They choose their own password the first time they sign in. You can manage their account in the Users tab.</p></div></header>
  {error&&<div className="admin-msg error" role="alert">{error}</div>}
  {note&&<div className="admin-msg" role="status">{note}</div>}
  <form className="um-form" onSubmit={submit} noValidate aria-label="Register user">
   {field('name','Name','required',{autoComplete:'off',maxLength:128,'aria-required':true})}
   {field('username','Username','required · lowercase, no spaces · 1–64 characters',{autoComplete:'off',spellCheck:false,autoCapitalize:'none',maxLength:64,'aria-required':true})}
   <label className="um-field" htmlFor="reg-password"><span className="um-label">Password</span>
    <span className="um-password"><input id="reg-password" type={peek?'text':'password'} autoComplete="new-password" value={form.password} onChange={e=>setField('password',e.target.value)} maxLength={256} aria-required="true"
     aria-invalid={!!errors.password||undefined} aria-describedby={describe('password')}/>
     <button type="button" aria-label={peek?'Hide password':'Show password'} aria-pressed={peek} onClick={()=>setPeek(p=>!p)}>{peek?'Hide':'Show'}</button></span>
    <small className="um-hint">required · 8–256 characters</small>
    {errors.password&&<small id="reg-password-error" className="um-error">{errors.password}</small>}</label>
   {field('phone','Phone number','required · with country code',{inputMode:'tel',autoComplete:'off',placeholder:'923001234567','aria-required':true})}
   <div className="um-checks">
    {superUser&&<label><input type="checkbox" checked={form.isAdmin} onChange={e=>setField('isAdmin',e.target.checked)}/> Is admin</label>}
    <label><input type="checkbox" checked={form.banLogin} onChange={e=>setField('banLogin',e.target.checked)}/> Ban login</label>
   </div>
   <div className="um-form-actions"><button type="submit" className="um-primary" disabled={busy||!!problem||availability==='taken'||availability==='checking'}>{busy?'Registering…':'Register user'}</button></div>
  </form>
 </section>;
}
