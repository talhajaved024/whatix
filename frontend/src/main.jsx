import './perf.js';
import React, {Component,Suspense,useCallback,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useInboxAvailability} from './inbox-availability.js';
import {useTeamChat} from './team-chat.js';
import TeamChatDock from './components/TeamChat.jsx';
import MobileTabs from './MobileTabs.jsx';
import Icon from './components/Icon.jsx';
import AccountMenu from './components/AccountMenu.jsx';
import {AddNumber,InboxSwitcher} from './AddNumber.jsx';
import {campaignToResume,forgetResume,openChatIn,openInbox,secondary,useInboxSession} from './inbox.js';
import App from './App.jsx';
import Login from './Login.jsx';
import IdleGuard from './IdleGuard.jsx';
import PasswordSetup from './PasswordSetup.jsx';
import {useMyCampaigns} from './campaign-directory.js';
import {lazyComponent,whenIdle} from './lazy.js';
// Admin screens download on demand, so regular users (and slow laptops) load
// only the chat. Admins fetch them in the background right after signing in.
const Users=lazyComponent(()=>import('./Users.jsx'));
const Register=lazyComponent(()=>import('./Register.jsx'));
const AssignedNumbers=lazyComponent(()=>import('./AssignedNumbers.jsx'));
const AssignCampaigns=lazyComponent(()=>import('./AssignCampaigns.jsx'));
const OfflineRequirements=lazyComponent(()=>import('./OfflineRequirements.jsx'));
const adminScreens=[Users,Register,AssignedNumbers,AssignCampaigns,OfflineRequirements];
function PanelLoading(){
 return <section className="admin-panel"><div className="admin-empty" role="status"><span className="admin-spin" aria-hidden="true"/>Loading…</div></section>;
}
import {currentUser,initializeSession,onAuthChange,logout,takeAccountSwitch} from './auth.js';
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
// [id, label, icon]
const TABS=[['chat','Chat','chat'],['users','Users','users'],['register','Register user','userPlus'],['campaigns','Assign WA Num','campaign'],
 ['assigned','Assign Contacts','contacts'],[OFFLINE,'Whatix AI','clipboard'],['numbers','Add Number','phone']];
