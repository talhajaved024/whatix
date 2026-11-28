// What belongs to a WhatsApp number goes when the number goes.
//
// A number is one WAHA session paired to one phone. It leaves either when an
// admin deletes the session (Add Number tab) or when the session is paired to a
// different phone. Either way everything Whatix kept for it is erased, so
// nothing of it can show up under the number that takes its place:
//   - which users held it, the campaigns they saw and the customers assigned to
//     them (campaigns.retire),
//   - its queued broadcasts, hidden chats and campaign deletions (forget),
//   - and every browser's and phone's saved chat history, which is filed under
//     an account ID that includes this number's generation (server.js): a
//     retired number's ID is never handed out again, and devices delete what
//     they hold for it (/api/history-accounts).
// Whatix AI requirements are business records and are kept.
//
// store: records namespace, one row per session name: {phone, generation}.
// phone is the phone last seen paired (null once deleted); generation counts
// how many numbers this session name has seen leave.
export async function numberRetirement({store,campaigns,forget}){
  const state=new Map();
  for(const name of await store.keys()){
    try{const row=JSON.parse(await store.get(name));if(row && Number.isSafeInteger(row.generation))state.set(name,row);}catch{ /* unreadable: treated as never seen */ }
  }
  const queue=new Map();
  function serial(name,work){
    const next=(queue.get(name)??Promise.resolve()).catch(()=>{}).then(work);
    queue.set(name,next);
    return next.finally(()=>{if(queue.get(name)===next)queue.delete(name);});
  }
  const remember=async(name,row)=>{await store.put(name,JSON.stringify(row));state.set(name,row);};
  // The record is written last: a failure part-way leaves it unchanged, so the
  // next sighting of the number runs the whole erasure again.
  async function retire(name,phone){
    await forget(name);
    await campaigns.retire(name,phone);
    await remember(name,{phone,generation:(state.get(name)?.generation??0)+1});
  }
  return {
    generation:name=>state.get(name)?.generation??0,
    // `name` is connected and paired to `phone` right now.
    observe(name,phone){
      if(state.get(name)?.phone===phone)return;
      return serial(name,async()=>{
        const known=state.get(name);
        if(known?.phone===phone)return;
        if(known?.phone)return retire(name,phone);
        // First sighting (or the first number after a deletion): nothing is known
        // to have left, but assignments filed under any other phone are leftovers.
        await campaigns.retire(name,phone);
        await remember(name,{phone,generation:known?.generation??0});
      });
    },
    // The session was deleted.
    remove:name=>serial(name,()=>retire(name,null))
  };
}
