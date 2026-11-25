import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import test from 'node:test';
import {connectDatabase} from '../src/sqlite.js';

test('assigned numbers: admin management and per-user visibility', {timeout:20000}, async t => {
  const directory=await mkdtemp(join(tmpdir(),'wa-assigned-'));
  const password=randomUUID();
  const child=spawn(process.execPath,['src/server.js'],{env:{
    ...process.env, PORT:'0', NODE_ENV:'test', AWAY_REPLIES_ENABLED:'false', ADMIN_USERNAME:'tester', ADMIN_PASSWORD:password,
    USER_WORKBOOK_PATH:join(directory,'users.xlsx'),WHATIX_DB_PATH:join(directory,'whatix.db'),
    APP_USERS_JSON:JSON.stringify(['alice','bob'].map(username=>({username,password}))),
    JWT_ACCESS_SECRET:randomUUID(), JWT_REFRESH_SECRET:randomUUID(), WAHA_API_KEY:'fixture',
    WAHA_URL:'http://127.0.0.1:9', WAHA_SESSION:'assign-test'
  },stdio:['ignore','pipe','inherit']});
  t.after(async()=>{
    if(child.exitCode===null && child.signalCode===null){
      const exited=once(child,'exit');child.kill();await exited;
    }
    await rm(directory,{recursive:true,force:true});
  });
  const [line]=await once(createInterface({input:child.stdout}),'line');
  const base='http://127.0.0.1:'+line.match(/listening on (\d+)/)[1]+'/api';
  const cookie=response=>response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  async function login(username){
    const response=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({credentials:Buffer.from(JSON.stringify({username,password})).toString('base64')})});
    assert.equal(response.status,200,username+' login');
    return cookie(response);
  }
  const call=(Cookie,method,path,body)=>fetch(base+path,{method,headers:{Cookie,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
  const json=async response=>({status:response.status,body:response.status===204?null:await response.json()});

  const superUser=await login('tester');
  assert.equal((await call(superUser,'POST','/admin/users',{username:'carol',password,name:'Carol',isAdmin:true})).status,201);
  const admin=await login('carol');
  const alice=await login('alice');
  const bob=await login('bob');

  // Anonymous and regular users cannot manage.
  assert.equal((await call('','GET','/assigned-numbers')).status,401);
  assert.equal((await call(alice,'POST','/admin/assigned-numbers',{phoneNumber:923001234567,username:'alice'})).status,403);
  assert.deepEqual(await json(await call(alice,'GET','/assigned-numbers')),{status:200,body:{assignments:[]}});

  // Validation.
  assert.equal((await call(superUser,'POST','/admin/assigned-numbers',{phoneNumber:'923001234567',username:'alice'})).status,400);
  assert.equal((await call(superUser,'POST','/admin/assigned-numbers',{phoneNumber:1234567890123456,username:'alice'})).status,400);
  assert.equal((await call(superUser,'POST','/admin/assigned-numbers',{phoneNumber:923001234567})).status,400);
  for(const username of ['carol','tester','nobody'])
    assert.equal((await call(superUser,'POST','/admin/assigned-numbers',{phoneNumber:923001234567,username})).status,422,username);

  // Both admin roles can assign.
  assert.deepEqual(await json(await call(superUser,'POST','/admin/assigned-numbers',{phoneNumber:923001234567,username:'alice'})),
    {status:201,body:{id:1,phoneNumber:923001234567,username:'alice'}});
  assert.equal((await call(admin,'POST','/admin/assigned-numbers',{phoneNumber:923001234567,username:'alice'})).status,409);
  assert.equal((await call(admin,'POST','/admin/assigned-numbers',{phoneNumber:447700900123,username:'bob'})).status,201);
  assert.equal((await call(admin,'POST','/admin/assigned-numbers',{phoneNumber:15551234567,username:'alice'})).status,201);

  // Regular users only see their own rows, whatever query they send.
  const own=await json(await call(alice,'GET','/assigned-numbers?username=bob'));
  assert.deepEqual(own.body.assignments.map(a=>a.id),[1,3]);
  assert.deepEqual((await json(await call(bob,'GET','/assigned-numbers'))).body.assignments,[{id:2,phoneNumber:447700900123,username:'bob'}]);
  assert.equal((await json(await call(admin,'GET','/assigned-numbers'))).body.assignments.length,3);
  assert.equal((await json(await call(admin,'GET','/assigned-numbers?username=bob'))).body.assignments.length,1);

  // Get, update, conflicts.
  assert.equal((await call(admin,'GET','/admin/assigned-numbers/1')).status,200);
  assert.equal((await call(admin,'GET','/admin/assigned-numbers/99')).status,404);
  assert.equal((await call(admin,'GET','/admin/assigned-numbers/abc')).status,400);
  assert.equal((await call(alice,'GET','/admin/assigned-numbers/1')).status,403);
  assert.deepEqual((await json(await call(admin,'PATCH','/admin/assigned-numbers/1',{phoneNumber:923009999999}))).body,
    {id:1,phoneNumber:923009999999,username:'alice'});
  assert.equal((await call(admin,'PATCH','/admin/assigned-numbers/3',{phoneNumber:447700900123,username:'bob'})).status,409);
  assert.equal((await call(admin,'PATCH','/admin/assigned-numbers/3',{username:'carol'})).status,422);
  assert.equal((await call(admin,'PATCH','/admin/assigned-numbers/3',{note:'x'})).status,400);

  // Account rename and deletion carry over to assignments.
  const {users}=(await json(await call(superUser,'GET','/admin/users'))).body;
  const id=name=>users.find(u=>u.username===name).id;
  assert.equal((await call(superUser,'PATCH','/admin/users/'+id('alice'),{username:'alicia'})).status,200);
  assert.deepEqual((await json(await call(admin,'GET','/assigned-numbers?username=alicia'))).body.assignments.map(a=>a.id),[1,3]);
  assert.equal((await call(admin,'DELETE','/admin/users/'+id('bob'))).status,204);
  assert.deepEqual((await json(await call(admin,'GET','/assigned-numbers'))).body.assignments.map(a=>a.username),['alicia','alicia']);

  // Delete, and IDs are never reused.
  assert.equal((await call(admin,'DELETE','/admin/assigned-numbers/3')).status,204);
  assert.equal((await call(admin,'DELETE','/admin/assigned-numbers/3')).status,404);
  assert.equal((await json(await call(admin,'POST','/admin/assigned-numbers',{phoneNumber:15550000000,username:'alicia'}))).body.id,4);

  const db=await connectDatabase(join(directory,'whatix.db'));
  try{
    const row=await db.use(s=>s.get('SELECT * FROM assigned_numbers WHERE ID=1'));
    assert.deepEqual(row,{ID:1,phone_number:923009999999,user_name:'alicia'});
  }finally{await db.close();}
});
