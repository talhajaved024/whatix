import assert from 'node:assert/strict';
import test from 'node:test';
import {testDatabase} from './test-database.js';
import {campaignStore} from '../src/campaigns.js';
import {numberRetirement} from '../src/number-retirement.js';
import {sessionPhones} from '../src/session-phones.js';
import {broadcastQueue} from '../src/broadcasts.js';
import {records} from '../src/sqlite.js';

async function setup(t){
  const db=await testDatabase(t);
  await db.use(async s=>{
    for(const [id,username,admin] of [[1,'boss',1],[2,'alice',0],[3,'bob',0]])
      await s.run('INSERT INTO users(ID,NAME,USER_NAME,PASSWORD,BAN_LOGIN,IS_ADMIN) VALUES(?,?,?,?,0,?)',[id,username,username,'x',admin]);
  });
  const campaigns=campaignStore(db),forgotten=[];
  const create=()=>numberRetirement({store:records(db,'number-state'),campaigns,forget:async name=>{forgotten.push(name);}});
  const grants=()=>db.use(async s=>(await s.all('SELECT session,campaign_phone AS phone,user_id AS user FROM campaign_grants ORDER BY session,campaign_phone,user_id')).map(g=>g.session+':'+g.phone+':'+g.user));
  const contacts=()=>db.use(async s=>(await s.get('SELECT COUNT(*) AS n FROM campaign_contacts')).n);
  return {db,campaigns,create,grants,contacts,forgotten};
}
const OLD='923001110000',NEW='923009990000',OTHER='923002220000';

test('a number paired to another phone takes its assignments with it, and only its own',async t=>{
  const {campaigns,create,grants,contacts,forgotten}=await setup(t);
  await campaigns.grant('MAIN',OLD,2,null,false);
  await campaigns.grant('MAIN',OLD,3,['7'],false);
  await campaigns.grant('SECOND',OTHER,2,null,false);
  await campaigns.reassign('MAIN',OLD,923331234567,'alice',1);
  await campaigns.reassign('SECOND',OTHER,923331234567,'alice',1);
  const numbers=await create();
  // First sighting: nothing is erased for the phone that is paired, and the account ID is unchanged.
  await numbers.observe('MAIN',OLD);await numbers.observe('SECOND',OTHER);
  assert.deepEqual(await grants(),['MAIN:'+OLD+':2','MAIN:'+OLD+':3','SECOND:'+OTHER+':2']);
  assert.equal(numbers.generation('MAIN'),0);
  assert.deepEqual(forgotten,[]);
  const version=campaigns.version();
  // The same phone again changes nothing.
  assert.equal(numbers.observe('MAIN',OLD),undefined);
  // Paired to another phone: MAIN's users and customers go; SECOND is untouched.
  await numbers.observe('MAIN',NEW);
  assert.deepEqual(await grants(),['SECOND:'+OTHER+':2']);
  assert.equal(await contacts(),1);
  assert.deepEqual(forgotten,['MAIN']);
  assert.equal(numbers.generation('MAIN'),1);
  assert.equal(numbers.generation('SECOND'),0);
  assert.ok(campaigns.version()>version);                 // cached access is dropped
  // Assignments made for the new phone stay when it is seen again.
  await campaigns.grant('MAIN',NEW,3,null,false);
  await numbers.observe('MAIN',NEW);
  assert.deepEqual(await grants(),['MAIN:'+NEW+':3','SECOND:'+OTHER+':2']);
  // Pairing the old phone back does not bring anything back, and counts as another change.
  await numbers.observe('MAIN',OLD);
  assert.deepEqual(await grants(),['SECOND:'+OTHER+':2']);
  assert.equal(numbers.generation('MAIN'),2);
  // The generation survives a restart.
  assert.equal((await create()).generation('MAIN'),2);
});

