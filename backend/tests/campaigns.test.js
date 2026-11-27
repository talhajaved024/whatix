import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {hkdfSync,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {testDatabase} from './test-database.js';
import {campaignStore} from '../src/campaigns.js';
import {sessionPhones} from '../src/session-phones.js';
import {connectDatabase,schema,SCHEMA_VERSION} from '../src/sqlite.js';
import {openWhatix} from '../src/whatix.js';
import {hashPassword,passwordCipher} from '../src/accounts.js';

async function withUsers(t){
  const db=await testDatabase(t);
  await db.use(async s=>{
    for(const [id,username,admin] of [[1,'boss',1],[2,'alice',0],[3,'bob',0]])
      await s.run('INSERT INTO users(ID,NAME,USER_NAME,PASSWORD,BAN_LOGIN,IS_ADMIN) VALUES(?,?,?,?,0,?)',[id,username,username,'x',admin]);
  });
  return db;
}
const status=async promise=>{try{await promise;return 'ok';}catch(error){return error.status;}};

test('campaign store: grants, labels, customers, constraints and cascades',async t=>{
  const db=await withUsers(t),store=campaignStore(db);
  const [A,B]=[['MAIN','923001110000'],['SECOND','923002220000']];
  // Only regular users can receive a campaign.
  assert.equal(await status(store.grant(...A,1,[],true)),422);
  assert.equal(await status(store.grant(...A,99,[],true)),422);
  // The first grant of the primary inbox carries over legacy assigned numbers.
  await db.use(s=>s.run("INSERT INTO assigned_numbers(phone_number,user_name) VALUES(923331234567,'alice'),(447700900123,'alice')"));
  let version=store.version();
  await store.grant(...A,2,['1','2'],true);
  assert.ok(store.version()>version);
  assert.deepEqual((await store.get(...A,2)).contacts.map(c=>c.phoneNumber),[923331234567,447700900123]);
  assert.equal((await db.use(s=>s.get('SELECT COUNT(*) AS n FROM assigned_numbers'))).n,0);
  // Re-granting replaces labels and keeps customers; null means every label.
  await store.grant(...A,2,null,true);
  assert.equal((await store.get(...A,2)).labels,null);
  assert.equal((await store.get(...A,2)).contacts.length,2);
  await store.grant(...A,2,['3'],true);
  assert.deepEqual((await store.get(...A,2)).labels,['3']);
  assert.equal((await store.get(...A,2)).contacts.length,2);
  await store.grant(...A,3,[],true);
  await store.grant(...B,2,[],false);
  assert.deepEqual((await store.grants(...A)).map(({userId,labels,customers})=>({userId,labels,customers})),
    [{userId:2,labels:['3'],customers:2},{userId:3,labels:[],customers:0}]);
  // Who assigned what, and when, is kept for the admin screens.
  await store.grant(...B,3,[],false,1);
  const audited=(await store.grants(...B)).find(g=>g.userId===3);
  assert.equal(audited.assignedBy,'boss');
  assert.ok(Date.parse(audited.assignedAt)<=Date.now());
  assert.deepEqual((await store.forUser(2)).map(g=>g.session).sort(),['MAIN','SECOND']);
  // A grant belongs to one phone: the same session re-paired elsewhere has none.
  assert.equal(await store.get('MAIN','923009999999',2),null);

  // Customers: validation, duplicates, moving between users, other campaigns.
  const contact=(method,id,body)=>store.contact(...A,method,id,body);
  assert.equal(await status(contact('POST',undefined,{phoneNumber:'92300',username:'alice'})),400);
  assert.equal(await status(contact('POST',undefined,{phoneNumber:15550000000})),400);
  assert.equal(await status(contact('POST',undefined,{phoneNumber:15550000000,username:'boss'})),422);
  const added=await store.contact(...A,'POST',undefined,{phoneNumber:15550000000,username:'bob'},1);
  assert.deepEqual(added,{id:added.id,phoneNumber:15550000000,username:'bob',assignedAt:added.assignedAt});
  assert.equal((await store.contacts(...A,'bob'))[0].assignedBy,'boss');
  assert.equal(await status(contact('POST',undefined,{phoneNumber:15550000000,username:'bob'})),409);
  // The same customer may be handled by two users.
  assert.equal(await status(contact('POST',undefined,{phoneNumber:15550000000,username:'alice'})),'ok');
  const moved=String(added.id);
  assert.equal(await status(contact('PATCH',moved,{username:'alice'})),409);
  const patched=await contact('PATCH',moved,{phoneNumber:15551111111,username:'alice'});
  assert.deepEqual(patched,{id:added.id,phoneNumber:15551111111,username:'alice',assignedAt:patched.assignedAt});
  assert.equal(await status(store.contact(...B,'DELETE',moved,{})),404);
  assert.equal(await status(contact('PATCH','abc',{phoneNumber:1})),404);
  assert.deepEqual((await store.contacts(...A,'bob')),[]);
  assert.equal((await store.contacts(...A)).length,4);
  await contact('DELETE',moved,{});
  assert.equal(await status(contact('DELETE',moved,{})),404);

  // Reassigning from the chat list: the customer ends up with that user only.
  const holders=async number=>(await store.contacts(...A)).filter(c=>c.phoneNumber===number).map(c=>c.username);
  assert.deepEqual(await holders(15550000000),['alice']);
  assert.equal(await status(store.reassign(...A,15550000000,'boss')),422);
  assert.equal(await status(store.reassign(...A,15550000000,'')),400);
  assert.equal(await status(store.reassign(...A,'1555',  'bob')),400);
  const toBob=await store.reassign(...A,15550000000,'bob',1);
  assert.deepEqual(toBob.removedFrom,['alice']);
  assert.deepEqual(await holders(15550000000),['bob']);
  assert.equal((await store.contacts(...A,'bob'))[0].assignedBy,'boss');
  // Shared by two users: picking one keeps their own assignment and drops the other.
  const shared=await contact('POST',undefined,{phoneNumber:15550000000,username:'alice'});
  const toAlice=await store.reassign(...A,15550000000,'alice');
  assert.deepEqual([toAlice.id,toAlice.assignedAt,toAlice.removedFrom],[shared.id,shared.assignedAt,['bob']]);
  assert.deepEqual(await holders(15550000000),['alice']);
  // Picking the only assignee again changes nothing.
  assert.deepEqual((await store.reassign(...A,15550000000,'alice')).removedFrom,[]);
  assert.deepEqual(await holders(15550000000),['alice']);
  // Another number's assignments are separate.
  const elsewhere=await store.reassign(...B,15550000000,'bob');
  assert.deepEqual(elsewhere.removedFrom,[]);
  assert.deepEqual(await holders(15550000000),['alice']);
  await store.contact(...B,'DELETE',String(elsewhere.id),{});

  // Revoking a campaign removes its customers; deleting a user removes everything.
  assert.equal(await store.revoke(...A,2),1);
  assert.equal((await db.use(s=>s.get('SELECT COUNT(*) AS n FROM campaign_contacts'))).n,0);
  assert.equal((await db.use(s=>s.get('SELECT COUNT(*) AS n FROM campaign_grant_labels'))).n,0);
  await db.use(s=>s.run('DELETE FROM users WHERE ID=2'));
  assert.deepEqual(await store.forUser(2),[]);
  assert.deepEqual((await store.grants(...A)).map(g=>g.userId),[3]);
});

test('version 1 databases gain campaign tables and keep earlier campaign assignments',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'whatix-campaigns-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const options={path:join(dir,'whatix.db'),usersPath:join(dir,'users.xlsx'),admin:'boss',secret:randomUUID()};
  const cipher=passwordCipher(Buffer.from(hkdfSync('sha256',options.secret,'whatix','account verifiers v1',32)));
  const old=await connectDatabase(options.path);
  await old.use(async s=>{
    await s.exec(schema);
    await s.run('INSERT INTO users(ID,NAME,USER_NAME,PASSWORD,BAN_LOGIN,IS_ADMIN) VALUES(1,?,?,?,0,1)',['Boss','boss',cipher.seal(await hashPassword(randomUUID()),1,'boss')]);
    await s.run("INSERT INTO users(ID,NAME,USER_NAME,PASSWORD,BAN_LOGIN,IS_ADMIN) VALUES(2,'Alice','alice','x',0,0)");
    await s.run("INSERT INTO users(ID,NAME,USER_NAME,PASSWORD,BAN_LOGIN,IS_ADMIN) VALUES(3,'Bob','bob','x',0,0)");
    const grant=(key,value)=>s.run("INSERT INTO app_records VALUES('campaign-grants:v1',?,?)",[key,JSON.stringify(value)]);
    await grant('a',{name:'MAIN',phone:'923001110000',userId:2,labels:['1'],contacts:[{id:randomUUID(),phoneNumber:923331234567},{id:randomUUID(),phoneNumber:'bad'}]});
    await grant('b',{name:'MAIN',phone:'923001110000',userId:7,labels:[],contacts:[]}); // user since deleted
    await grant('c','not a grant');
    await grant('d',{name:'MAIN',phone:'923001110000',userId:3,labels:[],contacts:[]}); // nothing ticked: every label from v5
    await s.run("INSERT INTO app_records VALUES('connected-inboxes','SECOND','true')");
    await s.exec('PRAGMA user_version=1');
  });
  await old.close();
  for(let open=0;open<2;open++){
    const {db}=await openWhatix(options);
    try{
      const store=campaignStore(db);
      assert.equal((await db.use(s=>s.get('PRAGMA user_version'))).user_version,SCHEMA_VERSION);
      assert.deepEqual(await store.get('MAIN','923001110000',2),{name:'MAIN',phone:'923001110000',userId:2,labels:['1'],
        contacts:[{id:1,phoneNumber:923331234567}]});
      assert.deepEqual(await store.grants('MAIN','923001110000'),[{userId:2,labels:['1'],customers:1,assignedAt:null,assignedBy:null},
        {userId:3,labels:null,customers:0,assignedAt:null,assignedBy:null}]);
      assert.deepEqual(await db.use(s=>s.all('SELECT namespace FROM app_records')),[{namespace:'connected-inboxes'}]);
    }finally{await db.close();}
  }
  // A newer database is refused rather than misread.
  const future=await connectDatabase(options.path);
  await future.use(s=>s.exec('PRAGMA user_version=99'));
  await future.close();
  await assert.rejects(openWhatix(options),/Unsupported Whatix database schema/);
});

