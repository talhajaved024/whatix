// Live team chat client. Conversations exist only in this tab's memory, so a
// reload starts empty, and everything is cleared at 21:00 Pakistan time daily. Messages to offline users wait in the backend's memory
// until they sign in. See backend/src/team-chat.js.
//
// Outgoing message states: sending → sent (server has it, recipient offline)
// → delivered (reached their browser) → read (they opened it). failed if refused.
import {useCallback,useEffect,useMemo,useReducer,useRef} from 'react';
import {checkSession,sessionRevoked} from './auth.js';

export const GROUP='group';
export const isPrivileged=role=>role==='admin' || role==='super_user';
export const roleLabel=role=>role==='super_user'?'Super user':role==='admin'?'Admin':'';
export const initials=name=>String(name||'?').split(/\s+/).filter(Boolean).slice(0,2).map(word=>[...word][0].toUpperCase()).join('')||'?';
// Closing this chat ends it for the other person (super user ↔ regular user).
export const endsOnClose=(me,contact)=>me?.role==='super_user' && contact?.role==='user';

const RANK={sending:0,sent:1,delivered:2,read:3};
const advance=(item,status)=>item.status==='failed' || RANK[status]<=(RANK[item.status]??-1)?item:{...item,status};

const initial={status:'connecting',me:null,contacts:[],threads:new Map(),unread:new Map(),windows:[],groupLog:[],error:'',resetAt:0};
// The nightly 21:00 PKT reset wipes every conversation, window and chat notification.
const cleared=(state,resetAt)=>({...state,threads:new Map(),unread:new Map(),windows:[],groupLog:[],resetAt});
const append=(threads,id,item)=>new Map(threads).set(id,[...(threads.get(id)||[]),item]);
// Update the outgoing copies of one send (a group send has a copy in every recipient's thread).
function updateOutgoing(threads,clientId,ids,change){
  const next=new Map(threads);
  for(const id of ids){
    const list=next.get(id);
    if(list)next.set(id,list.map(item=>item.clientId===clientId?change(item,id):item));
  }
  return next;
}
// Advance the copy of message `id` in the thread with `peer`.
function advanceCopy(threads,peer,ids,status){
  const list=threads.get(peer);
  if(!list)return threads;
  const keys=new Set(ids.map(id=>id+':'+peer));
  return new Map(threads).set(peer,list.map(item=>keys.has(item.id)?advance(item,status):item));
}
const withoutKey=(map,key)=>{if(!map.has(key))return map;const next=new Map(map);next.delete(key);return next;};