test('a deleted number is erased, and a new one under the same name starts empty',async t=>{
  const {campaigns,create,grants,forgotten}=await setup(t);
  await campaigns.grant('SECOND',OTHER,2,null,false);
  await campaigns.grant('MAIN',OLD,2,null,false);
  const numbers=await create();
  await numbers.observe('SECOND',OTHER);
  await numbers.remove('SECOND');
  assert.deepEqual(await grants(),['MAIN:'+OLD+':2']);
  assert.deepEqual(forgotten,['SECOND']);
  assert.equal(numbers.generation('SECOND'),1);
  // The same phone connected again under that name: no assignments return, and its
  // history account stays the new one.
  await numbers.observe('SECOND',OTHER);
  assert.deepEqual(await grants(),['MAIN:'+OLD+':2']);
  assert.equal(numbers.generation('SECOND'),1);
  assert.deepEqual(forgotten,['SECOND']);
});

test('leftovers of a phone that left before this was tracked are erased at the first sighting',async t=>{
  const {campaigns,create,grants}=await setup(t);
  await campaigns.grant('MAIN',OLD,2,null,false);
  await campaigns.grant('MAIN',NEW,3,null,false);
  const numbers=await create();
  await numbers.observe('MAIN',NEW);
  assert.deepEqual(await grants(),['MAIN:'+NEW+':3']);
  assert.equal(numbers.generation('MAIN'),0);
});

test('a failed erasure is run again the next time the number is seen',async t=>{
  const {db,campaigns,grants}=await setup(t);
  await campaigns.grant('MAIN',OLD,2,null,false);
  let fail=true;
  const numbers=await numberRetirement({store:records(db,'number-state'),campaigns,forget:async()=>{if(fail)throw Error('database busy');}});
  await numbers.observe('MAIN',OLD);
  await assert.rejects(numbers.observe('MAIN',NEW));
  assert.equal(numbers.generation('MAIN'),0);
  fail=false;
  await numbers.observe('MAIN',NEW);
  assert.deepEqual(await grants(),[]);
  assert.equal(numbers.generation('MAIN'),1);
});

test('the phone lookup reports each connected number before answering',async t=>{
  const seen=[];
  const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;});
  let row={name:'MAIN',status:'WORKING',me:{id:OLD+'@c.us'}};
  globalThis.fetch=async()=>new Response(JSON.stringify(row),{headers:{'Content-Type':'application/json'}});
  const phones=sessionPhones({base:'http://waha',headers:()=>({}),onPhone:async(name,phone)=>{await null;seen.push(name+':'+phone);}});
  assert.equal(await phones.phone('MAIN'),OLD);
  assert.deepEqual(seen,['MAIN:'+OLD]);
  row={name:'MAIN',status:'SCAN_QR_CODE'};              // not connected: nothing to report
  assert.equal(await phones.phone('MAIN',{fresh:true}),null);
  assert.deepEqual(seen,['MAIN:'+OLD]);
});

test('clearing a broadcast queue stops its jobs for good',async t=>{
  const store=records(await testDatabase(t),'broadcasts:test');
  const sent=[];
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const queue=await broadcastQueue(store,{canSend:async()=>true,send:async(_job,number)=>{sent.push(number);await gate;return {ok:true,id:'x'};}});
  t.after(()=>queue.close());
  const recipients=Array.from({length:12},(_,i)=>'1000000'+String(i).padStart(2,'0')+'@c.us');
  const response={status(code){this.code=code;return this;},json(body){this.body=body;this.done?.();}};
  const finished=new Promise(resolve=>{response.done=resolve;});
  queue.router.handle({method:'POST',url:'/',userId:1,body:{id:'6f1c2a3e-1111-4222-8333-444455556666',recipients,kind:'text',text:'hello'},headers:{}},response,()=>{});
  await finished;
  assert.equal(response.code,202);
  while(!sent.length)await new Promise(resolve=>setTimeout(resolve,5));
  await queue.clear();                                   // the number is gone while a send is under way
  release();
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(sent.length,1);                            // nothing after the one already in flight
  assert.deepEqual(await store.keys(),[]);
  // A new queue over the same store (after a restart) has nothing to resume.
  const again=await broadcastQueue(store,{canSend:async()=>true,send:async(_job,number)=>{sent.push(number);return {ok:true,id:'y'};}});
  t.after(()=>again.close());
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(sent.length,1);
});
