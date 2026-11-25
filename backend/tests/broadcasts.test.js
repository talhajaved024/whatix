import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testDatabase} from './test-database.js';
import {records} from '../src/sqlite.js';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import express from 'express';
import {broadcastQueue,broadcastSender} from '../src/broadcasts.js';

test('broadcast threshold, deduplication, progress, restart and uncertain sends', {timeout:20000}, async t=>{
  const store=records(await testDatabase(t),'broadcasts:test');
  const attempts=[];
  const send=async(job,number,body)=>{
    attempts.push(number);
    assert.equal(body.file.data,'AQID');
    return number==='10000002@c.us'?{ok:false,error:'WAHA HTTP 422'}:{ok:true,id:'sent-'+number};
  };
  const app=express();
  app.use(express.json());
  let queue=await broadcastQueue(store,{send,canSend:async()=>true});
  app.use((req,res,next)=>{req.userId=Number(req.headers.owner || 1);queue.router(req,res,next);});
  const server=app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>{queue.close();server.close();});
  const base='http://127.0.0.1:'+server.address().port;
  const recipients=Array.from({length:20},(_,i)=>String(10000000+i));
  const data={id:randomUUID(),kind:'document',file:{filename:'sample',mimetype:'application/octet-stream',data:'AQID'},text:'caption',recipients};
  const post=body=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const status=()=>fetch(base+'/'+data.id).then(r=>r.json());
  const waitFor=async expected=>{
    for(let i=0;i<200;i++){const state=await status();if(state.status===expected)return state;await delay(15);}
    assert.fail('Did not reach '+expected);
  };
  assert.equal((await post({...data,recipients:[...recipients.slice(0,10),recipients[0]+'@s.whatsapp.net']})).status,400);
  const responses=await Promise.all([post(data),post(data)]);
  assert.deepEqual(responses.map(r=>r.status),[202,202]);
  assert.equal((await post({...data,text:'different'})).status,409);
  assert.equal((await fetch(base+'/'+data.id,{headers:{owner:'2'}})).status,404);
  const before=Date.now();
  const waiting=await waitFor('waiting');
  assert.ok(waiting.processed>=10 && waiting.processed<=15);
  assert.ok(waiting.nextBatchAt>=before+600000-1000 && waiting.nextBatchAt<=Date.now()+1200000);
  assert.equal(waiting.unsuccessful,1);
  queue.close();
  const stateFile='1-'+data.id+'.json';
  const job=JSON.parse(await store.get(stateFile));
  // Simulate restart after the first send of the second chunk left the process.
  job.nextBatchAt=0;job.inFlight=true;
  await store.put(stateFile,JSON.stringify(job));
  queue=await broadcastQueue(store,{send,canSend:async()=>true});
  const finished=await waitFor('completed_with_errors');
  assert.equal(finished.processed,20);
  assert.equal(finished.sent,18);
  assert.equal(finished.unsuccessful,2);
  assert.equal(new Set(attempts).size,19);
  assert.equal(attempts.length,19);
  assert.equal(finished.results[waiting.processed].error,'Delivery unconfirmed after interruption');
  assert.equal((await post(data)).status,202);
  assert.ok(!(await store.keys()).some(f=>f.endsWith('.payload')));
});

test('worker sends text and media to WAHA with configured session and records sender ownership',async t=>{
  const app=express();
  app.use(express.json());
  const received=[];
  app.post('/api/:route',(req,res)=>{
    received.push([req.params.route,req.body,req.headers['x-api-key']]);
    res.json({id:{_serialized:'receipt'},ack:1});
  });
  const server=app.listen(0,'127.0.0.1');
  await once(server,'listening');t.after(()=>server.close());
  const records=[];
  const send=broadcastSender('http://127.0.0.1:'+server.address().port,'test',()=>({'X-Api-Key':'fixture'}),{record:(...args)=>records.push(args)});
  for(const [kind,route,body] of [['text','sendText',{text:'Hello'}],['image','sendImage',{file:{data:'AQID'},caption:'Hello'}]]){
    const result=await send({kind,owner:7},'123@lid',body);
    assert.deepEqual(result,{ok:true,id:'receipt',ack:1});
    assert.deepEqual(received.at(-1),[route,{...body,session:'test',chatId:'123@lid'},'fixture']);
    assert.deepEqual(records.at(-1),['receipt','123@lid',7]);
  }
});

test('170 recipients complete in bounded chunks with the saved gap between each pair', {timeout:20000}, async t=>{
  const store=records(await testDatabase(t),'broadcasts:test');
  let now=Date.now();
  t.mock.method(Date,'now',()=>now);
  const sent=[];
  const options={canSend:async()=>true,send:async(_job,number)=>{sent.push(number);return {ok:true};}};
  let queue=await broadcastQueue(store,options);
  const app=express();
  app.use(express.json(),(req,res,next)=>{req.userId=1;queue.router(req,res,next);});
  const server=app.listen(0,'127.0.0.1');
  await once(server,'listening');t.after(()=>{queue.close();server.close();});
  const base='http://127.0.0.1:'+server.address().port;
  const recipients=Array.from({length:170},(_,i)=>String(100000+i));
  const id=randomUUID();
  const response=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,recipients,kind:'text',text:'Hello'})});
  assert.equal(response.status,202);
  let processed=0;
  while(processed<170){
    let state;
    for(let i=0;i<300;i++){
      state=await fetch(base+'/'+id).then(r=>r.json());
      if(['waiting','completed'].includes(state.status))break;
      await delay(10);
    }
    const size=state.processed-processed;
    assert.ok(size>0 && size<=15);
    processed=state.processed;
    if(state.status==='completed'){assert.equal(state.sent,170);break;}
    assert.equal(state.status,'waiting');
    assert.ok(size>=10);
    assert.ok(state.nextBatchAt-now>=600000 && state.nextBatchAt-now<=1200000);
    queue.close();
    now=state.nextBatchAt;
    queue=await broadcastQueue(store,options);
  }
  assert.deepEqual(sent,recipients.map(number=>number+'@c.us'));
});
