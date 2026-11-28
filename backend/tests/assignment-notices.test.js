import assert from 'node:assert/strict';
import test from 'node:test';
import {testDatabase} from './test-database.js';
import {records} from '../src/sqlite.js';
import {assignmentNotices} from '../src/assignment-notices.js';

const boss={username:'boss',name:'Boss Khan',role:'super_user'};
const admin={username:'sara',name:'',role:'admin'};
const assigned=(phoneNumber,by=boss,session='MAIN')=>({session,campaignPhone:'923001110000',phoneNumber,by});
const fresh=db=>assignmentNotices(records(db,'assignment-notices'));
// [phone, in the bell?] per notice, newest first.
const state=async(notices,username='ali')=>(await notices.list(username)).map(row=>[row.phoneNumber,!row.hidden]);

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
  assert.deepEqual(await state(fresh(db)),[['923005550002',true],['923005550001',true]]);

  stop();
  await notices.add('ali',assigned(923005550003));
  assert.equal(seen.length,2);                                  // an ended stream hears nothing more
});

test('dismissing in the bell hides a customer; opening the chat removes it',async t=>{
  const db=await testDatabase(t);
  const notices=fresh(db);
  const seen=[];notices.subscribe('ali',(type,data)=>seen.push([type,data]));
  const first=await notices.add('ali',assigned(923005550001));
  const second=await notices.add('ali',assigned(923005550002));
  await notices.add('bilal',assigned(923005550001));

  // Dismissed in the bell: gone from the bell, still "New" on the chat.
  assert.equal(await notices.dismiss('ali',first.id),true);
  assert.deepEqual(await state(notices),[['923005550002',true],['923005550001',false]]);
  assert.deepEqual(seen.at(-1),['assignment.hidden',{ids:[first.id]}]);
  assert.equal(await notices.dismiss('ali',first.id),false);    // already hidden
  assert.equal(await notices.dismiss('ali','not-a-notice'),false);
  assert.deepEqual(await state(fresh(db)),[['923005550002',true],['923005550001',false]]);   // survives a restart

  // Opening the chat: nothing about that customer is new any more.
  assert.equal(await notices.opened('ali','MAIN','923005550001'),true);
  assert.deepEqual(seen.at(-1),['assignment.removed',{ids:[first.id]}]);
  assert.equal(await notices.opened('ali','MAIN','923005550001'),false);
  assert.equal(await notices.opened('ali','SECOND','923005550002'),false);   // the same phone on another number is another chat
  assert.deepEqual(await state(notices),[['923005550002',true]]);
  assert.deepEqual(await state(notices,'bilal'),[['923005550001',true]]);    // other users are untouched

  // A customer assigned again after being hidden is announced again.
  await notices.dismiss('ali',second.id);
  await notices.add('ali',assigned(923005550002,admin));
  assert.deepEqual(await state(notices),[['923005550002',true]]);

  // An assignment that no longer holds is removed outright.
  const [left]=await notices.list('ali');
  assert.equal(await notices.remove('ali',[left.id,'unknown']),true);
  assert.deepEqual(await notices.list('ali'),[]);
  assert.deepEqual(await fresh(db).list('ali'),[]);
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

test('numbers and requirements have their own notices, and a group is dismissed together',async t=>{
  const db=await testDatabase(t);
  const notices=fresh(db);
  const seen=[];notices.subscribe('ali',(type,data)=>seen.push([type,data]));
  const number=await notices.add('ali',{type:'number.assigned',session:'MAIN',campaignPhone:923001110000,by:boss});
  const again=await notices.add('ali',{type:'number.assigned',session:'MAIN',campaignPhone:923001110000,by:admin});      // granted again: replaces
  const requirement=await notices.add('ali',{type:'requirement.assigned',session:'MAIN',campaignPhone:'923001110000',requirementId:7,name:'Hassan',phoneNumber:923005550001,by:boss});
  const contact=await notices.add('ali',assigned(923005550001));                                               // same customer as a plain contact: separate
  const rows=await notices.list('ali');
  assert.deepEqual(rows.map(row=>row.type),['contact.assigned','requirement.assigned','number.assigned']);
  assert.equal('phoneNumber' in rows[2],false);
  assert.deepEqual([rows[1].requirementId,rows[1].name,rows[1].phoneNumber],[7,'Hassan','923005550001']);
  assert.equal(rows[2].assignedBy.username,'sara');
  assert.notEqual(rows[2].id,number.id);

  // Dismissed together: the customer's two notices are hidden, the number's is removed.
  seen.length=0;
  assert.equal(await notices.dismiss('ali',[contact.id,requirement.id,again.id,'unknown']),true);
  assert.deepEqual((await notices.list('ali')).map(row=>[row.type,!!row.hidden]),[['contact.assigned',true],['requirement.assigned',true]]);
  assert.deepEqual(seen,[['assignment.hidden',{ids:[contact.id,requirement.id]}],['assignment.removed',{ids:[again.id]}]]);
  // Opening the chat clears both of that customer's notices at once.
  assert.equal(await notices.opened('ali','MAIN','923005550001'),true);
  assert.deepEqual(await notices.list('ali'),[]);
  assert.deepEqual(seen.at(-1),['assignment.removed',{ids:[contact.id,requirement.id]}]);

  // "Dismiss all" follows the same rule.
  await notices.add('ali',{type:'number.assigned',session:'MAIN',campaignPhone:923001110000,by:boss});
  await notices.add('ali',assigned(923005550009));
  assert.equal(await notices.dismiss('ali'),true);
  assert.deepEqual((await notices.list('ali')).map(row=>[row.type,!!row.hidden]),[['contact.assigned',true]]);
});

test('assignments made at the same moment are all kept',async t=>{
  const db=await testDatabase(t);
  const notices=fresh(db);
  await Promise.all(Array.from({length:12},(_,n)=>notices.add('ali',assigned(923005550100+n))));
  assert.equal((await notices.list('ali')).length,12);
  assert.equal((await fresh(db).list('ali')).length,12);
});
