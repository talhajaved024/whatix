import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { nextReset, teamChat } from '../src/team-chat.js';

test('the daily reset falls at 21:00 Pakistan time (16:00 UTC)',()=>{
  const at=iso=>Date.parse(iso);
  assert.equal(nextReset(at('2026-11-24T10:00:00Z')),at('2026-11-24T16:00:00Z'),'morning: tonight at 9 PM PKT');
  assert.equal(nextReset(at('2026-11-24T15:59:59Z')),at('2026-11-24T16:00:00Z'));
  assert.equal(nextReset(at('2026-11-24T16:00:00Z')),at('2026-11-25T16:00:00Z'),'exactly 9 PM: the next one is tomorrow');
  assert.equal(nextReset(at('2026-11-24T20:30:00Z')),at('2026-11-25T16:00:00Z'),'after midnight PKT still waits for 9 PM');
  assert.equal(nextReset(at('2026-12-31T18:00:00Z')),at('2027-01-01T16:00:00Z'),'year boundary');
});

test('reset clears waiting messages and super-user conversations and tells every browser',{timeout:10000},async t=>{
  const users={1:{id:1,username:'boss',name:'Boss',role:'super_user'},2:{id:2,username:'ann',name:'Ann',role:'user'},3:{id:3,username:'ben',name:'Ben',role:'user'}};
  const http=createServer();
  const chat=teamChat({server:http,allowedOrigin:'http://app.test',dailyReset:false,
    authenticate:({cookies})=>users[cookies.uid]?{user:users[cookies.uid],register:()=>()=>{}}:null,
    directory:async()=>Object.values(users)});
  http.listen(0,'127.0.0.1');await once(http,'listening');
  t.after(()=>http.close());
  async function connect(uid){
    const ws=new WebSocket('ws://127.0.0.1:'+http.address().port+'/api/team-chat',{headers:{Cookie:'uid='+uid}});
    const inbox=[];let wake=()=>{};
    ws.on('message',raw=>{inbox.push(JSON.parse(raw.toString()));wake();});
    t.after(()=>ws.terminate());
    await once(ws,'open');
    return {ws,send:payload=>ws.send(JSON.stringify(payload)),async next(type){
      for(const deadline=Date.now()+3000;;){
        const at=inbox.findIndex(item=>item.type===type);
        if(at>=0)return inbox.splice(at,1)[0];
        if(Date.now()>deadline)throw Error('Timed out waiting for '+type);
        await new Promise(resolve=>{wake=resolve;setTimeout(resolve,100);});
      }
    }};
  }
  const boss=await connect(1);
  const firstHello=await boss.next('hello');
  assert.ok(firstHello.resetAt<Date.now(),'hello carries the last reset time');
  const ann=await connect(2);
  await ann.next('hello');
  boss.send({type:'send',clientId:'a',to:[2],text:'hi Ann'});
  boss.send({type:'send',clientId:'b',to:[3],text:'for Ben later'});
  await boss.next('sent');await boss.next('sent');
  assert.ok((await ann.next('contacts')).contacts.some(c=>c.role==='super_user'));

  chat.reset();
  const [bossReset,annReset]=[await boss.next('reset'),await ann.next('reset')];
  assert.equal(bossReset.at,annReset.at);
  assert.ok(!(await ann.next('contacts')).contacts.some(c=>c.role==='super_user'),'super user hidden again');
  ann.send({type:'send',clientId:'c',to:[1],text:'still there?'});
  assert.match((await ann.next('error')).error,/only message admins/);
  // Ben signs in after the reset: the waiting message is gone.
  const ben=await connect(3);
  const benHello=await ben.next('hello');
  assert.equal(benHello.resetAt,bossReset.at);
  await new Promise(resolve=>setTimeout(resolve,200));
  await assert.rejects(ben.next('message'),/Timed out/);
  const bossAgain=await connect(1);
  assert.deepEqual((await bossAgain.next('hello')).conversations,[],'no conversations reopen after the reset');
});
