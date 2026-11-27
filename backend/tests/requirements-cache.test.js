import assert from 'node:assert/strict';
import test from 'node:test';
import {testDatabase} from './test-database.js';
import {requirementStore} from '../src/offline-requirements.js';

// numbersFor is cached (audit PERF-03); every write must show in the next answer.
test('assigned customers stay current through the numbersFor cache',async t=>{
  const db=await testDatabase(t);
  await db.use(s=>s.run("INSERT INTO users(ID,NAME,USER_NAME,PASSWORD,BAN_LOGIN,IS_ADMIN) VALUES(7,'Ann','ann','x',0,0)"));
  const store=requirementStore(db);
  const main=(userId=7)=>store.numbersFor(userId,'MAIN',true);
  const second=()=>store.numbersFor(7,'SECOND',false);

  const first=await store.create({name:'A',phone:923001110001,query:'Website',dateReceived:'2026-11-01'});
  assert.deepEqual(await main(),[]);
  const all=new Set([7]);
  await store.setAssignees(first.id,[7],null,all);
  assert.deepEqual(await main(),[923001110001]);                         // assignment seen at once
  assert.deepEqual(await main(),[923001110001]);                         // served from the cache

  // Moving the requirement to another of our numbers moves the customer with it.
  await store.update(first.id,{name:'A',phone:923001110001,query:'Website',dateReceived:'2026-11-01',receivedSession:'SECOND',receivedBy:'923331112223'});
  assert.deepEqual(await main(),[]);
  assert.deepEqual(await second(),[923001110001]);

  // A changed client phone is picked up at once (no intake chat behind an admin-entered row).
  await store.update(first.id,{name:'A',phone:923009990009,query:'Website',dateReceived:'2026-11-01',receivedSession:'SECOND',receivedBy:'923331112223'});
  assert.deepEqual(await second(),[923009990009]);

  await store.setAssignees(first.id,[],null,all);
  assert.deepEqual(await second(),[]);                                    // unassigned at once
  await store.setAssignees(first.id,[7],null,all);
  assert.deepEqual(await second(),[923009990009]);
  assert.equal(await store.remove(first.id),true);
  assert.deepEqual(await second(),[]);                                    // deleted at once
  assert.deepEqual(await main(8),[]);                                     // other users unaffected
});