test('session phones are cached, shared between concurrent callers and refreshed on demand',async t=>{
  let calls=0,phone='923001110000',fail=false,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const waha=createServer(async(req,res)=>{
    calls++;
    if(calls===1)await gate;
    if(fail){res.writeHead(500);return res.end();}
    res.end(JSON.stringify({name:'MAIN',status:'WORKING',me:{id:phone+':4@s.whatsapp.net'}}));
  });
  waha.listen(0,'127.0.0.1');await once(waha,'listening');
  t.after(()=>waha.close());
  let clock=0;
  const phones=sessionPhones({base:'http://127.0.0.1:'+waha.address().port,headers:()=>({}),ttlMs:1000,errorTtlMs:100,now:()=>clock});
  const first=Promise.all([phones.phone('MAIN'),phones.phone('MAIN'),phones.phone('MAIN')]);
  release();
  assert.deepEqual(await first,['923001110000','923001110000','923001110000']);
  assert.equal(calls,1);
  phone='923002220000';
  assert.equal(await phones.phone('MAIN'),'923001110000');           // cached
  assert.equal(await phones.phone('MAIN',{fresh:true}),'923002220000');
  assert.equal(calls,2);
  phone='923003330000';
  phones.invalidate('MAIN');
  assert.equal(await phones.phone('MAIN'),'923003330000');
  clock+=1000;fail=true;
  await assert.rejects(phones.phone('MAIN'),{status:502});
  await assert.rejects(phones.phone('MAIN'),{status:502});              // failure cached briefly
  assert.equal(calls,4);
  fail=false;clock+=100;
  assert.equal(await phones.phone('MAIN'),'923003330000');
  assert.equal(calls,5);
});
