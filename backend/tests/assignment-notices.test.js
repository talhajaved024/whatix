import assert from 'node:assert/strict';
import test from 'node:test';
import {testDatabase} from './test-database.js';
import {records} from '../src/sqlite.js';
import {assignmentNotices} from '../src/assignment-notices.js';

const boss={username:'boss',name:'Boss Khan',role:'super_user'};
const admin={username:'sara',name:'',role:'admin'};
const assigned=(phoneNumber,by=boss,session='MAIN')=>({session,campaignPhone:'923001110000',phoneNumber,by});

test('an assignment is kept for the user, says who assigned it, and reaches open streams',async t=>{
  const db=await testDatabase(t);
  let clock=1000;
  const notices=assignmentNotices(records(db,'assignment-notices'),{now:()=>clock});
  const seen=[];
  const stop=notices.subscribe('ali',(type,data)=>seen.push([type,data]));
  const other=[];
  notices.subscribe('bilal',(type,data)=>other.push([type,data]));

  const first=await notices.add('ali',assigned(923005550001));
  clock=2000;
  const second=await notices.add('ali',assigned(923005550002,admin));
  assert.deepEqual(first.assignedBy,{username:'boss',name:'Boss Khan',role:'super_user'});
  assert.deepEqual(second.assignedBy,{username:'sara',name:'sara',role:'admin'});   // no display name: the username
  assert.deepEqual((await notices.list('ali')).map(row=>[row.phoneNumber,row.at]),[['923005550002',2000],['923005550001',1000]]);
  assert.deepEqual(seen.map(([type,data])=>[type,data.phoneNumber]),[['assignment.added','923005550001'],['assignment.added','923005550002']]);
  assert.deepEqual(other,[]);                                   // only the assignee is told
  assert.deepEqual(await notices.list('bilal'),[]);

  // Still there after a restart (a user who was signed out sees it later).
  const restarted=assignmentNotices(records(db,'assignment-notices'));
  assert.deepEqual((await restarted.list('ali')).map(row=>row.phoneNumber),['923005550002','923005550001']);

  // Dismissing one, then all; other users' notices are untouched.
  await notices.add('bilal',assigned(923005550009));
  assert.equal(await notices.dismiss('ali',first.id),true);
  assert.equal(await notices.dismiss('ali',first.id),false);
  assert.equal(await notices.dismiss('ali','not-a-notice'),false);
  assert.deepEqual((await notices.list('ali')).map(row=>row.id),[second.id]);
  assert.equal(await notices.dismiss('ali'),true);
  assert.deepEqual(await notices.list('ali'),[]);
  assert.equal((await notices.list('bilal')).length,1);
  assert.deepEqual(seen.slice(2),[['assignment.removed',{id:first.id}],['assignment.removed',{all:true}]]);
  assert.deepEqual(await assignmentNotices(records(db,'assignment-notices')).list('ali'),[]);

  stop();
  await notices.add('ali',assigned(923005550003));
  assert.equal(seen.length,4);                                  // an ended stream hears nothing more
});

test('a customer assigned again replaces its notice, per WhatsApp number, and the list is capped',async t=>{
  const db=await testDatabase(t);
  const notices=assignmentNotices(records(db,'assignment-notices'),{max:3});
  await notices.add('ali',assigned(923005550001));
  await notices.add('ali',assigned(923005550001,admin));
  await notices.add('ali',assigned(923005550001,boss,'SECOND'));   // same customer on another number: its own notice
  let rows=await notices.list('ali');
  assert.deepEqual(rows.map(row=>[row.session,row.assignedBy.username]),[['SECOND','boss'],['MAIN','sara']]);
  for(const n of [2,3,4])await notices.add('ali',assigned(923005550000+n));
  rows=await notices.list('ali');
  assert.deepEqual(rows.map(row=>row.phoneNumber),['923005550004','923005550003','923005550002']);
});

test('assignments made at the same moment are all kept',async t=>{
  const db=await testDatabase(t);
  const notices=assignmentNotices(records(db,'assignment-notices'));
  await Promise.all(Array.from({length:12},(_,n)=>notices.add('ali',assigned(923005550100+n))));
  assert.equal((await notices.list('ali')).length,12);
  assert.equal((await assignmentNotices(records(db,'assignment-notices')).list('ali')).length,12);
});