// On a phone these get their own bottom-bar button; the rest open from "More".
const PHONE_TABS=['chat','users','campaigns','assigned'];
function Tabs({tab,onChange}){
 // Roving tabindex + arrow keys, per the ARIA tabs pattern.
 const keys=e=>{const i=TABS.findIndex(([id])=>id===tab),d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(!d)return;
  e.preventDefault();const next=TABS[(i+d+TABS.length)%TABS.length][0];onChange(next);document.getElementById('tab-'+next)?.focus();};
 // On a phone the tab row scrolls sideways; keep the selected tab in view.
 useEffect(()=>{document.getElementById('tab-'+tab)?.scrollIntoView({block:'nearest',inline:'nearest'});},[tab]);
 return <nav className="mast-tabs" role="tablist" aria-label="Workspace" onKeyDown={keys}>
  {TABS.map(([id,label,icon])=><button key={id} id={'tab-'+id} type="button" role="tab" title={label} aria-selected={tab===id} aria-controls={'panel-'+id} tabIndex={tab===id?0:-1} onClick={()=>onChange(id)}><Icon name={icon} size={15}/><span>{label}</span></button>)}
 </nav>;
}
function Workspace({user,admin,nav,tab,panel,onLogout,onShowChat}){
 // The open inbox; switching changes it in place (no page reload).
 const session=useInboxSession();
 const availability=useInboxAvailability(user.username,session);
 const teamChat=useTeamChat();
 const dashboard=admin && tab==='numbers';
 const [sending,setSending]=useState(false);
 // A regular user works only inside campaigns assigned to them. Open the first
 // one when this inbox is not theirs.
 const mine=useMyCampaigns(!admin);
 const assigned=mine?.sessions;
 const elsewhere=!admin && assigned && !assigned.some(row=>row.name===session);
 // Opening the app returns to the campaign this user last chose: once per tab,
 // and only when the app opens. Later switches never move this tab again.
 const [last,setLast]=useState(()=>admin?null:campaignToResume(user.username));
 const resume=!admin && assigned && !secondary && last && last!==session && assigned.some(row=>row.name===last);
 useEffect(()=>{
  if(!assigned)return;
  if(last)setLast(null);
  if(resume)openInbox(last,mine.defaultSession);
  else if(elsewhere && assigned.length)openInbox(assigned[0].name,mine.defaultSession);
 },[resume,elsewhere,assigned,last,mine?.defaultSession]);
 // Once an inbox has opened, switching keeps the chat view on screen: the next
 // inbox's view (a fresh one, keyed by inbox) appears at once and opens its
 // saved history as soon as the server confirms which account it is.
 const ready=!!availability?.account;
 const [opened,setOpened]=useState(false);
 useEffect(()=>{
  if(!ready || opened)return;
  setOpened(true);
  // The panel's entrance animation plays on the first open only, not on every switch.
  const timer=setTimeout(()=>{document.documentElement.dataset.inboxOpened='';},700);
  return ()=>clearTimeout(timer);
 },[ready,opened]);
 const showApp=!elsewhere && !resume && (ready || (opened && availability===undefined));
 const switching=resume || (elsewhere && assigned.length>0);
 const waiting=switching ? {icon:'campaign',title:'Opening your WhatsApp number…',busy:true}
  : elsewhere ? {icon:'campaign',title:'No WhatsApp number yet',text:'An admin hasn’t assigned you a WhatsApp number. Your customers’ chats will appear here as soon as one is assigned. This page updates on its own.'}
  : availability ? {icon:'phone',title:'WhatsApp number unavailable',text:'Checking for reconnection…'+(admin?' ('+session+')':''),busy:true}
  : {icon:'phone',title:'Checking WhatsApp inbox…',busy:true};
 return <>
   {showApp
    ? <App key={session} account={availability?.account} username={user.username} fullName={user.name} role={user.role} onLogout={onLogout}
        nav={nav} teamChat={teamChat} onShowChat={onShowChat} onSendingChange={setSending} panel={dashboard || panel}/>
    : <><header className="mast"><div className="brand"><img className="logo" src="/whatix.svg" alt=""/>Whatix!</div>
        {nav}<div className="mast-end"><button type="button" className="auth-logout" onClick={onLogout}>Log out</button><AccountMenu name={user.name||user.username}/></div></header>
        {!(dashboard || panel) && <section id="panel-chat" className="inbox-empty">
          {!elsewhere && !resume && <InboxSwitcher admin={admin} username={user.username}/>}
          <div className="inbox-status" role="status">
            <span className={'inbox-status-icon'+(waiting.busy?' busy':'')} aria-hidden="true"><Icon name={waiting.icon} size={30}/></span>
            <h2>{waiting.title}</h2>{waiting.text && <p>{waiting.text}</p>}
          </div>
        </section>}
        {typeof panel==='function'?panel(undefined,true):panel}</>}
   {dashboard && <AddNumber sending={Boolean(availability?.account && sending)}/>}
   <TeamChatDock chat={teamChat}/>
 </>;
}
function AuthGate(){
 const [state,setState]=useState('loading');
 const [user,setUser]=useState(currentUser);
 const [tab,setTab]=useState('chat');
 const [logoutError,setLogoutError]=useState('');
 const [switchedTo,setSwitchedTo]=useState(takeAccountSwitch);
 useEffect(()=>{
  const apply=ok=>{setUser(currentUser());setState(ok?'authenticated':'guest');};
  const unsubscribe=onAuthChange(apply);initializeSession().then(apply);return unsubscribe;
 },[]);
 const superUser=user?.role==='super_user';
 const admin=superUser||user?.role==='admin';
 // Warm the admin screens while the browser is idle, one at a time.
 useEffect(()=>{
  if(!admin)return;
  let cancel=()=>{};const queue=[...adminScreens];
  const next=()=>{const screen=queue.shift();if(!screen)return;screen.preload();cancel=whenIdle(next);};
  cancel=whenIdle(next,8000);
  return ()=>cancel();
 },[admin]);
 const selectTab=useCallback(next=>{
  if(next===OFFLINE && !admin)next='chat';
  // Whatix AI requirements belong to the main inbox: switch there in place first.
  if(next===OFFLINE && secondary)openInbox(null);
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
   forgetResume(user?.username);
   try{await logout();}catch{setLogoutError('Could not log out. Check your connection and try again.');}
 }
 // An admin set this password (new account or reset): nothing else opens until the
 // user chooses their own. The server enforces the same rule on every request.
 if(user?.mustChangePassword)return <><Boundary name="idle warning" quiet><IdleGuard/></Boundary>
  {logoutError && <div className="app-alert" role="alert">{logoutError}</div>}
  <Boundary name="password setup"><PasswordSetup name={user.name||user.username} onSignOut={signOut}/></Boundary></>;
 let panel=null;
 if(admin&&tab==='users')panel=<Boundary key="users" name="user management"><Suspense fallback={<PanelLoading/>}><Users id="panel-users" labelledBy="tab-users" superUser={superUser} signedInUsername={user.username} onForbidden={toChat}/></Suspense></Boundary>;
 if(admin&&tab==='register')panel=<Boundary key="register" name="registration"><Suspense fallback={<PanelLoading/>}><Register id="panel-register" labelledBy="tab-register" superUser={superUser} onForbidden={toChat}/></Suspense></Boundary>;
 if(admin&&tab==='campaigns')panel=<Boundary key="campaigns" name="campaign assignment"><Suspense fallback={<PanelLoading/>}><AssignCampaigns id="panel-campaigns" labelledBy="tab-campaigns" onForbidden={toChat}/></Suspense></Boundary>;
 if(admin&&tab==='assigned')panel=<Boundary key="assigned" name="assigned numbers"><Suspense fallback={<PanelLoading/>}><AssignedNumbers id="panel-assigned" labelledBy="tab-assigned" onForbidden={toChat}/></Suspense></Boundary>;
 if(admin&&tab===OFFLINE)panel=(openChat,sending)=><Boundary key={OFFLINE} name="offline requirements">
  <Suspense fallback={<PanelLoading/>}><OfflineRequirements onForbidden={toChat} sending={sending} onOpenChat={(number,receivedBy)=>{
   // Received by another of our numbers: that customer's chat lives in its inbox.
   if(receivedBy && !receivedBy.main){openChatIn(receivedBy.session,number);toChat();return;}
   openChat(number);
   toChat();
   document.getElementById('tab-chat')?.focus();
  }}/></Suspense>
 </Boundary>;
 return <><Boundary name="idle warning" quiet><IdleGuard/></Boundary>{logoutError && <div className="app-alert" role="alert">{logoutError}</div>}
  {switchedTo && <div className="app-alert app-notice" role="status"><span>This browser is now signed in as <strong>{switchedTo}</strong>, because that account signed in in another tab. One browser holds one Whatix account at a time. Use a separate browser profile or a private window for a second account.</span>
   <button type="button" aria-label="Dismiss" onClick={()=>setSwitchedTo('')}><Icon name="close" size={16}/></button></div>}
  <Boundary name="chat workspace"><Workspace key={user.username} user={user} admin={admin} tab={tab}
    onLogout={signOut} onShowChat={toChat} nav={admin?<Tabs tab={tab} onChange={selectTab}/>:null} panel={panel}/></Boundary>
  {admin&&<Boundary name="phone navigation" quiet><MobileTabs tabs={TABS} primary={PHONE_TABS} tab={tab} onChange={selectTab}/></Boundary>}</>;
}
createRoot(document.getElementById('root')).render(<AuthGate/>);
