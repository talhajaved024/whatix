import {randomUUID} from 'node:crypto';

// "A customer was assigned to you" notifications for the header bell.
//
// Written when an admin or the super user assigns a customer to a regular
// user, and kept until that user opens or dismisses it, so someone who was
// signed out still finds it at their next sign-in. Each says which customer,
// on which WhatsApp number, who assigned it and when.
//
// Stored per username in app_records (namespace chosen by the caller) as a
// JSON list, newest first, at most `max` per user. A customer assigned again
// replaces its earlier notice, so the list never repeats one customer.
export function assignmentNotices(store,{now=Date.now,max=50}={}){
  const lists=new Map();      // username -> notices, once read from the store
  const reading=new Map();    // username -> the read in progress
  const listeners=new Map();  // username -> Set of listeners
  function ensure(username){
    if(lists.has(username))return Promise.resolve();
    if(!reading.has(username))reading.set(username,(async()=>{
      let rows=[];
      try{const saved=JSON.parse(await store.get(username)||'[]');if(Array.isArray(saved))rows=saved;}
      catch{ /* unreadable: start empty rather than lose new notices */ }
      if(!lists.has(username))lists.set(username,rows);
    })().finally(()=>reading.delete(username)));
    return reading.get(username);
  }
  // The list is replaced in memory at once and then written, so two changes
  // made together cannot overwrite each other; writes reach the store in order.
  function save(username,rows){
    lists.set(username,rows);
    return rows.length?store.put(username,JSON.stringify(rows)):store.drop(username);
  }
  function emit(username,type,data){
    for(const listener of listeners.get(username)||[])try{listener(type,data);}catch{ /* one bad stream must not stop the rest */ }
  }
  return {
    // by: {username, name, role} of the admin or super user who assigned it.
    async add(username,{session,campaignPhone,phoneNumber,by}){
      await ensure(username);
      const notice={id:randomUUID(),type:'contact.assigned',session,campaignPhone:String(campaignPhone),phoneNumber:String(phoneNumber),
        assignedBy:{username:by.username,name:by.name||by.username,role:by.role},at:now()};
      const rows=[notice,...lists.get(username).filter(row=>!(row.session===session && row.phoneNumber===notice.phoneNumber))].slice(0,max);
      await save(username,rows);
      emit(username,'assignment.added',notice);
      return notice;
    },
    async list(username){await ensure(username);return [...lists.get(username)];},
    // id: one notice, or undefined for all of this user's notices.
    async dismiss(username,id){
      await ensure(username);
      const rows=lists.get(username),kept=id===undefined?[]:rows.filter(row=>row.id!==id);
      if(kept.length===rows.length)return false;
      await save(username,kept);
      emit(username,'assignment.removed',id===undefined?{all:true}:{id});
      return true;
    },
    subscribe(username,listener){
      if(!listeners.has(username))listeners.set(username,new Set());
      listeners.get(username).add(listener);
      return ()=>{const set=listeners.get(username);set?.delete(listener);if(set && !set.size)listeners.delete(username);};
    }
  };
}
