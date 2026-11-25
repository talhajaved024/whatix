import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {once} from 'node:events';
import {testDatabase} from './test-database.js';
import {records} from '../src/sqlite.js';
import {labelDeletionRoutes} from '../src/label-deletion.js';

test('label deletion scopes, membership changes and retry after partial deletion',async t=>{
  const store=records(await testDatabase(t),'labels:mock');
  async function serve(app){
    const server=app.listen(0,'127.0.0.1');await once(server,'listening');
    t.after(()=>server.close());
    return 'http://127.0.0.1:'+server.address().port;
  }
  const waha=express(),labels=new Set(['1','2','3']),members=new Set(['111@lid','222@g.us']),removed=[];
  let fail=true;
  waha.get('/api/mock/labels',(_req,res)=>res.json([...labels].map(id=>({id}))));
  waha.get('/api/mock/labels/3/chats',(_req,res)=>res.json([...members].map(id=>({id:{_serialized:id}}))));
  waha.delete('/api/mock/chats/:id',(req,res)=>{
    if(fail && req.params.id==='222@g.us')return res.sendStatus(500);
    members.delete(req.params.id);removed.push(req.params.id);res.sendStatus(204);
  });
  waha.delete('/api/mock/labels/:id',(req,res)=>{labels.delete(req.params.id);res.sendStatus(204);});
  const app=express();app.use(express.json());
  app.use(labelDeletionRoutes({base:await serve(waha),session:'mock',store,
    headers:()=>({}),adminAccess:(_req,_res,next)=>next(),visible:()=>true}));
  const url=await serve(app);
  const del=(id,scope,expectedChats)=>fetch(url+'/'+id,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope,expectedChats})});
  assert.equal((await del('1','label')).status,200);
  assert.equal((await del('2','history')).status,200);
  assert.deepEqual(removed,[]);
  const preview=await (await fetch(url+'/3/deletion-preview')).json();
  assert.equal((await del('3','chats',['999@lid'])).status,409);
  assert.deepEqual(removed,[]);
  assert.equal((await del('3','chats',preview.chats)).status,502);
  assert.ok(labels.has('3'));
  assert.deepEqual(removed,['111@lid']);
  fail=false;
  assert.equal((await del('3','chats',[...members])).status,200);
  assert.deepEqual(removed,preview.chats);
  assert.equal(labels.size,0);
  const state=await (await fetch(url+'/history-changes')).json();
  assert.deepEqual(Object.keys(state.chats).sort(),preview.chats);
  assert.deepEqual(Object.values(state.labels).map(row=>row.scope),['label','history','chats']);
});
