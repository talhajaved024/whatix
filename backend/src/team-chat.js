// Real-time team chat between signed-in app users over a WebSocket.
//
// Nothing is written to the database. Online recipients get a message right
// away. For offline recipients it waits in this process's memory and is handed
// over (then dropped) the next time they connect; the sender, if connected,
// is told when that happens. A backend restart loses messages still waiting.
//
// Rules:
// - The super user and admins can message every other user. They can also send
//   one message to several regular users at once.
// - Regular users see and message admins, one at a time. They never see the
//   super user, except in a conversation the super user started with them,
//   and only until the super user closes it.
//
// Every day at 21:00 Pakistan time everything is reset: waiting messages, open
// super-user conversations and receipts are dropped, and browsers clear their chats.
//
// Message states shown to the sender: sent (accepted, recipient offline),
// delivered (reached the recipient's browser) and read (recipient opened it).
// For read receipts the server keeps only message IDs and who has yet to read
// them, never the text, so nobody can mark someone else's message read.
import { WebSocketServer } from 'ws';

export const CHAT_PATH='/api/team-chat';
const MAX_TEXT=4000;
const MAX_RECIPIENTS=500;
const RATE_WINDOW_MS=10_000;
const RATE_LIMIT=30;
const MAX_WAITING=500; // per offline recipient; the oldest drop first
const WAITING_MS=7*24*60*60*1000;
const MAX_TRACKED=20_000; // message IDs awaiting read receipts; the oldest drop first
// Every day at 21:00 Pakistan time (UTC+5, no daylight saving) all chat state is wiped.
const RESET_UTC_HOUR=16;

// The next 21:00 PKT strictly after `time` (ms).
export function nextReset(time){
  const day=new Date(time);
  const at=Date.UTC(day.getUTCFullYear(),day.getUTCMonth(),day.getUTCDate(),RESET_UTC_HOUR);
  return at>time?at:at+24*60*60*1000;
}

export const privileged=role=>role==='admin' || role==='super_user';
// May `from` message `to`? Both are {id, role}. `opened` holds the regular
// users the super user currently has a conversation with.
export function canMessage(from,to,opened=new Set()){
  if(!from || !to || from.id===to.id)return false;
  if(privileged(from.role))return true;
  if(to.role==='admin')return true;
  return to.role==='super_user' && opened.has(from.id);
}

function parseCookies(header=''){
  const cookies={};
  for(const part of header.split(';')){
    const at=part.indexOf('=');
    if(at<1)continue;
    try{cookies[part.slice(0,at).trim()]=decodeURIComponent(part.slice(at+1).trim());}catch{/* skip malformed cookie */}
  }
  return cookies;
}

