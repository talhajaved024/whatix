import test from 'node:test';
import assert from 'node:assert/strict';
import {busyResponder,holdingReplies,followUpReplies} from '../src/busy-replies.js';

// Manual clock and timers so the 2-minute delay runs instantly.
function harness({online=true}={}){
  let clock=1_000_000,nextId=0;const pending=new Map(),sent=[];
  const timers={setTimeout:(fn,ms)=>{const id=++nextId;pending.set(id,{fn,at:clock+ms});return id;},clearTimeout:id=>pending.delete(id)};
  const state={online};
  const busy=busyResponder({session:'s',staffOnline:()=>state.online,now:()=>clock,timers,delayMs:120000,followUpGapMs:300000,engagedMs:600000,cooldownMs:1800000,
    phoneFor:async lid=>lid==='77@lid'?923001112222:null,send:async(chatId,text)=>sent.push({chatId,text})});
  let msg=0;
  return {busy,sent,state,
    message:(from,body='Hello')=>busy.handle({session:'s',event:'message',payload:{from,fromMe:false,id:'m'+(++msg),body,timestamp:Math.floor(clock/1000)}}),
    async advance(ms){clock+=ms;for(const [id,timer] of [...pending])if(timer.at<=clock){pending.delete(id);await timer.fn();}}};
}

test('an unattended chat gets a holding reply, then one apologetic follow-up if the client writes again',async()=>{
  const h=harness();
  await h.message('923001234567@c.us','Hi, I need a website');
  await h.advance(119000);
  assert.equal(h.sent.length,0);
  await h.advance(1000);
  assert.equal(h.sent.length,1);
  assert.equal(h.sent[0].chatId,'923001234567@c.us');
  assert.equal(h.sent[0].text,holdingReplies[0]+'\n\n*this message is Auto Generated*');
  // The client writes again a minute later: the follow-up waits until five
  // minutes after the first holding reply, then apologises warmly.
  await h.advance(60000);
  await h.message('923001234567@c.us','Hello?');
  await h.advance(180000);
  assert.equal(h.sent.length,1);
  await h.advance(60000);
  assert.equal(h.sent.length,2);
  assert.equal(h.sent[1].text,followUpReplies[0]+'\n\n*this message is Auto Generated*');
  assert.match(h.sent[1].text,/apologise/);
  // Further messages within the cooldown stay quiet: no flood of automatic replies.
  await h.message('923001234567@c.us','Anyone??');
  await h.advance(600000);
  assert.equal(h.sent.length,2);
  // Still unattended after the cooldown: one more apologetic follow-up.
  await h.advance(1800000);
  await h.message('923001234567@c.us','Still waiting');
  await h.advance(120000);
  assert.equal(h.sent.length,3);
  assert.equal(h.sent[2].text.startsWith(followUpReplies[1]),true);
});

test('attending the chat resets the cycle: the next wait starts with the normal holding reply again',async()=>{
  const h=harness();
  await h.message('923004444444@c.us');
  await h.advance(120000);
  await h.busy.attended('923004444444@c.us');            // a representative replied
  await h.advance(700000);                               // then left it unanswered again
  await h.message('923004444444@c.us','One more question');
  await h.advance(120000);
  assert.equal(h.sent.length,2);
  assert.equal(followUpReplies.some(text=>h.sent[1].text.startsWith(text)),false);
  assert.equal(holdingReplies.some(text=>h.sent[1].text.startsWith(text)),true);
});

test('the chat a representative is handling (ClientA) is left alone while ClientB gets the holding reply',async()=>{
  const h=harness();
  await h.busy.attended('923000000001@c.us');           // staff replied to ClientA
  await h.message('923000000001@c.us','Thanks, and the price?');
  await h.message('923000000002@c.us','Assalamu Alaikum, anyone there?');
  await h.advance(120000);
  assert.deepEqual(h.sent.map(s=>s.chatId),['923000000002@c.us']);
  assert.match(h.sent[0].text,/^Wa Alaikum as-Salaam! /);
});

