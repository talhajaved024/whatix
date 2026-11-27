import assert from 'node:assert/strict';
import test from 'node:test';
import { testDatabase } from './test-database.js';
import { requirementStore } from '../src/offline-requirements.js';

// An admin edit of a WhatsApp-intake requirement must not be silently
// overwritten by the intake, and the assignee keeps seeing the original chat.
test('admin edits and deletes of intake requirements',async t=>{
  const db=await testDatabase(t);
  const store=requirementStore(db);
  const {record}=await store.add({name:'Asif',phone:923001111111,query:'Logo',dateReceived:'2026-11-01',keys:['k1'],history:['hi']});
  await store.setAssignees(record.id,[7],undefined,new Set([7]));
  const edited=await store.update(record.id,{name:'Asif Khan',phone:447700900111,query:'Logo and website',dateReceived:'2026-11-02'});
  assert.deepEqual([edited.name,edited.phone,edited.query,edited.dateReceived],['Asif Khan',447700900111,'Logo and website','2026-11-02']);
  assert.deepEqual(await store.numbersFor(7,'main',true),[923001111111]);   // the original WhatsApp chat, on the main number
  assert.deepEqual(await store.numbersFor(7,'second',false),[]);           // not visible in another number's inbox
  assert.equal((await store.projects(['k1']))[0].version,2);
  // The intake still holds version 1: it gets the edited record back instead of overwriting it.
  const stale=await store.add({...record,keys:['k1'],baseId:record.id,updateVersion:1,history:['hi','more']});
  assert.equal(stale.state,'existing');
  assert.equal(stale.record.query,'Logo and website');
  assert.equal(await store.update(999,{name:'x',phone:923001111112,query:'q',dateReceived:'2026-11-01'}),null);
  assert.equal(await store.remove(record.id),true);
  assert.equal(await store.remove(record.id),false);
  assert.deepEqual(await store.numbersFor(7,'main',true),[]);
  assert.equal((await db.use(s=>s.get('SELECT COUNT(*) AS n FROM intake_context'))).n,0);   // cascades
  const created=await store.create({name:'Walk-in',phone:923002222222,query:'Brochure',dateReceived:'2026-11-03'});
  assert.deepEqual([created.name,created.assignedUserIds,created.receivedSession],['Walk-in',[],null]);
  // Received by a second number: its customer shows only in that number's inbox.
  const other=await store.create({name:'Other',phone:923003333333,query:'Logo',dateReceived:'2026-11-03',receivedSession:'second',receivedBy:'15550004444'});
  await store.setAssignees(other.id,[9],undefined,new Set([9]));
  assert.deepEqual(await store.numbersFor(9,'second',false),[923003333333]);
  assert.deepEqual(await store.numbersFor(9,'main',true),[]);
  // The database rejects a malformed number.
  await assert.rejects(store.create({name:'x',phone:923004444444,query:'q',dateReceived:'2026-11-03',receivedSession:'second',receivedBy:'12ab'}));
});
