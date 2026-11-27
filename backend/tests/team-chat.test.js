import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

// End to end: real server, mock WAHA. Team chat relays live between signed-in
// users with the role rules, and nothing reaches a user who is offline.
test('team chat relays messages live with role rules',{timeout:30000},async t=>{
  const http=createServer((_req,res)=>{res.writeHead(404);res.end('{}');});
  const waha=new WebSocketServer({server:http});
  http.listen(0,'127.0.0.1');await once(http,'listening');
  t.after(()=>{waha.close();http.close();});
  const directory=await mkdtemp(join(tmpdir(),'wa-team-chat-'));
  const password=randomUUID();
  const child=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:'0',NODE_ENV:'test',ADMIN_USERNAME:'tester',ADMIN_PASSWORD:password,
    USER_WORKBOOK_PATH:join(directory,'users.xlsx'),WHATIX_DB_PATH:join(directory,'whatix.db'),
    APP_USERS_JSON:JSON.stringify(['alice','bob','dave'].map(username=>({username,password}))),
    JWT_ACCESS_SECRET:randomUUID(),JWT_REFRESH_SECRET:randomUUID(),WAHA_API_KEY:'fixture',WAHA_URL:'http://127.0.0.1:'+http.address().port,
    WAHA_SESSION:'chat-test',OLLAMA_MODEL:'',BUSY_REPLIES_ENABLED:'false',FRONTEND_ORIGIN:'http://app.test'},stdio:['ignore','pipe','inherit']});
  t.after(async()=>{
    if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
    await rm(directory,{recursive:true,force:true});
  });
  const [line]=await once(createInterface({input:child.stdout}),'line');
  const port=line.match(/listening on (\d+)/)[1];
  const base='http://127.0.0.1:'+port+'/api';
  const cookie=response=>response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const login=async username=>{
    const response=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({credentials:Buffer.from(JSON.stringify({username,password})).toString('base64')})});
    assert.equal(response.status,200,username);
    return cookie(response);
  };
  const superCookie=await login('tester');
  const created=await fetch(base+'/admin/users',{method:'POST',headers:{Cookie:superCookie,'Content-Type':'application/json'},
    body:JSON.stringify({username:'carol',name:'Carol Admin',password,phoneNumber:923001110043,isAdmin:true})});
  assert.equal(created.status,201);

  async function connect(Cookie,headers={}){
    const ws=new WebSocket('ws://127.0.0.1:'+port+'/api/team-chat',{headers:{Cookie,...headers}});
    const inbox=[];let wake=()=>{};
    ws.on('message',raw=>{inbox.push(JSON.parse(raw.toString()));wake();});
    t.after(()=>ws.terminate());
    await once(ws,'open');
    return {ws,inbox,
      send:payload=>ws.send(JSON.stringify(payload)),
      async next(type){
        const deadline=Date.now()+5000;
        for(;;){
          const at=inbox.findIndex(item=>item.type===type);
          if(at>=0)return inbox.splice(at,1)[0];
          if(Date.now()>deadline)throw Error('Timed out waiting for '+type);
          await new Promise(resolve=>{wake=resolve;setTimeout(resolve,200);});
        }
      }};
  }
  // Unauthenticated and cross-site upgrades are refused.
  const anonymous=new WebSocket('ws://127.0.0.1:'+port+'/api/team-chat');
  const [, anonResponse]=await once(anonymous,'unexpected-response');
  assert.equal(anonResponse.statusCode,401);
  const foreign=new WebSocket('ws://127.0.0.1:'+port+'/api/team-chat',{headers:{Cookie:superCookie,Origin:'http://evil.test'}});
  const [, foreignResponse]=await once(foreign,'unexpected-response');
  assert.equal(foreignResponse.statusCode,403);

  const tester=await connect(superCookie,{Origin:'http://app.test'});
  const hello=await tester.next('hello');
  assert.equal(hello.me.role,'super_user');
  assert.deepEqual(hello.contacts.map(c=>c.username).sort(),['alice','bob','carol','dave']);
  const id=name=>hello.contacts.find(c=>c.username===name).id;

  const aliceCookie=await login('alice');
  const alice=await connect(aliceCookie);
  const aliceHello=await alice.next('hello');
  assert.deepEqual(aliceHello.contacts.map(c=>c.username),['carol'],'regular users see admins, not the super user');
  assert.deepEqual(await tester.next('presence'),{type:'presence',id:id('alice'),online:true});
  alice.send({type:'send',clientId:'r0',to:[hello.me.id],text:'hello boss'});
  assert.match((await alice.next('error')).error,/only message admins/,'no messaging the super user uninvited');
  const bob=await connect(await login('bob'));
  await bob.next('hello');
  assert.deepEqual(await tester.next('presence'),{type:'presence',id:id('bob'),online:true});

  // Group message from the super user to alice, bob and offline dave.
  tester.send({type:'send',clientId:'c1',to:[id('alice'),id('bob'),id('dave')],text:'Team meeting at 3'});
  const ack=await tester.next('sent');
  assert.equal(ack.clientId,'c1');
  assert.deepEqual(ack.delivered.sort(),[id('alice'),id('bob')].sort());
  assert.deepEqual(ack.queued,[id('dave')]);
  const toAlice=await alice.next('message');
  assert.equal(toAlice.text,'Team meeting at 3');
  assert.equal(toAlice.from.username,'tester');
  assert.equal(toAlice.group,true);
  assert.equal((await bob.next('message')).text,'Team meeting at 3');
  // The super user's message makes them visible to its recipients.
  assert.deepEqual((await alice.next('contacts')).contacts.map(c=>c.username).sort(),['carol','tester']);

  // Read receipts reach the sender once per reader.
  alice.send({type:'read',ids:[toAlice.id]});
  const read=await tester.next('read');
  assert.deepEqual([read.ids,read.by],[[ack.id],id('alice')]);
  alice.send({type:'read',ids:[toAlice.id]});
  bob.send({type:'read',ids:['made-up-id']});
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(tester.inbox.filter(item=>item.type==='read').length,0,'no repeated or invented receipts');

  // Regular users reply to an admin, but cannot message each other or several people.
  alice.send({type:'send',clientId:'r1',to:[hello.me.id],text:'On my way'});
  assert.deepEqual((await alice.next('sent')).delivered,[hello.me.id]);
  const reply=await tester.next('message');
  assert.equal(reply.text,'On my way');
  assert.equal(reply.from.username,'alice');
  alice.send({type:'send',clientId:'r2',to:[id('bob')],text:'psst'});
  assert.match((await alice.next('error')).error,/only message admins/);
  alice.send({type:'send',clientId:'r3',to:[id('dave')],text:'offline peer'});
  assert.match((await alice.next('error')).error,/only message admins/,'offline regular users are refused too');
  alice.send({type:'send',clientId:'r4',to:[hello.me.id,id('carol')],text:'both'});
  assert.match((await alice.next('error')).error,/several people/);
  // Admins cannot be part of a group message.
  tester.send({type:'send',clientId:'c2',to:[id('alice'),id('carol')],text:'mixed'});
  assert.match((await tester.next('error')).error,/regular users/);
  assert.equal(bob.inbox.filter(item=>item.type==='message').length,0,'bob received nothing else');

  // Signing out closes the chat socket from the server side and tells contacts.
  const closed=once(alice.ws,'close');
  assert.equal((await fetch(base+'/auth/logout',{method:'POST',headers:{Cookie:aliceCookie}})).status,200);
  const [code]=await closed;
  assert.equal(code,4000);
  assert.deepEqual(await tester.next('presence'),{type:'presence',id:id('alice'),online:false});
  tester.send({type:'send',clientId:'c3',to:[id('alice')],text:'Are you there?'});
  const waitingAck=await tester.next('sent');
  assert.deepEqual(waitingAck.queued,[id('alice')]);
  assert.deepEqual(waitingAck.delivered,[]);

  // Offline users get their messages when they next sign in, and only once.
  const dave=await connect(await login('dave'));
  await dave.next('hello');
  const forDave=await dave.next('message');
  assert.equal(forDave.text,'Team meeting at 3');
  assert.equal(forDave.waited,true);
  assert.deepEqual(await tester.next('delivered'),{type:'delivered',id:ack.id,to:id('dave')});
  const aliceAgain=await login('alice');
  const alice2=await connect(aliceAgain);
  await alice2.next('hello');
  assert.equal((await alice2.next('message')).text,'Are you there?');
  assert.deepEqual(await tester.next('delivered'),{type:'delivered',id:waitingAck.id,to:id('alice')});
  const aliceTab=await connect(aliceAgain);
  await aliceTab.next('hello');
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(aliceTab.inbox.filter(item=>item.type==='message').length,0,'a waiting message is handed over once');

  // The super user ends the conversation: it vanishes for alice and she can no longer write.
  tester.send({type:'close',with:id('alice')});
  assert.deepEqual(await alice2.next('conversation-ended'),{type:'conversation-ended',id:hello.me.id});
  assert.deepEqual((await alice2.next('contacts')).contacts.map(c=>c.username),['carol']);
  alice2.send({type:'send',clientId:'r5',to:[hello.me.id],text:'one more thing'});
  assert.match((await alice2.next('error')).error,/only message admins/);
  // A reconnecting super user gets the conversations still open (bob's and dave's).
  const testerTab=await connect(superCookie);
  assert.deepEqual((await testerTab.next('hello')).conversations.sort(),[id('bob'),id('dave')].sort());
});
