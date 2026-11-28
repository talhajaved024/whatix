import {senderPhone} from './offline-requirements.js';

// The whole chat list of one inbox in a single answer, for admins.
//
// The browser used to build this itself: the chat overview 50 rows at a time,
// then one request per chat whose latest row is a system notice (to tell a real
// conversation from a notice-only one), then one per linked ID. On a number with
// ~230 chats that was over 100 requests, each paying the trip from the browser
// to the server, and the list took about 11 s to settle. Here the same calls are
// made next to WAHA and the result is shared:
//
// - `chats`:  WAHA's overview rows, unchanged.
// - `recent`: for each chat whose latest row is a system notice, its newest 10
//             rows (media not downloaded). A chat missing here could not be
//             read and is kept by the browser, as before.
// - `phones`: only when asked: linked ID digits -> phone digits, for the direct
//             chats that are known by linked ID.
//
// A build is reused for `ttlMs` unless a message arrived since (invalidate()),
// and concurrent requests share one build. Callers that only need who the
// contacts are (the Assign Contacts list) pass {stale:true} and accept a build
// up to `staleMs` old.
const listed=/^\d+@(?:c\.us|lid|s\.whatsapp\.net)$|^\d+(?:-\d+)?@g\.us$/;
// Same list as the browser's waha-history.js: rows WhatsApp keeps in a chat
// that were never sent or received.
const systemRows=new Set(['e2e_notification','notification_template','notification','gp2','protocol',
  'broadcast_notification','pinned_message','keep_in_chat','reaction','debug','newsletter_notification']);
export const isSystemRow=msg=>systemRows.has(msg?._data?.type || msg?.type || '');
const idOf=chat=>typeof chat?.id==='string'?chat.id:chat?.id?._serialized || '';
const LID_CACHE=5000,MAX_CHATS=10000;

export function chatList({base,session,headers,ttlMs=15000,staleMs=600000,pageSize=50,workers=6,now=Date.now,
  request=(...args)=>fetch(...args),lidPhone=id=>senderPhone(id,base,session,headers)}){
  const root=base+'/api/'+encodeURIComponent(session);
  async function json(path,timeoutMs){
    const response=await request(root+path,{headers:headers(),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok){await response.body?.cancel();throw Error('WAHA answered HTTP '+response.status);}
    return response.json();
  }
  // A few at a time: WAHA answers from one browser page.
  async function each(items,work){
    const queue=[...items];
    await Promise.all(Array.from({length:Math.min(workers,queue.length)},async()=>{
      while(queue.length)await work(queue.shift());
    }));
  }
  async function build(){
    const chats=[];
    for(let offset=0;offset<MAX_CHATS;offset+=pageSize){
      const page=await json('/chats/overview?limit='+pageSize+'&offset='+offset,20000);
      if(!Array.isArray(page))throw Error('WAHA returned an invalid chat list');
      chats.push(...page);
      if(page.length<pageSize)break;
    }
    const recent={};
    await each(chats.filter(chat=>listed.test(idOf(chat)) && isSystemRow(chat.lastMessage)),async chat=>{
      const id=idOf(chat);
      try{
        const rows=await json('/chats/'+encodeURIComponent(id)+'/messages?limit=10&offset=0&downloadMedia=false',8000);
        if(Array.isArray(rows))recent[id]=rows;
      }catch{ /* unreadable: the browser keeps the chat */ }
    });
    return {chats,recent};
  }
  // A linked ID's phone never changes; unknown ones are asked again next time.
  const lidPhones=new Map();
  async function phonesFor(chats){
    const found={};
    const lids=new Set(chats.map(chat=>/^(\d+)@lid$/.exec(idOf(chat))?.[1]).filter(Boolean));
    await each(lids,async lid=>{
      let phone=lidPhones.get(lid);
      if(!phone){
        try{phone=await lidPhone(lid+'@lid');}catch{phone=null;}
        if(!phone)return;
        phone=String(phone);
        if(lidPhones.size>=LID_CACHE)lidPhones.delete(lidPhones.keys().next().value);
        lidPhones.set(lid,phone);
      }
      found[lid]=phone;
    });
    return found;
  }
  let cached=null,pending=null,version=0;
  function load(account){
    if(pending && pending.account===account)return pending.build;
    const started=version;
    const current={account};
    current.build=build().then(data=>{
      const entry={...data,account,at:now(),dirty:version!==started};
      // A build for an account that has since been replaced is answered, never kept.
      if(pending===current)cached=entry;
      return entry;
    }).finally(()=>{if(pending===current)pending=null;});
    pending=current;
    return current.build;
  }
  // `account` says whose chats these are (the phone the session is paired to).
  // Nothing built for one account is ever answered for another: a session name
  // re-paired to a different phone starts from nothing.
  async function get({stale=false,phones=false,account}={}){
    if(cached && cached.account!==account)reset();
    const age=cached?now()-cached.at:Infinity;
    const entry=cached && (stale?age<staleMs:!cached.dirty && age<ttlMs)?cached:await load(account);
    const answer={chats:entry.chats,recent:entry.recent};
    if(phones)answer.phones=await (entry.phones??=phonesFor(entry.chats));
    return answer;
  }
  // A message arrived: the next list is built afresh (the contact list may still use this one).
  function invalidate(){version++;if(cached)cached.dirty=true;}
  // The session itself changed (disconnected, re-paired): forget everything.
  function reset(){version++;cached=null;pending=null;lidPhones.clear();}
  return {get,invalidate,reset};
}
