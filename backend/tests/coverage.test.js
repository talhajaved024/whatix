import test from 'node:test';
import assert from 'node:assert/strict';
import {chatCoverage} from '../src/coverage.js';

function setup(){
  const online=[];
  const numbers={alice:[923001111111],bob:[923002222222]};
  let clock=1000;
  const coverage=chatCoverage({onlineStaff:()=>online,now:()=>clock,
    numbersFor:async member=>numbers[member.username]??[],
    phoneFor:async lid=>lid==='55@lid'?923001111111:null});
  return {coverage,online,numbers,tick:ms=>{clock+=ms;},
    signIn:async member=>{online.push(member);await coverage.changed();},
    signOut:async username=>{online.splice(online.findIndex(m=>m.username===username),1);await coverage.changed();}};
}
const alice={username:'alice',userId:2,isAdmin:false},bob={username:'bob',userId:3,isAdmin:false},admin={username:'admin',userId:1,isAdmin:true};

test('nobody signed in: every chat is uncovered and gets an offline period',async()=>{
  const {coverage}=setup();
  assert.equal(coverage.covered('923001111111@c.us'),false);
  const period=coverage.periodFor('923001111111@c.us');
  assert.ok(period);
  assert.equal(coverage.periodFor('923001111111@c.us'),period); // stable for the stretch
});

test('a regular user covers only their assigned numbers; others stay with the AI responder',async()=>{
  const h=setup();
  const clientB=h.coverage.periodFor('923009999999@c.us');
  await h.signIn(alice);
  assert.equal(h.coverage.covered('923001111111@c.us'),true);    // alice's client
  assert.equal(h.coverage.periodFor('923001111111@c.us'),null);
  assert.equal(h.coverage.covered('923002222222@c.us'),false);   // bob's client, bob signed out
  assert.equal(h.coverage.covered('923009999999@c.us'),false);   // unassigned client
  // Alice signing in does not restart the AI conversation with an unassigned client.
  assert.equal(h.coverage.periodFor('923009999999@c.us'),clientB);
});

test('an admin or the super user covers every chat',async()=>{
  const h=setup();
  await h.signIn(admin);
  for(const chat of ['923001111111@c.us','923002222222@c.us','923009999999@c.us','55@lid'])assert.equal(h.coverage.covered(chat),true,chat);
});

test('losing the last viewer starts a fresh offline period; linked IDs map to the assigned phone',async()=>{
  const h=setup();
  await h.coverage.resolve('55@lid');
  const before=h.coverage.periodFor('55@lid');
  await h.signIn(alice);
  assert.equal(h.coverage.periodFor('55@lid'),null);
  h.tick(5000);
  await h.signOut('alice');
  const after=h.coverage.periodFor('55@lid');
  assert.ok(after && after!==before);
  assert.equal(after.since,6000);
});

test('assignment changes take effect on the next refresh, and overlapping refreshes see the latest sign-in',async()=>{
  const h=setup();
  await h.signIn(bob);
  assert.equal(h.coverage.covered('923003333333@c.us'),false);
  h.numbers.bob.push(923003333333);
  await h.coverage.changed();                                     // admin saved an assignment
  assert.equal(h.coverage.covered('923003333333@c.us'),true);
  // Someone signs out and alice signs in while that refresh is still running.
  h.online.splice(0,1);
  const first=h.coverage.changed();
  h.online.push(alice);
  await Promise.all([first,h.coverage.changed()]);
  assert.equal(h.coverage.covered('923001111111@c.us'),true);
  assert.equal(h.coverage.covered('923003333333@c.us'),false);
});

test('notification visibility follows the same rules: admins see all, regular users their assigned numbers',async()=>{
  const h=setup();
  await h.signIn(alice);
  await h.signIn(admin);
  assert.equal(h.coverage.canSee(admin,'923009999999@c.us'),true);
  assert.equal(h.coverage.canSee(alice,'923001111111@c.us'),true);
  assert.equal(h.coverage.canSee(alice,'923009999999@c.us'),false);
  assert.equal(h.coverage.canSee(bob,'923002222222@c.us'),false);  // bob is not signed in
});
