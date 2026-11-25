// Holding replies while staff are signed in but have not reached a chat yet.
// The offline AI responder covers the time when nobody is signed in.
const footer='\n\n*this message is Auto Generated*';
const salaam=/^(?:as[\s-]*sala+a?m|sala+a?m[\s-]*[ae]l[ae]?[iy]k[ua]m|السلام\s+عل[يی][كک]م)/iu;
// Rotated so a customer who writes again later does not get identical wording.
export const holdingReplies=[
  'Thank you for your message! Our representatives are currently assisting other customers and will be with you shortly. We appreciate your patience.',
  'Thank you for reaching out to Brand Matrix. A member of our team will be with you shortly. We appreciate your patience.',
  'Thanks for getting in touch! All of our representatives are busy at the moment, but one of them will reply to you as soon as possible.'
];
// Sent when a client who already got a holding reply writes again and is still
// waiting: apologetic and warm, so the wait feels acknowledged, not ignored.
export const followUpReplies=[
  'We sincerely apologise for the wait, and thank you so much for your patience. Your message is important to us, and a representative will be with you as soon as possible.',
  'Thank you for bearing with us, and we are sorry to keep you waiting. Our team has your message and will reply to you very shortly. We truly appreciate your understanding.',
  'We apologise for the delay and genuinely appreciate your patience. A member of our team will get back to you as soon as they are free. Thank you for waiting with us.'
];

// staffOnline(chatId) is true while a staff member who can see that chat is
// signed in: any admin or the super user, or a regular user it is assigned to.
// Chat identities differ (923001234567@c.us, 1234@lid, 923001234567). Messages
// and staff actions are matched on the phone digits when WAHA can resolve them.
// onHeld(chatId,key) runs after a holding reply was sent (the customer is now
// waiting); onAttended(key) runs when a staff member opens or answers the chat.
// Per unattended stretch: one holding reply delayMs after the message; if the
// client writes again, one apologetic follow-up no sooner than followUpGapMs
// after that; then at most one further follow-up per cooldownMs.
export function busyResponder({session,staffOnline,phoneFor,send,onHeld=()=>{},onAttended=()=>{},delayMs=60000,followUpGapMs=300000,engagedMs=600000,cooldownMs=1800000,now=Date.now,timers={setTimeout,clearTimeout}}){
  const chats=new Map(), aliases=new Map(), seen=new Set();
  let rotation=0,followUpRotation=0;
  async function keyFor(chatId){
    const digits=/^(\d+)@(?:c\.us|s\.whatsapp\.net)$/.exec(chatId)?.[1] ?? /^(\d+)$/.exec(chatId)?.[1];
    if(digits)return digits;
    if(!/^\d+@lid$/.test(chatId))return null;
    if(!aliases.has(chatId)){
      const phone=await phoneFor(chatId).catch(()=>null);
      aliases.set(chatId,phone?String(phone):chatId);
    }
    return aliases.get(chatId);
  }
  const state=key=>{let chat=chats.get(key);if(!chat)chats.set(key,chat={attendedAt:-Infinity,repliedAt:-Infinity,followUps:0,timer:null});return chat;};

  // A staff member opened the chat or sent it a message.
  async function attended(chatId){
    const key=typeof chatId==='string'?await keyFor(chatId):null;
    if(!key)return;
    const chat=state(key);
    chat.attendedAt=now();
    chat.followUps=0;
    if(chat.timer){timers.clearTimeout(chat.timer);chat.timer=null;}
    onAttended(key);
  }

  async function handle(event){
    const msg=event?.payload;
    if(event?.session!==session || event.event!=='message' || msg?.fromMe!==false || typeof msg.from!=='string' ||
      !/^\d+@(?:c\.us|s\.whatsapp\.net|lid)$/.test(msg.from) || !staffOnline(msg.from))return;
    const id=typeof msg.id==='string'?msg.id:msg.id?._serialized;
    const timestamp=Number(msg.timestamp)*1000;
    if(typeof id!=='string' || !id || seen.has(id) || !Number.isFinite(timestamp) || timestamp<now()-5*60000)return;
    seen.add(id);
    if(seen.size>5000)seen.delete(seen.values().next().value);
    const key=await keyFor(msg.from);
    if(!key)return;
    const chat=state(key);
    const arrived=now();
    // A conversation a representative is already handling (ClientA) is left alone,
    // as is a chat with a reply already scheduled.
    if(chat.timer || arrived-chat.attendedAt<engagedMs)return;
    // Still waiting since an earlier holding reply: a follow-up instead, once
    // per stretch at the gap, then only after the cooldown.
    const waiting=chat.repliedAt>chat.attendedAt;
    const sinceReply=arrived-chat.repliedAt;
    if(waiting && chat.followUps>0 && sinceReply<cooldownMs)return;
    const followUp=waiting;
    const wait=followUp?Math.max(delayMs,followUpGapMs-sinceReply):delayMs;
    const greeted=!followUp && salaam.test(typeof msg.body==='string'?msg.body.trim():'');
    chat.timer=timers.setTimeout(async()=>{
      chat.timer=null;
      // Nobody signed in any more (the offline responder takes over), or someone
      // opened or answered the chat in the meantime.
      if(!staffOnline(msg.from) || chat.attendedAt>=arrived)return;
      const text=followUp?followUpReplies[followUpRotation++%followUpReplies.length]:
        (greeted?'Wa Alaikum as-Salaam! ':'')+holdingReplies[rotation++%holdingReplies.length];
      try{
        await send(msg.from,text+footer);
        chat.repliedAt=now();
        chat.followUps=followUp?chat.followUps+1:0;
        onHeld(msg.from,key);
      }catch(error){console.warn('Busy holding reply failed — '+(error?.statusCode?'HTTP '+error.statusCode:'send failed'));}
    },wait);
    chat.timer.unref?.();
  }
  function stop(){for(const chat of chats.values())if(chat.timer)timers.clearTimeout(chat.timer);}
  return {handle,attended,stop};
}