function reducer(state,action){
  switch(action.type){
    case 'status':return {...state,status:action.status,
      contacts:action.status==='online'?state.contacts:state.contacts.map(c=>({...c,online:false}))};
    case 'hello':{
      // A reset happened while this tab was disconnected: start clean.
      if(state.resetAt && action.resetAt>state.resetAt)state=cleared(state,action.resetAt);
      // Conversations the super user still has open come back minimized.
      const open=new Set(state.windows.map(w=>w.id));
      const restored=(action.conversations||[]).filter(id=>!open.has(id)).map(id=>({id,minimized:true}));
      return {...state,status:'online',me:action.me,contacts:action.contacts,error:action.error||'',resetAt:action.resetAt||state.resetAt,windows:[...state.windows,...restored].slice(0,action.max)};
    }
    case 'contacts':return {...state,contacts:action.contacts};
    case 'presence':return {...state,contacts:state.contacts.map(c=>c.id===action.id?{...c,online:action.online}:c)};
    case 'incoming':{
      const m=action.message;
      if(state.me && m.from.id===state.me.id){
        // Sent from another tab of this account.
        let threads=state.threads;
        for(const id of m.to)threads=append(threads,id,{id:m.id+':'+id,mine:true,text:m.text,at:m.at,group:m.group,status:'sent'});
        return {...state,threads};
      }
      const unread=new Map(state.unread);
      const prev=unread.get(m.from.id);
      unread.set(m.from.id,{count:(prev?.count||0)+1,at:m.at,name:m.from.name});
      // Keep the sender in the contact list even if it was loaded before they existed.
      const known=state.contacts.some(c=>c.id===m.from.id);
      const contacts=known?state.contacts:[...state.contacts,{...m.from,online:true}];
      return {...state,contacts,unread,threads:append(state.threads,m.from.id,{id:m.id,mine:false,text:m.text,at:m.at,group:m.group,reported:false})};
    }
    case 'pending':{
      let threads=state.threads;
      for(const id of action.to)threads=append(threads,id,{id:action.clientId,clientId:action.clientId,mine:true,text:action.text,at:Date.now(),group:action.to.length>1,status:'sending'});
      const groupLog=action.to.length>1?[...state.groupLog,{clientId:action.clientId,to:action.to,text:action.text,at:Date.now(),status:'sending'}]:state.groupLog;
      return {...state,threads,groupLog};
    }
    case 'sent':{
      const reached=new Set(action.delivered);
      return {...state,
        threads:updateOutgoing(state.threads,action.clientId,action.to,(item,id)=>advance({...item,id:action.id+':'+id,at:action.at},reached.has(id)?'delivered':'sent')),
        groupLog:state.groupLog.map(entry=>entry.clientId===action.clientId?{...entry,status:'sent',delivered:action.delivered,queued:action.queued}:entry)};
    }
    // A message that waited for an offline user reached them when they signed in.
    case 'delivered':return {...state,threads:advanceCopy(state.threads,action.to,[action.id],'delivered')};
    case 'seen':return {...state,threads:advanceCopy(state.threads,action.by,action.ids,'read')};
    case 'failed':{
      const pending=[...state.threads.keys()];
      return {...state,
        threads:updateOutgoing(state.threads,action.clientId,pending,item=>({...item,status:'failed',error:action.error})),
        groupLog:state.groupLog.map(entry=>entry.clientId===action.clientId?{...entry,status:'failed',error:action.error}:entry)};
    }
    case 'reported':{
      const list=state.threads.get(action.peer);
      if(!list)return state;
      return {...state,threads:new Map(state.threads).set(action.peer,list.map(item=>item.mine || item.reported?item:{...item,reported:true}))};
    }
    case 'ended':{
      // The super user closed this conversation: for a regular user it disappears.
      const windows=state.windows.filter(w=>w.id!==action.id);
      if(isPrivileged(state.me?.role))return {...state,windows};
      return {...state,windows,threads:withoutKey(state.threads,action.id),unread:withoutKey(state.unread,action.id),
        contacts:state.contacts.filter(c=>c.id!==action.id)};
    }
    case 'reset':return cleared(state,action.at);
    case 'error':return {...state,error:action.error};
    case 'read':return state.unread.has(action.id)?{...state,unread:withoutKey(state.unread,action.id)}:state;
    case 'open':{
      const rest=state.windows.filter(w=>w.id!==action.id);
      // Newest window sits next to the launcher; the oldest drops off when full.
      return {...state,focus:action.id,focusTick:(state.focusTick||0)+1,windows:[{id:action.id,minimized:false},...rest].slice(0,action.max)};
    }
    case 'close':return {...state,windows:state.windows.filter(w=>w.id!==action.id)};
    case 'minimize':return {...state,windows:state.windows.map(w=>w.id===action.id?{...w,minimized:!w.minimized}:w)};
    case 'fit':return state.windows.length>action.max?{...state,windows:state.windows.slice(0,action.max)}:state;
    default:return state;
  }
}

const maxWindows=()=>{const w=window.innerWidth;return w<720?1:w<1100?2:3;};
const visible=()=>document.visibilityState==='visible' && document.hasFocus();

