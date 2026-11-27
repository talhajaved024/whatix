import WebSocket from 'ws';

// One WAHA WebSocket per inbox, shared by every open browser stream of that
// inbox (audit PERF-02). Before, each stream opened its own socket, so WAHA
// load grew with the number of open tabs and a WAHA outage made every tab
// reconnect every 3 s.
//
// - Opens on the first subscriber and closes when the last one leaves.
// - Each event is parsed once and handed to every subscriber. A subscriber
//   that changes an event (per-user media links) must copy it first.
// - `ready()` is called when the socket is open (at once for a subscriber
//   that joins an open socket); `lost()` when it drops. Streams end on `lost`,
//   as they did when they owned the socket, so browsers reconnect and resync.
// - Failed attempts back off 1 s, 2 s, 4 s … up to 30 s, however many tabs are
//   trying; a connection that worked and then dropped is retried after 1 s.
export function upstreamHub({url,onEvent=()=>{},minDelayMs=1000,maxDelayMs=30000,Socket=WebSocket}){
  const subscribers=new Set();
  let socket=null,open=false,timer=null,delay=minDelayMs,lastAttempt=null;
  function connect(){
    timer=null;
    if(!subscribers.size || socket)return;
    lastAttempt=Date.now();
    const current=socket=new Socket(url());
    current.on('open',()=>{
      if(socket!==current)return;
      open=true;delay=minDelayMs;
      for(const subscriber of [...subscribers])subscriber.ready?.();
    });
    current.on('message',raw=>{
      if(socket!==current)return;
      let event;try{event=JSON.parse(raw.toString());}catch{return;}
      try{onEvent(event);}catch{ /* shared bookkeeping must not stop delivery */ }
      for(const subscriber of [...subscribers])subscriber.event(event);
    });
    const down=()=>{
      if(socket!==current)return;
      // A socket that never opened is a failed attempt: wait longer next time.
      // One that was working and dropped (WAHA restart) is retried quickly.
      delay=open?minDelayMs:Math.min(delay*2,maxDelayMs);
      socket=null;open=false;
      current.removeAllListeners?.();
      current.on?.('error',()=>{});
      for(const subscriber of [...subscribers])subscriber.lost?.();
      schedule();
    };
    current.on('error',down);
    current.on('close',down);
  }
  // Connects as soon as the back-off since the last attempt allows.
  function schedule(){
    if(timer || socket || !subscribers.size)return;
    const wait=lastAttempt===null?0:Math.max(0,lastAttempt+delay-Date.now());
    if(!wait){connect();return;}
    timer=setTimeout(connect,wait);
    timer.unref?.();
  }
  return {
    subscribe(subscriber){
      subscribers.add(subscriber);
      if(open)queueMicrotask(()=>{if(subscribers.has(subscriber))subscriber.ready?.();});
      // Right after a failure this waits out the back-off instead of hammering WAHA.
      else schedule();
      return ()=>{
        if(!subscribers.delete(subscriber) || subscribers.size)return;
        clearTimeout(timer);timer=null;
        if(socket){const current=socket;socket=null;open=false;current.removeAllListeners?.();current.on?.('error',()=>{});current.close();}
      };
    },
    get size(){return subscribers.size;},
    get open(){return open;}
  };
}
