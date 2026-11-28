// A user's own names for customers ("Hassan - website"), so they can tell
// their chats apart. Private to that user: nobody else sees them, and nothing
// is sent to WhatsApp or changed for other staff.
//
// Stored per username in app_records (namespace chosen by the caller) as a
// JSON object {phone digits: name}. A customer is the same person on every
// one of our WhatsApp numbers, so a name is kept per phone, not per number.
const fail=(status,message)=>Object.assign(Error(message),{status});
export const ALIAS_MAX_LENGTH=60;

export function contactAliases(store,{max=2000}={}){
  const maps=new Map();     // username -> {phone: name}, once read from the store
  const reading=new Map();  // username -> the read in progress
  function ensure(username){
    if(maps.has(username))return Promise.resolve();
    if(!reading.has(username))reading.set(username,(async()=>{
      let names={};
      try{const saved=JSON.parse(await store.get(username)||'{}');if(saved && typeof saved==='object' && !Array.isArray(saved))names=saved;}
      catch{ /* unreadable: start empty */ }
      if(!maps.has(username))maps.set(username,names);
    })().finally(()=>reading.delete(username)));
    return reading.get(username);
  }
  return {
    async list(username){await ensure(username);return {...maps.get(username)};},
    // name: the new name, or '' to go back to the customer's own name.
    async set(username,phone,name){
      if(typeof phone!=='string' || !/^[1-9]\d{0,14}$/.test(phone))throw fail(400,'Choose a customer with a phone number');
      if(typeof name!=='string')throw fail(400,'Enter a name');
      // One line of ordinary text: no control characters, single spaces.
      const clean=name.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
      if(clean.length>ALIAS_MAX_LENGTH)throw fail(400,'Use a name of up to '+ALIAS_MAX_LENGTH+' characters');
      await ensure(username);
      const names={...maps.get(username)};
      if(clean){
        if(!(phone in names) && Object.keys(names).length>=max)throw fail(409,'You have renamed the maximum number of customers. Remove a name you no longer need.');
        names[phone]=clean;
      }else delete names[phone];
      // Replaced in memory at once, then written, so two changes cannot overwrite each other.
      maps.set(username,names);
      await (Object.keys(names).length?store.put(username,JSON.stringify(names)):store.drop(username));
      return {...names};
    }
  };
}
