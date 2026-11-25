import {useEffect,useRef,useState} from 'react';
import {login,takeEndReason} from './auth.js';
import Constellation from './Constellation.jsx';
import SplitFlap from './components/SplitFlap.jsx';
const Glyph=({d})=><svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={d}/></svg>;
const paths={user:"M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2",lock:"M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4",eye:"M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",eyeOff:"M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4 M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6 M9.9 9.9a3 3 0 0 0 4.2 4.2",arrow:"M5 12h14 M13 6l6 6-6 6"};
// Sign-in pill: leans a little toward the mouse with a light that follows it,
// ripples from the click point, and pulses once when it becomes ready.
// Only transforms and opacity animate.
function SubmitButton({busy,ready}){
 const ref=useRef(null);const[ripples,setRipples]=useState([]);const[pulse,setPulse]=useState(0);const was=useRef(ready);
 useEffect(()=>{if(ready&&!was.current&&!busy)setPulse(n=>n+1);was.current=ready;},[ready,busy]);
 const calm=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
 const move=e=>{const el=ref.current;if(e.pointerType!=='mouse'||!el||el.disabled)return;const r=el.getBoundingClientRect();const x=e.clientX-r.left,y=e.clientY-r.top;
  el.style.setProperty('--gx',x+'px');el.style.setProperty('--gy',y+'px');
  if(!calm()){el.style.setProperty('--tx',((x/r.width-.5)*6).toFixed(2)+'px');el.style.setProperty('--ty',((y/r.height-.5)*4).toFixed(2)+'px');}};
 const leave=()=>{const el=ref.current;if(!el)return;el.style.setProperty('--tx','0px');el.style.setProperty('--ty','0px');};
 const down=e=>{const el=ref.current;if(!el||el.disabled||calm())return;const r=el.getBoundingClientRect();const size=Math.max(r.width,r.height)*2.2;
  setRipples(list=>[...list.slice(-2),{id:Date.now()+Math.random(),x:e.clientX-r.left-size/2,y:e.clientY-r.top-size/2,size}]);};
 return <button ref={ref} type="submit" className="auth-submit" disabled={busy||!ready}
  onPointerMove={move} onPointerLeave={leave} onPointerDown={down}>
  {pulse>0&&<span key={pulse} className="auth-pulse" aria-hidden="true"/>}
  {ripples.map(r=><span key={r.id} className="auth-ripple" aria-hidden="true" style={{left:r.x,top:r.y,width:r.size,height:r.size}}
   onAnimationEnd={()=>setRipples(list=>list.filter(item=>item.id!==r.id))}/>)}
  <span className="auth-submit-label">{busy?'Signing in…':'Sign in'}</span>
  <span className="auth-submit-icon" aria-hidden="true">{busy?<span className="auth-spin"/>:<Glyph d={paths.arrow}/>}</span>
 </button>;
}
export default function Login(){
 const [username,setUsername]=useState('');const[password,setPassword]=useState('');const[error,setError]=useState('');const[busy,setBusy]=useState(false);const[shown,setShown]=useState(false);const[caps,setCaps]=useState(false);
 const card=useRef(null);
 // Moving the mouse onto the logo reveals the split-flap word; moving off hides it.
 const [brandOpen,setBrandOpen]=useState(false);
 const hoverBrand=open=>e=>{if(e.pointerType==='mouse')setBrandOpen(open);};
 const shake=()=>{const el=card.current;if(!el)return;el.classList.remove('shake');void el.offsetWidth;el.classList.add('shake');};
 // Arriving here because the session ended (expired, revoked) gets the same visible error as a failed sign-in.
 useEffect(()=>{const why=takeEndReason();if(why){setError(why);requestAnimationFrame(shake);}},[]);
 async function submit(e){e.preventDefault();if(busy)return;setBusy(true);try{await login(username,password);}catch(err){setError(err.message);shake();}finally{setBusy(false);}}
 // Pointer-tracked sheen on the glass; purely decorative, skipped for touch.
 const track=e=>{if(e.pointerType!=='mouse')return;const r=card.current.getBoundingClientRect();card.current.style.setProperty('--mx',`${e.clientX-r.left}px`);card.current.style.setProperty('--my',`${e.clientY-r.top}px`);};
 const keys=e=>setCaps(e.getModifierState?.('CapsLock'));
 return <main className="auth-screen"><div className="auth-orbs" aria-hidden="true"><i/><i/><i/></div><Constellation masked/>
  <form ref={card} className="auth-card" onSubmit={submit} onPointerMove={track} onAnimationEnd={e=>e.target===card.current&&e.animationName==='auth-angry'&&card.current.classList.remove('shake')} aria-busy={busy}>
   <h1 className={'auth-brand'+(brandOpen?' is-open':'')} onPointerEnter={hoverBrand(true)} onPointerLeave={hoverBrand(false)}>
    <img className="auth-mark" src="/whatix.svg" alt="Whatix! sign in"/>
    <SplitFlap text="Whatix!" visible={brandOpen}/>
   </h1>
   <label className="auth-field"><span className="auth-input"><Glyph d={paths.user}/><input required autoFocus aria-label="Username" autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} placeholder="Enter username" aria-invalid={!!error||undefined} aria-describedby={error?'auth-error':undefined}/></span></label>
   <label className="auth-field"><span className="auth-input"><Glyph d={paths.lock}/><input required aria-label="Password" type={shown?'text':'password'} autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={keys} onKeyUp={keys} placeholder="Enter password" aria-invalid={!!error||undefined} aria-describedby={[error&&'auth-error',caps&&'auth-caps'].filter(Boolean).join(' ')||undefined}/>
    <button type="button" className="auth-peek" aria-label={shown?'Hide password':'Show password'} aria-pressed={shown} onClick={()=>setShown(v=>!v)}><Glyph d={shown?paths.eyeOff:paths.eye}/></button></span></label>
   {caps&&<small id="auth-caps" className="auth-caps" role="status">Caps Lock is on</small>}
   {error&&<div id="auth-error" className="auth-error" role="alert">{error}</div>}
   <SubmitButton busy={busy} ready={!!username&&!!password}/>
   <small className="auth-foot">Authorized access only</small>
  </form><footer className="auth-copy">© {new Date().getFullYear()} Brand Matrix. All rights reserved.</footer></main>;
}