export function useTeamChat(){
  const [state,dispatch]=useReducer(reducer,initial);
  const socket=useRef(null);
  const counter=useRef(0);
  const latest=useRef(state);
  latest.current=state;
  const transmit=payload=>{
    const ws=socket.current;
    if(ws?.readyState!==WebSocket.OPEN)return false;
    ws.send(JSON.stringify(payload));
    return true;
  };
  useEffect(()=>{
    let stopped=false,timer,attempt=0;
    function connect(){
      dispatch({type:'status',status:'connecting'});
      const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/api/team-chat');
      socket.current=ws;
      ws.onmessage=event=>{
        let data;try{data=JSON.parse(event.data);}catch{return;}
        if(data.type==='hello'){attempt=0;dispatch({type:'hello',me:data.me,contacts:data.contacts,conversations:data.conversations,resetAt:data.resetAt,error:data.error,max:maxWindows()});}
        else if(data.type==='contacts')dispatch({type:'contacts',contacts:data.contacts});
        else if(data.type==='presence')dispatch({type:'presence',id:data.id,online:data.online});
        else if(data.type==='message')dispatch({type:'incoming',message:data});
        else if(data.type==='sent')dispatch({type:'sent',...data});
        else if(data.type==='delivered')dispatch({type:'delivered',id:data.id,to:data.to});
        else if(data.type==='read')dispatch({type:'seen',ids:data.ids,by:data.by});
        else if(data.type==='reset')dispatch({type:'reset',at:data.at});
        else if(data.type==='conversation-ended')dispatch({type:'ended',id:data.id});
        else if(data.type==='error')dispatch(data.clientId?{type:'failed',clientId:data.clientId,error:data.error}:{type:'error',error:data.error});
      };
      ws.onclose=event=>{
        if(socket.current===ws)socket.current=null;
        if(stopped)return;
        dispatch({type:'status',status:'offline'});
        if(event.code===4001){sessionRevoked();return;}
        // Upgrade refused (often an expired access token): let auth refresh first.
        const delay=Math.min(15000,1000*2**attempt++);
        timer=setTimeout(()=>{
          checkSession().then(ok=>ok,()=>true).then(ok=>{if(ok && !stopped)connect();});
        },delay);
      };
    }
    connect();
    return ()=>{stopped=true;clearTimeout(timer);socket.current?.close(1000);socket.current=null;};
  },[]);
  // Keep the number of open windows within what fits on screen.
  useEffect(()=>{
    const fit=()=>dispatch({type:'fit',max:maxWindows()});
    window.addEventListener('resize',fit);
    return ()=>window.removeEventListener('resize',fit);
  },[]);
  // Messages count as read once their window is open, expanded and the tab is in
  // front. The sender then gets a read receipt.
  useEffect(()=>{
    const markVisible=()=>{
      if(!visible())return;
      for(const w of state.windows){
        if(w.minimized)continue;
        if(state.unread.has(w.id))dispatch({type:'read',id:w.id});
        const ids=(state.threads.get(w.id)||[]).filter(item=>!item.mine && !item.reported).map(item=>item.id);
        if(ids.length && transmit({type:'read',ids}))dispatch({type:'reported',peer:w.id});
      }
    };
    markVisible();
    window.addEventListener('focus',markVisible);
    document.addEventListener('visibilitychange',markVisible);
    return ()=>{window.removeEventListener('focus',markVisible);document.removeEventListener('visibilitychange',markVisible);};
  },[state.windows,state.unread,state.threads]);

  const send=useCallback((to,text)=>{
    const clientId='c'+Date.now().toString(36)+(++counter.current);
    dispatch({type:'pending',clientId,to,text});
    if(!transmit({type:'send',clientId,to,text}))dispatch({type:'failed',clientId,error:'Not connected. Try again in a moment.'});
  },[]);
  const refreshContacts=useCallback(()=>{transmit({type:'roster'});},[]);
  const open=useCallback(id=>dispatch({type:'open',id,max:maxWindows()}),[]);
  const close=useCallback(id=>{
    const {me,contacts}=latest.current;
    // The super user closing a chat with a regular user ends it for them too.
    if(endsOnClose(me,contacts.find(c=>c.id===id)))transmit({type:'close',with:id});
    dispatch({type:'close',id});
  },[]);
  const minimize=useCallback(id=>dispatch({type:'minimize',id}),[]);
  const markRead=useCallback(id=>dispatch({type:'read',id}),[]);
  // Bell entries: "<name> sent you a message.", newest first.
  const alerts=useMemo(()=>[...state.unread].map(([id,entry])=>({id:'chat:'+id,contactId:id,name:entry.name,count:entry.count,since:entry.at}))
    .sort((a,b)=>b.since-a.since),[state.unread]);
  const unreadTotal=useMemo(()=>[...state.unread.values()].reduce((sum,entry)=>sum+entry.count,0),[state.unread]);
  return {...state,alerts,unreadTotal,send,refreshContacts,open,close,minimize,markRead};
}
