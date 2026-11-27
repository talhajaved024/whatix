import {useCallback,useEffect,useRef,useState} from 'react';
import {authorizedFetch} from './auth.js';
import {SESSION,useInboxSession} from './inbox.js';
import {announceAssignments,onAssignmentsChanged} from './campaign-directory.js';

// Admins: who is assigned each customer in the WhatsApp number open now, and
// which users hold that number (the people a customer can be moved to). The
// chat list's assignee chip reads this; picking a user moves the customer to
// them on the server, so the Assign Contacts tab shows the same thing.
// Kept current: on load, on switching numbers, every 30 s while the page is
// visible, right after a move, and as soon as an assignment changes on the
// Assign Contacts or Assign WA Num tab (or in another tab of this browser).
const POLL=30000;
const failure=async(response,fallback)=>{
  const body=await response.json().catch(()=>null);
  return Object.assign(new Error(typeof body?.error==='string'?body.error:fallback+' (HTTP '+response.status+').'),{status:response.status});
};

export function useContactAssignees(enabled){
  const session=useInboxSession();
  // {session, phone, byNumber: Map(digits -> [username]), users: [{id,name,username}]}
  const [state,setState]=useState(null);
  const request=useRef(0);
  const load=useCallback(async()=>{
    if(!enabled)return;
    const id=++request.current,name=SESSION;
    try{
      const contacts=await authorizedFetch('/api/campaign-contacts',{cache:'no-store'});
      if(!contacts.ok)throw await failure(contacts,'Assignments could not be loaded');
      const {phone,assignments}=await contacts.json();
      const holders=await authorizedFetch('/api/admin/users?'+new URLSearchParams({role:'user',campaign:name,campaignPhone:String(phone)}),{cache:'no-store'});
      if(!holders.ok)throw await failure(holders,'Users could not be loaded');
      const {users}=await holders.json();
      if(id!==request.current)return;
      const byNumber=new Map();
      for(const row of Array.isArray(assignments)?assignments:[]){
        const key=String(row.phoneNumber);
        byNumber.set(key,[...(byNumber.get(key)??[]),row.username]);
      }
      setState({session:name,phone:String(phone),byNumber,
        users:(Array.isArray(users)?users:[]).map(({id,name,username})=>({id,name:name||username,username}))});
    }catch{
      // Keep showing what was loaded; a number that went away shows nothing.
      if(id===request.current)setState(previous=>previous?.session===name?previous:null);
    }
  },[enabled]);
  useEffect(()=>{
    if(!enabled){setState(null);return;}
    setState(previous=>previous?.session===session?previous:null);
    load();
    const tick=setInterval(()=>{if(document.visibilityState==='visible')load();},POLL);
    const shown=()=>{if(document.visibilityState==='visible')load();};
    document.addEventListener('visibilitychange',shown);
    // A burst of saves (assigning many contacts) reloads once, just after the last one.
    let soon;
    const stop=onAssignmentsChanged(()=>{clearTimeout(soon);soon=setTimeout(load,300);});
    return ()=>{clearInterval(tick);clearTimeout(soon);stop();document.removeEventListener('visibilitychange',shown);};
  },[enabled,session,load]);

  // Move one customer to `username` only. Resolves with the server's answer.
  const reassign=useCallback(async(number,username)=>{
    if(!state || state.session!==SESSION)throw new Error('This number changed. Try again.');
    const response=await authorizedFetch('/api/campaign-contacts/reassign',{method:'PUT',
      headers:{'Content-Type':'application/json','X-Campaign-Phone':state.phone},
      body:JSON.stringify({phoneNumber:Number(number),username})});
    if(!response.ok){
      const error=await failure(response,'The customer could not be moved');
      if(response.status===409 || response.status===422)load();
      throw error;
    }
    const result=await response.json();
    announceAssignments();   // other tabs of this browser follow
    setState(previous=>{
      if(previous?.session!==state.session)return previous;
      const byNumber=new Map(previous.byNumber);
      byNumber.set(String(number),[result.username]);
      return {...previous,byNumber};
    });
    return result;
  },[state,load]);

  const current=enabled && state?.session===session ? state : null;
  return {
    ready:!!current,
    users:current?.users??[],
    assigneesOf:number=>current?.byNumber.get(String(number))??[],
    reassign
  };
}
