import React, {Component,useCallback,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.jsx';
import Login from './Login.jsx';
import IdleGuard from './IdleGuard.jsx';
import Users from './Users.jsx';
import Register from './Register.jsx';
import AssignedNumbers from './AssignedNumbers.jsx';
import OfflineRequirements from './OfflineRequirements.jsx';
import {currentUser,initializeSession,onAuthChange,logout} from './auth.js';
import './styles.css';
// A render error would otherwise unmount everything and leave only the page background.
class Boundary extends Component{
 state={error:null};
 static getDerivedStateFromError(error){return {error};}
 componentDidCatch(error,info){console.error('[Whatix!] render failed in',this.props.name,error,info?.componentStack);}
 render(){const {error}=this.state;if(!error)return this.props.children;if(this.props.quiet)return null;
  return <div className="app-crash" role="alert"><h1>Something went wrong</h1><p>The {this.props.name} could not be displayed.</p>
   <pre>{String(error?.stack||error).split('\n').slice(0,6).join('\n')}</pre><button type="button" onClick={()=>location.reload()}>Reload</button></div>;}
}
const OFFLINE='offline-requirements';
const TABS=[['chat','Chat'],['users','Users'],['register','Register user'],['assigned','Assigned numbers'],[OFFLINE,'Offline Requirements']];
function Tabs({tab,onChange}){
 // Roving tabindex + arrow keys, per the ARIA tabs pattern.
 const keys=e=>{const i=TABS.findIndex(([id])=>id===tab),d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(!d)return;
  e.preventDefault();const next=TABS[(i+d+TABS.length)%TABS.length][0];onChange(next);document.getElementById('tab-'+next)?.focus();};
 return <nav className="mast-tabs" role="tablist" aria-label="Workspace" onKeyDown={keys}>
  {TABS.map(([id,label])=><button key={id} id={'tab-'+id} type="button" role="tab" aria-selected={tab===id} aria-controls={'panel-'+id} tabIndex={tab===id?0:-1} onClick={()=>onChange(id)}>{label}</button>)}
 </nav>;
}
function AuthGate(){
 const [state,setState]=useState('loading');
 const [user,setUser]=useState(currentUser);
 const [tab,setTab]=useState('chat');
 const [logoutError,setLogoutError]=useState('');
 useEffect(()=>{
  const apply=ok=>{setUser(currentUser());setState(ok?'authenticated':'guest');};
  const unsubscribe=onAuthChange(apply);initializeSession().then(apply);return unsubscribe;
 },[]);
 const superUser=user?.role==='super_user';
 const admin=superUser||user?.role==='admin';
 const selectTab=useCallback(next=>{
  if(next===OFFLINE && !admin)next='chat';
  const url=new URL(window.location.href);
  if(next===OFFLINE || url.hash==='#'+OFFLINE){
   url.hash=next===OFFLINE?OFFLINE:'';
   window.history.replaceState(window.history.state,'',url);
  }
  setTab(next);
 },[admin]);
 useEffect(()=>{
  if(state!=='authenticated')return;
  const readLocation=()=>selectTab(location.hash==='#'+OFFLINE?OFFLINE:'chat');
  readLocation();
  window.addEventListener('hashchange',readLocation);
  return ()=>window.removeEventListener('hashchange',readLocation);
 },[user?.username,state,selectTab]);
 const toChat=useCallback(()=>selectTab('chat'),[selectTab]);
 if(state==='loading')return <div className="auth-loading" role="status">Checking session…</div>;
 if(state==='guest')return <Boundary name="sign-in page"><Login/></Boundary>;
 async function signOut(){
   setLogoutError('');
   try{await logout();}catch{setLogoutError('Could not log out. Check your connection and try again.');}
 }
 let panel=null;
 if(admin&&tab==='users')panel=<Boundary key="users" name="user management"><Users id="panel-users" labelledBy="tab-users" superUser={superUser} signedInUsername={user.username} onForbidden={toChat}/></Boundary>;
 if(admin&&tab==='register')panel=<Boundary key="register" name="registration"><Register id="panel-register" labelledBy="tab-register" superUser={superUser} onForbidden={toChat}/></Boundary>;
 if(admin&&tab==='assigned')panel=<Boundary key="assigned" name="assigned numbers"><AssignedNumbers id="panel-assigned" labelledBy="tab-assigned" onForbidden={toChat}/></Boundary>;
 if(admin&&tab===OFFLINE)panel=(openChat,sending)=><Boundary key={OFFLINE} name="offline requirements">
  <OfflineRequirements onForbidden={toChat} sending={sending} onOpenChat={number=>{
   openChat(number);
   toChat();
   document.getElementById('tab-chat')?.focus();
  }}/>
 </Boundary>;
 return <><Boundary name="idle warning" quiet><IdleGuard/></Boundary>{logoutError && <div className="app-alert" role="alert">{logoutError}</div>}
  <Boundary name="chat workspace"><App key={user?.username} username={user?.username} fullName={user?.name} role={user?.role} onLogout={signOut} onShowChat={toChat} nav={admin?<Tabs tab={tab} onChange={selectTab}/>:null} panel={panel}/></Boundary></>;
}
createRoot(document.getElementById('root')).render(<AuthGate/>);