test('opening or answering the chat before the delay cancels the holding reply; a later stretch can get one again',async()=>{
  const h=harness();
  await h.message('923005555555@c.us');
  await h.advance(60000);
  await h.busy.attended('923005555555');                  // staff opened the chat
  await h.advance(120000);
  assert.equal(h.sent.length,0);
  // Long after the staff member left the chat, a new unattended message is held again.
  await h.advance(700000);
  await h.message('923005555555@c.us','Following up');
  await h.advance(120000);
  assert.equal(h.sent.length,1);
  assert.equal(h.sent[0].text.startsWith(holdingReplies[0]),true);
});

test('no holding replies while nobody is signed in, or if everyone signs out before the delay',async()=>{
  const h=harness({online:false});
  await h.message('923006666666@c.us');
  await h.advance(120000);
  assert.equal(h.sent.length,0);
  h.state.online=true;
  await h.message('923007777777@c.us');
  h.state.online=false;                                   // the offline AI responder takes over
  await h.advance(120000);
  assert.equal(h.sent.length,0);
});

test('a linked-ID sender is matched to the phone a staff member opened; groups and own messages are ignored',async()=>{
  const h=harness();
  await h.message('77@lid');
  await h.busy.attended('923001112222@c.us');
  await h.busy.handle({session:'s',event:'message',payload:{from:'1203@g.us',fromMe:false,id:'g1',body:'hi',timestamp:1000}});
  await h.busy.handle({session:'s',event:'message',payload:{from:'923008888888@c.us',fromMe:true,id:'o1',body:'hi',timestamp:1000}});
  await h.advance(120000);
  assert.equal(h.sent.length,0);
});

test('a sent holding reply raises a waiting notification; attending the chat clears it',async()=>{
  const {waitingAlerts}=await import('../src/waiting-alerts.js');
  const alerts=waitingAlerts({now:()=>42});
  const events=[];
  alerts.subscribe((name,data)=>events.push([name,data]));
  let clock=0;const pending=[];
  const busy=busyResponder({session:'s',staffOnline:()=>true,now:()=>clock,
    timers:{setTimeout:fn=>{pending.push(fn);return pending.length;},clearTimeout:()=>{pending.length=0;}},
    phoneFor:async()=>null,send:async()=>{},onHeld:(chatId,key)=>alerts.add(chatId,key),onAttended:key=>alerts.clear(key)});
  await busy.handle({session:'s',event:'message',payload:{from:'923245698765@c.us',fromMe:false,id:'w1',body:'Hi',timestamp:0}});
  assert.equal(alerts.list().length,0);                     // nothing until the holding reply is sent
  clock=60000;await pending.shift()();
  assert.deepEqual(alerts.list(),[{id:'923245698765',chatId:'923245698765@c.us',phoneNumber:'+923245698765',openKey:'923245698765',since:42}]);
  assert.equal(events[0][0],'client.waiting');
  await busy.attended('923245698765@c.us');
  assert.deepEqual(alerts.list(),[]);
  assert.deepEqual(events.at(-1),['client.attended',{id:'923245698765'}]);
});

test('a failed holding reply does not raise a notification',async()=>{
  const added=[];let fire;
  const busy=busyResponder({session:'s',staffOnline:()=>true,now:()=>0,timers:{setTimeout:fn=>{fire=fn;return 1;},clearTimeout:()=>{}},
    phoneFor:async()=>null,send:async()=>{throw Object.assign(Error('down'),{statusCode:502});},onHeld:(...args)=>added.push(args)});
  const warn=console.warn;console.warn=()=>{};
  try{
    await busy.handle({session:'s',event:'message',payload:{from:'923001234567@c.us',fromMe:false,id:'f1',body:'Hi',timestamp:0}});
    await fire();
  }finally{console.warn=warn;}
  assert.deepEqual(added,[]);
});
