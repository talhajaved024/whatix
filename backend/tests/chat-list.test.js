import assert from 'node:assert/strict';
import test from 'node:test';
import {chatList} from '../src/chat-list.js';

const text=(id,body)=>({id,body,type:'chat',timestamp:1});
const notice={id:'n',type:'e2e_notification'};
// A fake WAHA: 3 chats per page keeps paging visible.
function waha(chats,messages={}){
  const calls=[];
  const request=async url=>{
    const {pathname,searchParams}=new URL(url);
    calls.push(pathname+'?'+searchParams);
    const reply=body=>({ok:true,status:200,json:async()=>body});
    if(pathname==='/api/S/chats/overview'){
      const offset=Number(searchParams.get('offset')),limit=Number(searchParams.get('limit'));
      return reply(chats.slice(offset,offset+limit));
    }
    const chat=/^\/api\/S\/chats\/(.+)\/messages$/.exec(pathname)?.[1];
    if(chat){
      const rows=messages[decodeURIComponent(chat)];
      if(!rows)return {ok:false,status:500,body:{cancel:async()=>{}}};
      assert.equal(searchParams.get('downloadMedia'),'false');
      return reply(rows);
    }
    throw Error('unexpected '+pathname);
  };
  return {request,calls,count:part=>calls.filter(call=>call.includes(part)).length};
}
const make=(fake,extra={})=>chatList({base:'http://waha',session:'S',headers:()=>({}),pageSize:3,request:fake.request,
  lidPhone:async()=>null,...extra});

test('the list is paged, and only notice-last chats are looked back',async()=>{
  const chats=[
    {id:'1@c.us',name:'One',lastMessage:text('a','hi')},
    {id:'2@lid',lastMessage:notice},                     // real conversation behind a notice
    {id:'3@c.us',lastMessage:notice},                    // notice-only
    {id:'4@c.us',lastMessage:notice},                    // lookup fails: kept by the browser
    {id:'120363@g.us',lastMessage:notice},
    {id:'status@broadcast',lastMessage:notice},          // not a listed chat: never looked back
    {id:'7@c.us',lastMessage:text('b','yo')}
  ];
  const fake=waha(chats,{'2@lid':[notice,text('c','hello')],'3@c.us':[notice],'120363@g.us':[text('d','team')]});
  const {chats:rows,recent,phones}=await make(fake).get();
  assert.deepEqual(rows,chats);
  assert.equal(fake.count('/chats/overview'),3);          // 3 + 3 + 1 rows
  assert.deepEqual(Object.keys(recent).sort(),['120363@g.us','2@lid','3@c.us']);
  assert.equal(recent['2@lid'].length,2);
  assert.equal(phones,undefined);
});

test('a build is shared, reused briefly, and rebuilt after a message',async()=>{
  let clock=1000;
  const fake=waha([{id:'1@c.us',lastMessage:text('a','hi')}]);
  const list=make(fake,{now:()=>clock,ttlMs:15000,staleMs:600000});
  await Promise.all([list.get(),list.get(),list.get()]);
  assert.equal(fake.count('/chats/overview'),1);          // concurrent requests share one build
  clock+=14000;await list.get();
  assert.equal(fake.count('/chats/overview'),1);          // still fresh
  clock+=2000;await list.get();
  assert.equal(fake.count('/chats/overview'),2);          // older than the lifetime
  list.invalidate();await list.get();
  assert.equal(fake.count('/chats/overview'),3);          // a message arrived
  list.invalidate();clock+=300000;await list.get({stale:true});
  assert.equal(fake.count('/chats/overview'),3);          // the contact list accepts an older build
  clock+=400000;await list.get({stale:true});
  assert.equal(fake.count('/chats/overview'),4);          // but not one that old
});

test('a message that arrives during a build leaves that build marked old',async()=>{
  const fake=waha([{id:'1@c.us',lastMessage:text('a','hi')}]);
  const list=make(fake);
  const first=list.get();
  list.invalidate();
  await first;
  await list.get();
  assert.equal(fake.count('/chats/overview'),2);
});

test('a list built for one account is never answered for another',async()=>{
  let chats=[{id:'1@c.us',lastMessage:text('a','first phone')},{id:'11@lid',lastMessage:text('b','x')}];
  let phone=923001111111;
  const fake={request:url=>waha(chats).request(url)};
  const list=make(fake,{lidPhone:async()=>phone});
  const first=await list.get({account:'111',phones:true});
  assert.equal(first.chats[0].lastMessage.body,'first phone');
  assert.deepEqual(first.phones,{'11':'923001111111'});
  // The same session name is paired to a different phone.
  chats=[{id:'2@c.us',lastMessage:text('c','second phone')},{id:'11@lid',lastMessage:text('d','y')}];phone=923002222222;
  for(const stale of [false,true]){
    const second=await list.get({account:'222',stale,phones:true});
    assert.deepEqual(second.chats.map(chat=>chat.id),['2@c.us','11@lid']);
    assert.deepEqual(second.phones,{'11':'923002222222'});   // not the first account's answer
  }
  // A build still running for the old account is not kept for the new one.
  const slow=list.get({account:'111'});
  const other=await list.get({account:'222',stale:true});
  await slow;
  assert.deepEqual(other.chats.map(chat=>chat.id),['2@c.us','11@lid']);
  assert.deepEqual((await list.get({account:'222',stale:true})).chats.map(chat=>chat.id),['2@c.us','11@lid']);
  // reset() (session status changed) drops even a list the contact screen would accept.
  chats=[{id:'3@c.us',lastMessage:text('e','after reset')}];
  list.reset();
  assert.deepEqual((await list.get({account:'222',stale:true})).chats.map(chat=>chat.id),['3@c.us']);
});

test('linked IDs are resolved once and only when asked',async()=>{
  const asked=[];
  const fake=waha([{id:'11@lid',lastMessage:text('a','x')},{id:'22@lid',lastMessage:text('b','y')},{id:'5@c.us',lastMessage:text('c','z')}]);
  const list=make(fake,{ttlMs:0,lidPhone:async id=>{asked.push(id);return id==='11@lid'?923001234567:null;}});
  await list.get();
  assert.deepEqual(asked,[]);
  assert.deepEqual((await list.get({phones:true})).phones,{'11':'923001234567'});
  assert.deepEqual(asked.sort(),['11@lid','22@lid']);
  assert.deepEqual((await list.get({phones:true})).phones,{'11':'923001234567'});
  assert.deepEqual(asked.sort(),['11@lid','22@lid','22@lid']);   // the known one is not asked again
});

test('a failed overview is an error, and the next request tries again',async()=>{
  let fail=true;
  const fake=waha([{id:'1@c.us',lastMessage:text('a','hi')}]);
  const list=make({request:url=>fail?Promise.resolve({ok:false,status:503,body:{cancel:async()=>{}}}):fake.request(url)});
  await assert.rejects(list.get());
  fail=false;
  assert.equal((await list.get()).chats.length,1);
});
