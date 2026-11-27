import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { upstreamHub } from '../src/upstream-hub.js';

// A stand-in for the ws client: records every socket the hub opens.
function fakeSockets(){
  const opened=[];
  class Socket extends EventEmitter{
    constructor(url){super();this.url=String(url);this.closed=false;opened.push(this);}
    close(){this.closed=true;}
  }
  return {Socket,opened};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function subscriber(){
  const log=[];
  return {log,ready(){log.push('ready');},lost(){log.push('lost');},event(e){log.push(e.n);}};
}

test('one WAHA socket serves every stream of an inbox',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const {Socket,opened}=fakeSockets();
  const seen=[];
  const hub=upstreamHub({url:()=>'ws://waha/ws',Socket,onEvent:e=>seen.push(e.n)});
  const a=subscriber(),b=subscriber();
  const offA=hub.subscribe(a);
  const offB=hub.subscribe(b);
  assert.equal(opened.length,1);                         // two tabs, one socket
  opened[0].emit('open');
  assert.deepEqual([a.log,b.log],[['ready'],['ready']]);
  opened[0].emit('message',Buffer.from(JSON.stringify({n:1})));
  opened[0].emit('message',Buffer.from('not json'));      // ignored
  assert.deepEqual(seen,[1]);                              // shared bookkeeping once per event
  assert.deepEqual([a.log,b.log],[['ready',1],['ready',1]]);

  // A tab that joins an open socket is told it is ready.
  const c=subscriber();const offC=hub.subscribe(c);await flush();
  assert.deepEqual(c.log,['ready']);
  assert.equal(opened.length,1);

  // The socket closes only when the last stream leaves.
  offA();offB();assert.equal(opened[0].closed,false);
  offC();assert.equal(opened[0].closed,true);
  assert.equal(hub.size,0);
});

test('a dropped socket ends the streams, and failed attempts back off',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const {Socket,opened}=fakeSockets();
  const hub=upstreamHub({url:()=>'ws://waha/ws',Socket,minDelayMs:1000,maxDelayMs:8000});
  const a=subscriber();
  let off=hub.subscribe(a);
  opened[0].emit('open');
  t.mock.timers.tick(60_000);                               // a minute of normal use
  opened[0].emit('close');                                  // WAHA restarted
  assert.deepEqual(a.log,['ready','lost']);
  off();                                                    // the stream ended; the browser reconnects

  // A working connection that dropped is retried at once.
  off=hub.subscribe(subscriber());
  assert.equal(opened.length,2);
  // WAHA is down: each failed attempt doubles the wait, however many tabs retry.
  for(let i=0;i<4;i++){
    opened.at(-1).emit('error',new Error('ECONNREFUSED'));
    const before=opened.length;
    for(let tab=0;tab<5;tab++)hub.subscribe(subscriber());  // more tabs reconnecting
    assert.equal(opened.length,before);                    // none of them opens a socket
    t.mock.timers.tick(10_000);
    assert.equal(opened.length,before+1);
  }
  // Waits were 2 s, 4 s, 8 s, 8 s (capped), each well inside the 10 s tick.
  assert.equal(opened.length,6);
  opened.at(-1).emit('open');                               // back up: everyone waiting gets "ready"
  assert.ok(hub.open);
});
