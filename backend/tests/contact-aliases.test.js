import assert from 'node:assert/strict';
import test from 'node:test';
import {testDatabase} from './test-database.js';
import {records} from '../src/sqlite.js';
import {contactAliases} from '../src/contact-aliases.js';

const status=promise=>promise.then(()=>200,error=>error.status);

test('a user names customers for themselves only',async t=>{
  const db=await testDatabase(t);
  const names=contactAliases(records(db,'contact-aliases'));
  assert.deepEqual(await names.list('ali'),{});
  assert.deepEqual(await names.set('ali','923005550001','  Hassan   -  website \n'),{'923005550001':'Hassan - website'});   // tidied to one line
  await names.set('ali','923005550002','حسن 👍');
  await names.set('bilal','923005550001','Big client');
  assert.deepEqual(await names.list('ali'),{'923005550001':'Hassan - website','923005550002':'حسن 👍'});
  assert.deepEqual(await names.list('bilal'),{'923005550001':'Big client'});   // each user has their own
  assert.deepEqual(await names.list('sara'),{});

  // Kept across a restart; renamed; removed with an empty name.
  const restarted=contactAliases(records(db,'contact-aliases'));
  assert.deepEqual(await restarted.list('ali'),{'923005550001':'Hassan - website','923005550002':'حسن 👍'});
  await restarted.set('ali','923005550001','Hassan');
  assert.deepEqual(await restarted.set('ali','923005550002','   '),{'923005550001':'Hassan'});
  await restarted.set('ali','923005550001','');
  assert.deepEqual(await contactAliases(records(db,'contact-aliases')).list('ali'),{});
  assert.deepEqual(await contactAliases(records(db,'contact-aliases')).list('bilal'),{'923005550001':'Big client'});
});

test('bad names and customers are refused, and the number of names is capped',async t=>{
  const db=await testDatabase(t);
  const names=contactAliases(records(db,'contact-aliases'),{max:2});
  for(const phone of ['','0123','92300555000199999','92300abc','__proto__',923005550001])assert.equal(await status(names.set('ali',phone,'x')),400,String(phone));
  assert.equal(await status(names.set('ali','923005550001',undefined)),400);
  assert.equal(await status(names.set('ali','923005550001','x'.repeat(61))),400);
  assert.equal(await status(names.set('ali','923005550001','x'.repeat(60))),200);
  assert.equal(await status(names.set('ali','923005550002','b')),200);
  assert.equal(await status(names.set('ali','923005550003','c')),409);          // at the cap
  assert.equal(await status(names.set('ali','923005550002','renamed')),200);    // changing one is still allowed
  assert.equal(await status(names.set('ali','923005550002','')),200);
  assert.equal(await status(names.set('ali','923005550003','c')),200);
  assert.deepEqual(Object.keys(await names.list('ali')).sort(),['923005550001','923005550003']);
});
