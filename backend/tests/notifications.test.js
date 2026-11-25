import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { WebSocketServer } from 'ws';

// End to end: real server, mock WAHA. The super user sees every waiting
// client, a regular user only the clients assigned to them.
test('waiting-client notifications reach the super user and the assigned regular user live',{timeout:20000},async t=>{
  const holding=[];
  const reactions=[];
  const http=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='PUT' && url.pathname==='/api/reaction'){
      let body='';for await(const chunk of req)body+=chunk;
      reactions.push(JSON.parse(body));
      res.writeHead(204);return res.end();
    }
    if(url.pathname==='/api/sendText'){
      let data='';for await(const chunk of req)data+=chunk;
      holding.push(JSON.parse(data).chatId);
      res.setHeader('Content-Type','application/json');
      return res.end(JSON.stringify({id:'held-'+holding.length}));
    }
    res.writeHead(404);res.end('{}');
  });
  const waha=new WebSocketServer({server:http});
  http.listen(0,'127.0.0.1');await once(http,'listening');
  t.after(()=>{waha.close();http.close();});
  const directory=await mkdtemp(join(tmpdir(),'wa-notify-'));
  const password=randomUUID();
  const listener=once(waha,'connection');
  const child=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:'0',NODE_ENV:'test',ADMIN_USERNAME:'tester',ADMIN_PASSWORD:password,
    USER_WORKBOOK_PATH:join(directory,'users.xlsx'),WHATIX_DB_PATH:join(directory,'whatix.db'),APP_USERS_JSON:JSON.stringify(['alice','bob'].map(username=>({username,password}))),
    JWT_ACCESS_SECRET:randomUUID(),JWT_REFRESH_SECRET:randomUUID(),WAHA_API_KEY:'fixture',WAHA_URL:'http://127.0.0.1:'+http.address().port,
    WAHA_SESSION:'notify-test',OLLAMA_MODEL:'',BUSY_REPLIES_ENABLED:'true',BUSY_REPLY_DELAY_SECONDS:'0'},stdio:['ignore','pipe','inherit']});
  t.after(async()=>{
    if(child.exitCode===null && child.signalCode===null){
      const exited=once(child,'exit');child.kill();await exited;
    }
    await rm(directory,{recursive:true,force:true});
  });
  const [line]=await once(createInterface({input:child.stdout}),'line');
  await listener;
  const base='http://127.0.0.1:'+line.match(/listening on (\d+)/)[1]+'/api';
  const cookie=response=>response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const login=async username=>{
    const response=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({credentials:Buffer.from(JSON.stringify({username,password})).toString('base64')})});
    assert.equal(response.status,200,username);
    return cookie(response);
  };
  // Minimal SSE reader collecting [event, data] pairs.
  async function stream(Cookie){
    const response=await fetch(base+'/incoming-text',{headers:{Cookie}});
    assert.equal(response.status,200);
    const reader=response.body.getReader(),decoder=new TextDecoder(),events=[],signal=new EventEmitter();
    let buffer='';
    (async()=>{for(;;){
      const {value,done}=await reader.read().catch(()=>({done:true}));if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      for(let end;(end=buffer.indexOf('\n\n'))>=0;){
        const block=buffer.slice(0,end);buffer=buffer.slice(end+2);
        const data=/^data: (.*)$/m.exec(block)?.[1];
        if(data){events.push([/^event: (.+)$/m.exec(block)?.[1]??'message',JSON.parse(data)]);signal.emit('event');}
      }
    }})();
    t.after(()=>reader.cancel().catch(()=>{}));
    const named=name=>events.filter(([event])=>event===name).map(([,data])=>data);
    return {named,async until(test){while(!test())await Promise.race([once(signal,'event'),new Promise(r=>setTimeout(r,2000))]);}};
  }
  const superUser=await login('tester');
  const assigned=await fetch(base+'/admin/assigned-numbers',{method:'POST',headers:{Cookie:superUser,'Content-Type':'application/json'},
    body:JSON.stringify({phoneNumber:923001111111,username:'alice'})});
  assert.equal(assigned.status,201);
  const alice=await login('alice'),bob=await login('bob');
  // The header pill shows the account's full name (NAME column), kept live.
  const me=async Cookie=>(await (await fetch(base+'/auth/me',{headers:{Cookie}})).json()).name;
  assert.equal(await me(alice),'alice');                    // imported accounts default NAME to the username
  const aliceId=(await (await fetch(base+'/admin/users',{headers:{Cookie:superUser}})).json()).users.find(u=>u.username==='alice').id;
  assert.equal((await fetch(base+'/admin/users/'+aliceId,{method:'PATCH',headers:{Cookie:superUser,'Content-Type':'application/json'},
    body:JSON.stringify({name:'Alice Khan'})})).status,200);
  assert.equal(await me(alice),'Alice Khan');
  const streams={superUser:await stream(superUser),alice:await stream(alice),bob:await stream(bob)};
  for(const s of Object.values(streams))await s.until(()=>s.named('client.waiting.snapshot').length);
  for(const s of Object.values(streams))assert.deepEqual(s.named('client.waiting.snapshot')[0],[]);

  const send=from=>{for(const socket of waha.clients)socket.send(JSON.stringify({session:'notify-test',event:'message',
    payload:{id:'in-'+randomUUID(),from,fromMe:false,body:'Hello, anyone there?',timestamp:Math.floor(Date.now()/1000)}}));};
  send('923001111111@c.us');   // alice's client
  send('923009999999@c.us');   // unassigned client
  await streams.superUser.until(()=>streams.superUser.named('client.waiting').length>=2);
  await streams.alice.until(()=>streams.alice.named('client.waiting').length>=1);
  assert.deepEqual(holding.sort(),['923001111111@c.us','923009999999@c.us']);
  const phones=s=>s.named('client.waiting').map(alert=>alert.phoneNumber).sort();
  assert.deepEqual(phones(streams.superUser),['+923001111111','+923009999999']);
  assert.deepEqual(phones(streams.alice),['+923001111111']);
  assert.deepEqual(phones(streams.bob),[]);

  const messageId='false_923001111111@c.us_ABC';
  for(const text of ['👍','']){
    const react=Cookie=>fetch(base+'/reaction',{method:'PUT',headers:{Cookie,'Content-Type':'application/json'},
      body:JSON.stringify({messageId,reaction:text})});
    assert.equal((await react(bob)).status,403);
    assert.equal((await react(alice)).status,204);
    assert.deepEqual(reactions.at(-1),{session:'notify-test',messageId,reaction:text});
    for(const socket of waha.clients)socket.send(JSON.stringify({session:'notify-test',event:'message.reaction',
      payload:{fromMe:true,reaction:{messageId,text}}}));
    await streams.alice.until(()=>streams.alice.named('reaction').at(-1)?.text===text);
    assert.equal(streams.alice.named('reaction').at(-1).id,messageId);
    assert.deepEqual(streams.bob.named('reaction'),[]);
  }

  // Alice opens her client's chat: the notification clears for everyone.
  assert.equal((await fetch(base+'/chats/attended',{method:'POST',headers:{Cookie:alice,'Content-Type':'application/json'},
    body:JSON.stringify({chatId:'923001111111@c.us'})})).status,204);
  await streams.superUser.until(()=>streams.superUser.named('client.attended').length);
  await streams.alice.until(()=>streams.alice.named('client.attended').length);
  assert.deepEqual(streams.alice.named('client.attended'),[{id:'923001111111'}]);
  // A browser connecting now gets only what is still waiting, filtered per user.
  const lateSuper=await stream(superUser),lateAlice=await stream(alice);
  await lateSuper.until(()=>lateSuper.named('client.waiting.snapshot').length);
  await lateAlice.until(()=>lateAlice.named('client.waiting.snapshot').length);
  assert.deepEqual(lateSuper.named('client.waiting.snapshot')[0].map(alert=>alert.phoneNumber),['+923009999999']);
  assert.deepEqual(lateAlice.named('client.waiting.snapshot')[0],[]);
});
