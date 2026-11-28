import {randomUUID} from 'node:crypto';

// "Something was assigned to you" notifications for the header bell, and the
// "New" tag on a newly assigned customer's chat.
//
// Written when an admin or the super user assigns something to a regular user,
// so someone who was signed out still finds it at their next sign-in. Each
// says what, on which WhatsApp number, who assigned it and when. Three kinds
// (`type`):
//   contact.assigned      a customer (phoneNumber)
//   number.assigned       one of our WhatsApp numbers (the campaign itself)
//   requirement.assigned  a Whatix AI requirement (requirementId, name, the customer's phoneNumber)
//
// A notice about a customer (the first and last kind) has two lives:
//   - in the bell, until the user dismisses it there (`hidden` from then on);
//   - as the chat's "New" tag, until the user opens that customer's chat,
//     which removes it for good (opened()).
// A number.assigned notice is simply removed when dismissed.
//
// Stored per username in app_records (namespace chosen by the caller) as a
// JSON list, newest first, at most `max` per user. The same thing assigned
// again replaces its earlier notice, so the list never repeats one subject.

// What a notice is about; the browser uses the same rule (WaitingAlerts.jsx).
export const noticeSubject=notice=>[notice.type,notice.session,notice.requirementId??notice.phoneNumber??''].join('|');
const aboutCustomer=notice=>notice.type!=='number.assigned';

export function assignmentNotices(store,{now=Date.now,max=300}={}){
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
  // Takes the chosen notices out of the list for good and tells open streams.
  async function drop(username,chosen){
    const rows=lists.get(username),gone=rows.filter(chosen);
    if(!gone.length)return false;
    await save(username,rows.filter(row=>!gone.includes(row)));
    emit(username,'assignment.removed',{ids:gone.map(row=>row.id)});
    return true;
  }
  return {
    // by: {username, name, role} of the admin or super user who assigned it.
    async add(username,{type='contact.assigned',session,campaignPhone,phoneNumber,requirementId,name,by}){
      await ensure(username);
      const notice={id:randomUUID(),type,session,campaignPhone:String(campaignPhone),
        ...(phoneNumber===undefined?{}:{phoneNumber:String(phoneNumber)}),...(requirementId===undefined?{}:{requirementId}),...(name?{name:String(name)}:{}),
        assignedBy:{username:by.username,name:by.name||by.username,role:by.role},at:now()};
      const subject=noticeSubject(notice);
      const rows=[notice,...lists.get(username).filter(row=>noticeSubject(row)!==subject)].slice(0,max);
      await save(username,rows);
      emit(username,'assignment.added',notice);
      return notice;
    },
    async list(username){await ensure(username);return [...lists.get(username)];},
    // Dismissed in the bell. id: one notice, a list of them (a group dismissed
    // together), or undefined for all of this user's notices. A customer's
    // notice stays, hidden, for its chat's "New" tag; any other is removed.
    async dismiss(username,id){
      await ensure(username);
      const chosen=id===undefined?()=>true:Array.isArray(id)?row=>id.includes(row.id):row=>row.id===id;
      const hide=lists.get(username).filter(row=>chosen(row) && aboutCustomer(row) && !row.hidden);
      if(hide.length){
        await save(username,lists.get(username).map(row=>hide.includes(row)?{...row,hidden:true}:row));
        emit(username,'assignment.hidden',{ids:hide.map(row=>row.id)});
      }
      const removed=await drop(username,row=>chosen(row) && !aboutCustomer(row));
      return hide.length>0 || removed;
    },
    // The user opened this customer's chat on this number: nothing about that
    // customer is new any more.
    async opened(username,session,phoneNumber){
      await ensure(username);
      return drop(username,row=>aboutCustomer(row) && row.session===session && row.phoneNumber===String(phoneNumber));
    },
    // Notices that no longer hold (the assignment was changed or taken away).
    async remove(username,ids){
      await ensure(username);
      return drop(username,row=>ids.includes(row.id));
    },
    subscribe(username,listener){
      if(!listeners.has(username))listeners.set(username,new Set());
      listeners.get(username).add(listener);
      return ()=>{const set=listeners.get(username);set?.delete(listener);if(set && !set.size)listeners.delete(username);};
    }
  };
}
