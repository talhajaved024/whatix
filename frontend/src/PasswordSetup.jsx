import {useRef,useState} from 'react';
import {changePassword} from './auth.js';
import Constellation from './Constellation.jsx';
import {Glyph,paths,SubmitButton} from './Login.jsx';

// Shown instead of the app while this account must choose its own password: an
// admin created it, or reset its password, so that admin knows the current one.
// The server refuses everything else for this session until the change is made
// (403 password_change_required). Success ends the session, and the sign-in page
// asks for the new password.
export default function PasswordSetup({name,onSignOut}){
 const [form,setForm]=useState({current:'',next:'',confirm:''});
 const [shown,setShown]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const card=useRef(null);
 const edit=(key,value)=>{setForm(previous=>({...previous,[key]:value}));setError('');};
 const shake=()=>{const el=card.current;if(!el)return;el.classList.remove('shake');void el.offsetWidth;el.classList.add('shake');};
 async function submit(event){
  event.preventDefault();
  if(busy)return;
  const problem=form.next.length<8?'Use at least 8 characters for your new password.'
   :form.next.length>256?'Use at most 256 characters for your new password.'
   :form.next===form.current?'Choose a password different from the one your admin gave you.'
   :form.next!==form.confirm?'The new passwords do not match.':'';
  if(problem){setError(problem);shake();return;}
  setBusy(true);
  try{await changePassword(form.current,form.next);}   // signs out; the sign-in page explains
  catch(err){setError(err?.message||'Could not save the password. Try again.');shake();}
  finally{setBusy(false);}
 }
 const field=(key,label,placeholder,autoComplete,extra)=><label className="auth-field"><span className="auth-input"><Glyph d={paths.lock}/>
  <input required aria-label={label} type={shown?'text':'password'} autoComplete={autoComplete} maxLength={256} value={form[key]}
   placeholder={placeholder} disabled={busy} onChange={e=>edit(key,e.target.value)} aria-invalid={!!error||undefined}
   aria-describedby={error?'pw-setup-error':undefined} {...extra}/>
  {key==='current'&&<button type="button" className="auth-peek" aria-label={shown?'Hide passwords':'Show passwords'} aria-pressed={shown}
   onClick={()=>setShown(v=>!v)}><Glyph d={shown?paths.eyeOff:paths.eye}/></button>}</span></label>;
 return <main className="auth-screen"><div className="auth-orbs" aria-hidden="true"><i/><i/><i/></div><Constellation masked/>
  <form ref={card} className="auth-card pw-setup" onSubmit={submit} aria-busy={busy} aria-labelledby="pw-setup-title" aria-describedby="pw-setup-text"
   onAnimationEnd={e=>e.target===card.current&&e.animationName==='auth-angry'&&card.current.classList.remove('shake')}>
   <div className="auth-brand"><img className="auth-mark" src="/whatix.svg" alt=""/></div>
   <h1 id="pw-setup-title" className="pw-setup-title">Choose your password</h1>
   <p id="pw-setup-text" className="pw-setup-text">Hi {name}. Your admin set the password you just used, so they know it. Choose your own before you continue.</p>
   {field('current','Password from your admin','Password from your admin','current-password',{autoFocus:true})}
   {field('next','New password','New password · at least 8 characters','new-password',{minLength:8})}
   {field('confirm','Confirm new password','Confirm new password','new-password',{minLength:8})}
   {error&&<div id="pw-setup-error" className="auth-error" role="alert">{error}</div>}
   <SubmitButton busy={busy} ready={!!form.current&&!!form.next&&!!form.confirm} label="Save password" busyLabel="Saving…"/>
   <button type="button" className="pw-setup-signout" disabled={busy} onClick={onSignOut}>Sign out instead</button>
  </form><footer className="auth-copy">© {new Date().getFullYear()} Brand Matrix. All rights reserved.</footer></main>;
}
