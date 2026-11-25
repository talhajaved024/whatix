// "Client is waiting for your reply" notifications. One per chat: created when
// a holding reply goes out, removed for everyone once a staff member opens or
// answers that chat. In memory only, like the rest of the live chat state.
export function waitingAlerts({now=Date.now,max=500}={}){
  const alerts=new Map(), listeners=new Set();
  const emit=(type,data)=>{for(const listener of listeners)try{listener(type,data);}catch{/* one bad stream must not stop the rest */}};
  return {
    // key: phone digits when known (else the @lid chat ID); chatId: the WhatsApp chat.
    add(chatId,key){
      const phone=/^\d+$/.test(key)?key:null;
      const alert={id:key,chatId,phoneNumber:phone?'+'+phone:null,openKey:phone??chatId,since:now()};
      alerts.delete(key);
      alerts.set(key,alert);
      if(alerts.size>max)alerts.delete(alerts.keys().next().value);
      emit('client.waiting',alert);
    },
    clear(key){if(alerts.delete(key))emit('client.attended',{id:key});},
    list:()=>[...alerts.values()],
    subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);}
  };
}
