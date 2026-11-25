// Which incoming chats a signed-in staff member can actually see.
// The super user and admins see every chat. A regular user sees only the
// numbers assigned to them (manual assignments and assigned offline
// requirements). A chat with nobody able to see it gets the offline AI
// responder; a chat somebody can see gets holding replies instead.
export function chatCoverage({onlineStaff,numbersFor,phoneFor,refreshMs=30000,now=Date.now,maxChats=10000}){
  const assigned=new Map();   // username -> Set of phone digit strings
  const aliases=new Map();    // 123@lid -> phone digits (or the LID if unknown)
  const periods=new Map();    // chat key -> null while covered, {since} while not
  let loadedAt=0,changedAt=now(),refreshing=null,queued=null;

  function keyFor(chatId){
    if(typeof chatId!=='string')return null;
    const digits=/^(\d+)@(?:c\.us|s\.whatsapp\.net)$/.exec(chatId)?.[1] ?? /^(\d+)$/.exec(chatId)?.[1];
    if(digits)return digits;
    return /^\d+@lid$/.test(chatId)?aliases.get(chatId)??chatId:null;
  }
  function isCovered(key){
    const staff=onlineStaff();
    return staff.some(member=>member.isAdmin) || staff.some(member=>assigned.get(member.username)?.has(key));
  }
  // Load assignments for every signed-in regular user. A user whose database
  // read fails keeps their previous numbers rather than losing coverage.
  async function load(){
      const staff=onlineStaff().filter(member=>!member.isAdmin);
      const online=new Set(staff.map(member=>member.username));
      for(const username of assigned.keys())if(!online.has(username))assigned.delete(username);
      await Promise.all(staff.map(async member=>{
        try{assigned.set(member.username,new Set((await numbersFor(member)).map(String)));}
        catch{console.warn('Assigned numbers unavailable for chat coverage');}
      }));
      loadedAt=now();
  }
  // A refresh requested while one is running (someone signs in just after
  // someone else signs out) runs again afterwards, so it sees the new sign-in.
  function refresh(){
    if(!refreshing){
      refreshing=load().finally(()=>{refreshing=null;});
      return refreshing;
    }
    queued??=refreshing.then(()=>{queued=null;return refresh();});
    return queued;
  }
  // Sign-in, sign-out or an assignment change: re-evaluate every known chat so a
  // chat that just lost its last viewer starts a fresh offline period.
  async function changed(){
    changedAt=now();
    await refresh();
    for(const [key,period] of periods){
      const covered=isCovered(key);
      if(covered)periods.set(key,null);
      else if(period===null)periods.set(key,{since:changedAt});
    }
  }
  // Before a message is handled: resolve its linked ID and make sure the
  // assignment cache is recent.
  async function resolve(chatId){
    if(typeof chatId==='string' && /^\d+@lid$/.test(chatId) && !aliases.has(chatId)){
      const phone=await phoneFor(chatId).catch(()=>null);
      aliases.set(chatId,phone?String(phone):chatId);
    }
    // A sign-in that is still loading its numbers must finish first.
    if(refreshing)await (queued??refreshing);
    else if(now()-loadedAt>=refreshMs)await refresh();
  }
  return {
    resolve,changed,refresh,
    covered:chatId=>{const key=keyFor(chatId);return !!key && isCovered(key);},
    // Whether one signed-in staff member can see a chat (for notifications).
    canSee(member,chatId){
      if(member?.isAdmin)return true;
      const key=keyFor(chatId);
      return !!key && !!assigned.get(member?.username)?.has(key);
    },
    // null while someone can see the chat; otherwise a stable object for the
    // current uncovered stretch (a new object starts a new offline period).
    periodFor(chatId){
      const key=keyFor(chatId);
      if(!key)return null;
      if(isCovered(key)){periods.set(key,null);return null;}
      let period=periods.get(key);
      if(!period){
        period={since:changedAt};
        periods.set(key,period);
        if(periods.size>maxChats)periods.delete(periods.keys().next().value);
      }
      return period;
    }
  };
}