function reject(socket,status,text){
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

// authenticate({cookies, headers}) -> null | {user:{id,username,name,role}, register(close) -> unregister}
// directory() -> Promise<[{id,username,name,role}]> of accounts allowed to chat.
export function teamChat({server,authenticate,directory,allowedOrigin,now=Date.now,pingMs=30_000,dailyReset=true}){
  const wss=new WebSocketServer({noServer:true,maxPayload:64*1024});
  const online=new Map(); // userId -> {user, sockets:Set<WebSocket>}
  const waiting=new Map(); // userId -> messages for when they next connect (memory only)
  const opened=new Set(); // regular userIds in a conversation started by the super user
  const unreadBy=new Map(); // messageId -> {from, readers:Set<userId>} for read receipts
  let sequence=0;
  let resetAt=nextReset(now())-24*60*60*1000; // the most recent 21:00 PKT
  const nextId=()=>now().toString(36)+'-'+(++sequence).toString(36);
  const allowed=(from,to)=>canMessage(from,to,opened);

  const send=(ws,payload)=>{if(ws.readyState===ws.OPEN)ws.send(JSON.stringify(payload));};
  const sendUser=(userId,payload,except)=>{
    const entry=online.get(userId);
    if(!entry)return false;
    for(const ws of entry.sockets)if(ws!==except)send(ws,payload);
    return true;
  };
  const publicUser=({id,username,name,role})=>({id,username,name,role});

  async function contactsFor(user){
    const accounts=await directory();
    return accounts.filter(account=>allowed(user,account))
      .map(account=>({...publicUser(account),online:online.has(account.id)}));
  }
  async function refreshContacts(userId){
    const entry=online.get(userId);
    if(!entry)return;
    try{sendUser(userId,{type:'contacts',contacts:await contactsFor(entry.user)});}catch{/* the next roster request retries */}
  }
  // Tell everyone who may talk to `user` that they came online or went offline.
  function announce(user,isOnline){
    for(const [id,entry] of online){
      if(id!==user.id && allowed(entry.user,user))
        for(const ws of entry.sockets)send(ws,{type:'presence',id:user.id,online:isOnline});
    }
  }
  function track(message){
    unreadBy.set(message.id,{from:message.from.id,readers:new Set(message.to)});
    if(unreadBy.size>MAX_TRACKED)unreadBy.delete(unreadBy.keys().next().value);
  }

  async function handleSend(ws,sender,input){
    const clientId=typeof input.clientId==='string'?input.clientId.slice(0,64):undefined;
    const fail=error=>send(ws,{type:'error',clientId,error});
    const text=typeof input.text==='string'?input.text.trim():'';
    if(!text)return fail('Type a message first.');
    if(text.length>MAX_TEXT)return fail(`Messages can be up to ${MAX_TEXT} characters.`);
    const ids=Array.isArray(input.to)?[...new Set(input.to)]:[];
    if(!ids.length || ids.length>MAX_RECIPIENTS || !ids.every(id=>Number.isSafeInteger(id) && id>0))
      return fail('Choose who should receive this message.');
    if(ids.length>1 && !privileged(sender.role))return fail('Only admins can message several people at once.');
    // Check every recipient against the account directory, online or not.
    let accounts;
    try{accounts=new Map((await directory()).map(account=>[account.id,account]));}
    catch{return fail('Contacts are unavailable right now. Try again.');}
    const recipients=[],queued=[];
    for(const id of ids){
      const account=accounts.get(id);
      if(!account)return fail('That user is no longer available.');
      if(!allowed(sender,account))return fail('You can only message admins.');
      if(ids.length>1 && privileged(account.role))return fail('Group messages can only go to regular users.');
      const entry=online.get(id);
      if(entry)recipients.push(entry.user);else queued.push(id);
    }
    // The super user writing to regular users starts a conversation they can see and answer.
    const started=sender.role==='super_user'?ids.filter(id=>accounts.get(id).role==='user' && !opened.has(id)):[];
    for(const id of started)opened.add(id);
    await Promise.all(started.map(refreshContacts));
    const message={type:'message',id:nextId(),from:publicUser(sender),to:ids,text,at:now(),group:ids.length>1};
    track(message);
    for(const user of recipients)sendUser(user.id,message);
    for(const id of queued){
      const list=waiting.get(id)??[];
      list.push(message);
      if(list.length>MAX_WAITING)list.shift();
      waiting.set(id,list);
    }
    // The sender's other tabs show the message as sent too.
    sendUser(sender.id,message,ws);
    send(ws,{type:'sent',clientId,id:message.id,at:message.at,to:ids,delivered:recipients.map(user=>user.id),queued});
  }
  // The reader opened these messages: tell each sender, once per message and reader.
  function handleRead(reader,ids){
    if(!Array.isArray(ids))return;
    const bySender=new Map();
    for(const id of ids.slice(0,500)){
      const record=typeof id==='string' && unreadBy.get(id);
      if(!record || !record.readers.delete(reader.id))continue;
      if(!record.readers.size)unreadBy.delete(id);
      if(!bySender.has(record.from))bySender.set(record.from,[]);
      bySender.get(record.from).push(id);
    }
    for(const [from,list] of bySender)sendUser(from,{type:'read',ids:list,by:reader.id,at:now()});
  }
  // The super user closed their chat with a regular user: it disappears for that user.
  function endConversation(superUser,userId,ws){
    if(superUser.role!=='super_user' || !opened.delete(userId))return;
    const list=waiting.get(userId);
    if(list){
      const rest=list.filter(message=>message.from.id!==superUser.id);
      if(rest.length)waiting.set(userId,rest);else waiting.delete(userId);
    }
    sendUser(userId,{type:'conversation-ended',id:superUser.id});
    sendUser(superUser.id,{type:'conversation-ended',id:userId},ws);
    refreshContacts(userId);
  }
  // Hand over messages that arrived while this user was offline, then forget them.
  function deliverWaiting(user){
    const list=waiting.get(user.id);
    if(!list)return;
    waiting.delete(user.id);
    const fresh=list.filter(message=>now()-message.at<WAITING_MS);
    for(const message of fresh){
      sendUser(user.id,{...message,waited:true});
      sendUser(message.from.id,{type:'delivered',id:message.id,to:user.id});
    }
  }
  // A deleted account will never collect or answer its messages.
  function forget(userId){waiting.delete(userId);opened.delete(userId);}

  function connected(ws,auth){
    const {user}=auth;
    let entry=online.get(user.id);
    const first=!entry;
    if(!entry)online.set(user.id,entry={user,sockets:new Set()});
    entry.user=user;
    entry.sockets.add(ws);
    ws.alive=true;
    const sent=[];
    let closed=false;
    const unregister=auth.register(reason=>{
      if(ws.readyState===ws.OPEN)ws.close(reason==='admin_revoked'?4001:4000,reason==='admin_revoked'?'Session revoked':'Session ended');
      else ws.terminate();
    });
    const me=()=>online.get(user.id)?.user??user;
    ws.on('pong',()=>{ws.alive=true;});
    ws.on('message',(raw,binary)=>{
      if(binary)return;
      let input;try{input=JSON.parse(raw.toString());}catch{return send(ws,{type:'error',error:'Malformed message.'});}
      if(input?.type==='roster')return contactsFor(me()).then(contacts=>send(ws,{type:'contacts',contacts}),()=>send(ws,{type:'error',error:'Contacts are unavailable right now.'}));
      if(input?.type==='read')return handleRead(me(),input.ids);
      if(input?.type==='close')return Number.isSafeInteger(input.with) && endConversation(me(),input.with,ws);
      if(input?.type!=='send')return;
      const t=now();
      while(sent.length && t-sent[0]>RATE_WINDOW_MS)sent.shift();
      if(sent.length>=RATE_LIMIT)return send(ws,{type:'error',clientId:input.clientId,error:'You are sending messages too quickly. Wait a few seconds.'});
      sent.push(t);
      handleSend(ws,me(),input).catch(()=>send(ws,{type:'error',clientId:input.clientId,error:'The message could not be sent.'}));
    });
    ws.on('close',()=>{
      if(closed)return;closed=true;
      unregister();
      entry.sockets.delete(ws);
      if(!entry.sockets.size && online.get(user.id)===entry){online.delete(user.id);announce(user,false);}
    });
    ws.on('error',()=>ws.terminate());
    if(first)announce(user,true);
    // The super user gets back the conversations still open, to see or close them.
    const conversations=user.role==='super_user'?[...opened]:undefined;
    contactsFor(user).then(contacts=>send(ws,{type:'hello',me:publicUser(user),contacts,conversations,resetAt}),
      ()=>send(ws,{type:'hello',me:publicUser(user),contacts:[],conversations,resetAt,error:'Contacts are unavailable right now.'}))
      .then(()=>{if(ws.readyState===ws.OPEN)deliverWaiting(user);});
  }

  function upgrade(req,socket,head){
    let pathname;
    try{pathname=new URL(req.url,'http://localhost').pathname;}catch{reject(socket,400,'Bad Request');return true;}
    if(pathname!==CHAT_PATH)return false;
    // Browsers always send Origin on WebSocket requests; block other sites.
    if(req.headers.origin && req.headers.origin!==allowedOrigin){reject(socket,403,'Forbidden');return true;}
    const auth=authenticate({cookies:parseCookies(req.headers.cookie),headers:req.headers});
    if(!auth){reject(socket,401,'Unauthorized');return true;}
    wss.handleUpgrade(req,socket,head,ws=>connected(ws,auth));
    return true;
  }
  server.on('upgrade',(req,socket,head)=>{
    if(!upgrade(req,socket,head))reject(socket,404,'Not Found');
  });
  // Drop connections that stopped answering (sleeping laptop, lost network).
  const heartbeat=setInterval(()=>{
    for(const ws of wss.clients){
      if(!ws.alive){ws.terminate();continue;}
      ws.alive=false;ws.ping();
    }
  },pingMs);
  heartbeat.unref();
  // Nightly clean state: forget waiting messages, open super-user conversations
  // and read-receipt records, and tell every browser to clear its chats.
  function reset(){
    resetAt=now();
    waiting.clear();opened.clear();unreadBy.clear();
    for(const [userId] of online){sendUser(userId,{type:'reset',at:resetAt});refreshContacts(userId);}
  }
  let resetTimer;
  const scheduleReset=()=>{
    resetTimer=setTimeout(()=>{reset();scheduleReset();},Math.max(1000,nextReset(now())-now()));
    resetTimer.unref();
  };
  if(dailyReset)scheduleReset();
  server.once('close',()=>{clearTimeout(resetTimer);clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();wss.close();});
  return {
    online:()=>[...online.keys()],
    forget,
    reset,
    // An account's display name changed: future messages and contact lists use it.
    rename(userId,name){const entry=online.get(userId);if(entry)entry.user={...entry.user,name};}
  };
}
