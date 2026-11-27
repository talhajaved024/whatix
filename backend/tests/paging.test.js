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
import { connectDatabase } from '../src/sqlite.js';
import { receivedDate } from '../src/offline-requirements.js';
import { completePasswordSetup } from './test-database.js';

// Data grids ask for one page at a time; without page parameters every list
// keeps returning everything, as pickers and older callers expect.
test('grids page users, campaign customers and offline requirements on the server', {timeout:30000}, async t => {
  const waha=createServer((req,res)=>{
    if(req.url==='/api/sessions/page-test')return res.end(JSON.stringify({name:'page-test',status:'WORKING',me:{id:'15550003333@c.us'}}));
    // Our connected numbers: the main one and a second campaign number.
    if(req.url==='/api/sessions?all=true')return res.end(JSON.stringify([{name:'page-test',status:'WORKING',me:{id:'15550003333@c.us'}},{name:'second',status:'WORKING',me:{id:'15550004444@c.us'}},{name:'offline-one',status:'STOPPED',me:null}]));
    if(req.url==='/api/sessions/second')return res.end(JSON.stringify({name:'second',status:'WORKING',me:{id:'15550004444@c.us'}}));
    if(req.url==='/api/page-test/labels')return res.end(JSON.stringify([{id:'5',name:'Hot leads',type:0}]));
    // One of user01's customers, one customer assigned to nobody, and a group.
    if(req.url==='/api/page-test/labels/5/chats')return res.end(JSON.stringify([{id:'923000000101@c.us'},{id:'923999999999@c.us'},{id:'120363000000000000@g.us'}]));
    res.writeHead(404);res.end('{}');
  });
  waha.listen(0,'127.0.0.1');await once(waha,'listening');
  t.after(()=>waha.close());
  const directory=await mkdtemp(join(tmpdir(),'wa-paging-'));
  const password=randomUUID(),dbPath=join(directory,'whatix.db');
  const child=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:'0',NODE_ENV:'test',AWAY_REPLIES_ENABLED:'false',
    ADMIN_USERNAME:'tester',ADMIN_PASSWORD:password,USER_WORKBOOK_PATH:join(directory,'users.xlsx'),WHATIX_DB_PATH:dbPath,
    APP_USERS_JSON:JSON.stringify([{username:'alice',password}]),JWT_ACCESS_SECRET:randomUUID(),JWT_REFRESH_SECRET:randomUUID(),
    WAHA_API_KEY:'fixture',WAHA_URL:'http://127.0.0.1:'+waha.address().port,WAHA_SESSION:'page-test'},stdio:['ignore','pipe','inherit']});
  t.after(async()=>{
    if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
    await rm(directory,{recursive:true,force:true});
  });
  const [line]=await once(createInterface({input:child.stdout}),'line');
  const base='http://127.0.0.1:'+line.match(/listening on (\d+)/)[1]+'/api';
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({credentials:Buffer.from(JSON.stringify({username:'tester',password})).toString('base64')})});
  const Cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const send=(method,path,body)=>fetch(base+path,{method,headers:{Cookie,'Content-Type':'application/json','X-Campaign-Phone':'15550003333'},body:body&&JSON.stringify(body)});
  const get=async path=>{const r=await fetch(base+path,{headers:{Cookie}});return {status:r.status,body:r.status===200?await r.json():null};};

  // 23 more regular users: 25 accounts with the super user and alice.
  for(let i=1;i<=23;i++)assert.equal((await send('POST','/admin/users',{username:'user'+String(i).padStart(2,'0'),password,name:'User '+i,phoneNumber:923001110000+i})).status,201);
  for(const username of ['user01','user02'])await completePasswordSetup(base,username,password);
  const all=await get('/admin/users');
  assert.equal(all.body.users.length,25);
  assert.equal(all.body.page,undefined);
  const first=await get('/admin/users?page=1');
  assert.equal(first.body.users.length,10);
  assert.deepEqual([first.body.page,first.body.pageSize,first.body.total,first.body.pages],[1,10,25,3]);
  assert.equal(first.body.users[0].username,'tester');                     // super user first
  assert.equal((await get('/admin/users?page=3')).body.users.length,5);
  const beyond=await get('/admin/users?page=9');
  assert.deepEqual([beyond.body.users.length,beyond.body.total,beyond.body.pages],[0,25,3]);
  const regular=await get('/admin/users?role=user&page=1&pageSize=50');
  assert.equal(regular.body.total,24);
  assert.equal(regular.body.summary.total,24);
  assert.ok(regular.body.users.every(u=>!u.isAdmin && !u.isSuperUser));
  const search=await get('/admin/users?q=USER%201&page=1');                 // "User 1", "User 10".."User 19"
  assert.equal(search.body.total,11);
  assert.equal(search.body.summary.total,25);
  for(const bad of ['page=0','pageSize=101','page=1.5','page=-1','pageSize=abc','q='+'x'.repeat(101)])
    assert.equal((await get('/admin/users?'+bad)).status,400,bad);

  // Campaign holders and their customers.
  const ids=Object.fromEntries(all.body.users.map(u=>[u.username,u.id]));
  for(let i=1;i<=12;i++)assert.equal((await send('PUT','/campaign-grants/'+ids['user'+String(i).padStart(2,'0')],{labels:[]})).status,204);
  const holders=await get('/admin/users?role=user&campaign=page-test&campaignPhone=15550003333&page=2');
  assert.deepEqual([holders.body.total,holders.body.users.length],[12,2]);
  assert.equal((await get('/admin/users?campaign=bad%20name&campaignPhone=1')).status,400);
  for(let i=0;i<25;i++)assert.equal((await send('POST','/campaign-contacts',{username:'user01',phoneNumber:923000000100+i})).status,201);
  await send('POST','/campaign-contacts',{username:'user02',phoneNumber:447700900123});
  const contacts=await get('/campaign-contacts?page=2');
  assert.deepEqual([contacts.body.assignments.length,contacts.body.total,contacts.body.pages,contacts.body.phone],[10,26,3,'15550003333']);
  assert.equal((await get('/campaign-contacts?page=1&username=user01')).body.total,25);
  const digits=await get('/campaign-contacts?page=1&q=%2B92300000011');      // 923000000110..119
  assert.equal(digits.body.total,10);
  assert.ok(digits.body.assignments.every(a=>String(a.phoneNumber).includes('92300000011')));
  assert.equal((await get('/campaign-contacts')).body.assignments.length,26);
  assert.equal((await get('/campaign-contacts?pageSize=0')).status,400);

  // A regular user sees only their own customers in a label, plus how many
  // direct chats carry it (a count, never who), so an empty label can be explained.
  assert.equal((await send('PUT','/campaign-grants/'+ids.user01,{labels:null})).status,204);   // every label
  const userLogin=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({credentials:Buffer.from(JSON.stringify({username:'user01',password})).toString('base64')})});
  const userCookie=userLogin.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const labelChats=await fetch(base+'/page-test/labels/5/chats',{headers:{Cookie:userCookie}});
  assert.deepEqual(await labelChats.json(),[{id:'923000000101@c.us'}]);
  assert.equal(labelChats.headers.get('X-Label-Chats'),'2');
  await fetch(base+'/auth/logout',{method:'POST',headers:{Cookie:userCookie}});

  // Offline requirements in this month, newest first.
  const db=await connectDatabase(dbPath);
  const today=receivedDate(Date.now());
  try{
    await db.use(async s=>{for(let i=1;i<=15;i++)await s.run('INSERT INTO "offline requirements"(NAME,PHONE,QUERY,DATE_RECIEVED) VALUES(?,?,?,?)',
      ['Customer '+i,923110000000+i,i===7?'Needs a logo':'Website',today]);});
  }finally{await db.close();}
  const reqs=await get('/admin/offline-requirements?page=2');
  assert.deepEqual([reqs.body.requirements.length,reqs.body.total,reqs.body.pages],[5,15,2]);
  assert.deepEqual(reqs.body.requirements.map(r=>r.id),[5,4,3,2,1]);
  assert.equal((await get('/admin/offline-requirements?page=1&q=logo')).body.requirements[0].name,'Customer 7');
  assert.equal((await get('/admin/offline-requirements?page=1&q=%2B923110000012')).body.total,1);
  assert.equal((await get('/admin/offline-requirements')).body.requirements.length,15);
  assert.equal((await get('/admin/offline-requirements?page=0')).status,400);

  // Admins add, edit and delete requirements; every field is required.
  const full={name:'Walk-in customer',phone:923110000099,query:'Needs a brochure',dateReceived:today,receivedSession:'page-test'};
  for(const key of Object.keys(full))
    for(const empty of [undefined,'',null]){
      const body={...full,[key]:empty};
      assert.equal((await send('POST','/admin/offline-requirements',body)).status,400,key+' '+empty);
    }
  for(const phone of ['923110000099',123,1234567890123456,-5])
    assert.equal((await send('POST','/admin/offline-requirements',{...full,phone})).status,400,String(phone));
  assert.equal((await send('POST','/admin/offline-requirements',{...full,dateReceived:'2999-01-01'})).status,400);
  assert.equal((await send('POST','/admin/offline-requirements',{...full,dateReceived:'2026-02-30'})).status,400);
  const added=await send('POST','/admin/offline-requirements',full);
  assert.equal(added.status,201);
  const {requirement}=await added.json();
  assert.deepEqual([requirement.name,requirement.phone,requirement.query,requirement.dateReceived,requirement.assignedUsers],
    [full.name,full.phone,full.query,today,[]]);
  // "Received by": which of our numbers got it. Required, and it must be connected.
  assert.deepEqual(requirement.receivedBy,{session:'page-test',phone:'15550003333',main:true});
  for(const receivedSession of [undefined,'','bad name','offline-one','unknown'])
    assert.equal((await send('POST','/admin/offline-requirements',{...full,receivedSession})).status,400,String(receivedSession));
  // Older rows (no number stored) show the main number.
  assert.deepEqual((await get('/admin/offline-requirements?page=1&q=Customer%2015')).body.requirements[0].receivedBy,{session:'page-test',phone:'15550003333',main:true});
  assert.equal((await get('/admin/offline-requirements?page=1')).body.total,16);
  const edited=await send('PATCH','/admin/offline-requirements/'+requirement.id,{...full,name:'Edited customer',query:'Brochure and logo'});
  assert.equal(edited.status,200);
  assert.equal((await edited.json()).requirement.name,'Edited customer');
  assert.equal((await send('PATCH','/admin/offline-requirements/'+requirement.id,{...full,name:' '})).status,400);
  assert.equal((await send('PATCH','/admin/offline-requirements/999999',full)).status,404);
  assert.equal((await send('PATCH','/admin/offline-requirements/abc',full)).status,400);
  // Regular users cannot change requirements.
  const staff=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({credentials:Buffer.from(JSON.stringify({username:'user02',password})).toString('base64')})});
  const regularCookie=staff.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  for(const [method,path,body] of [['POST','',full],['PATCH','/'+requirement.id,full],['DELETE','/'+requirement.id]])
    assert.equal((await fetch(base+'/admin/offline-requirements'+path,{method,headers:{Cookie:regularCookie,'Content-Type':'application/json'},
      body:body&&JSON.stringify(body)})).status,403,method);
  await fetch(base+'/auth/logout',{method:'POST',headers:{Cookie:regularCookie}});
  assert.equal((await send('DELETE','/admin/offline-requirements/'+requirement.id)).status,204);
  assert.equal((await send('DELETE','/admin/offline-requirements/'+requirement.id)).status,404);
  assert.equal((await get('/admin/offline-requirements?page=1')).body.total,15);

  // Only users holding the main number's campaign can be assigned a requirement
  // (user01..user12 hold it here; user13+ and alice do not).
  const eligible=(await get('/admin/offline-requirements/assignees')).body;
  assert.equal(eligible.phone,'15550003333');
  const eligibleNames=eligible.users.map(u=>u.username);
  assert.ok(eligibleNames.includes('user01') && eligibleNames.includes('user12'));
  assert.ok(!eligibleNames.includes('user13') && !eligibleNames.includes('alice'));
  assert.equal((await send('PATCH','/admin/offline-requirements/1/assignees',{userIds:[ids.user13]})).status,422);
  assert.equal((await send('PATCH','/admin/offline-requirements/1/assignees',{userIds:[ids.user01]})).status,200);

  // A requirement received by the second number: assignable to that number's
  // campaign holders only, and searchable by our number.
  assert.equal((await fetch(base+'/inboxes/second/api/campaign-grants/'+ids.user13,{method:'PUT',
    headers:{Cookie,'Content-Type':'application/json','X-Campaign-Phone':'15550004444'},body:JSON.stringify({labels:null})})).status,204);
  const second=await send('POST','/admin/offline-requirements',{...full,name:'Second-number lead',receivedSession:'second'});
  assert.equal(second.status,201);
  const secondReq=(await second.json()).requirement;
  assert.deepEqual(secondReq.receivedBy,{session:'second',phone:'15550004444',main:false});
  const secondEligible=(await get('/admin/offline-requirements/assignees?requirement='+secondReq.id)).body;
  assert.deepEqual([secondEligible.session,secondEligible.phone,secondEligible.users.map(u=>u.username)],['second','15550004444',['user13']]);
  assert.equal((await send('PATCH','/admin/offline-requirements/'+secondReq.id+'/assignees',{userIds:[ids.user01]})).status,422);
  assert.equal((await send('PATCH','/admin/offline-requirements/'+secondReq.id+'/assignees',{userIds:[ids.user13]})).status,200);
  assert.equal((await get('/admin/offline-requirements?page=1&q=15550004444')).body.total,1);
  // Moving it to the main number is an edit like any other.
  const moved=await send('PATCH','/admin/offline-requirements/'+secondReq.id,{...full,name:'Second-number lead',receivedSession:'page-test'});
  assert.deepEqual((await moved.json()).requirement.receivedBy,{session:'page-test',phone:'15550003333',main:true});
  assert.equal((await get('/admin/offline-requirements/assignees?requirement=999999')).status,404);
});
