const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'});
export const receivedDate=timestamp=>dateFormat.format(timestamp);

export function requirementRange(query,now=Date.now()){
  const month=receivedDate(now).slice(0,7);
  const [year,m]=month.split('-').map(Number);
  const from=query.from??month+'-01';
  const to=query.to??new Date(Date.UTC(year,m,0)).toISOString().slice(0,10);
  const valid=v=>typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v;
  return valid(from) && valid(to) && from<=to ? {from,to}:null;
}

const table='"offline requirements"';
const fields='r.ID AS id,r.NAME AS name,r.PHONE AS phone,r.QUERY AS query';
function record(row){
  if(!row)return null;
  const {keys,...rest}=row;
  return {...rest,history:JSON.parse(rest.history)};
}
const entry=row=>({...row,assignedUserIds:JSON.parse(row.assignedUserIds)});
export function requirementStore(db){
  function matches(s,keys){
    return s.all('SELECT '+fields+',c.customer_context AS history,c.version,c.sender_keys AS keys FROM '+table+
      ' r JOIN intake_context c ON r.ID=c.ID WHERE EXISTS(SELECT 1 FROM json_each(c.sender_keys) WHERE value IN (SELECT value FROM json_each(?))) ORDER BY r.ID',[JSON.stringify(keys)]);
  }
  const select='SELECT '+fields+',r.DATE_RECIEVED AS dateReceived,r.RECEIVED_SESSION AS receivedSession,r.RECEIVED_BY AS receivedBy,r.assigned_user AS assignedUserIds FROM '+table+' r';
  // numbersFor runs on every request and live event of a regular user, so its
  // answers are cached (audit PERF-03). Every write below clears the cache, and
  // an answer read while a write was in flight is not kept.
  let version=0;
  const assigned=new Map(); // userId|session|main -> phones
  const write=fn=>async(...args)=>{try{return await fn(...args);}finally{version++;assigned.clear();}};
  return {
    projects:keys=>db.use(async s=>(await matches(s,keys)).map(({id,query,version})=>({id,query,version}))),
    list:({from,to})=>db.use(async s=>(await s.all(select+' WHERE DATE_RECIEVED BETWEEN ? AND ? ORDER BY DATE_RECIEVED DESC,r.ID DESC',[from,to])).map(entry)),
    // One page of a date range, newest first, optionally searched by name, phone or query text.
    page:({from,to},{q='',offset,pageSize})=>db.use(async s=>{
      const where=' WHERE DATE_RECIEVED BETWEEN ? AND ?'+(q?' AND (instr(lower(r.NAME),?)>0 OR instr(CAST(r.PHONE AS TEXT),?)>0 OR instr(lower(r.QUERY),?)>0 OR instr(COALESCE(r.RECEIVED_BY,\'\'),?)>0)':'');
      const params=q?[from,to,q,q.replace(/^\+/,''),q,q.replace(/^\+/,'')]:[from,to];
      const {total}=await s.get('SELECT COUNT(*) AS total FROM '+table+' r'+where,params);
      const rows=await s.all(select+where+' ORDER BY DATE_RECIEVED DESC,r.ID DESC LIMIT ? OFFSET ?',[...params,pageSize,offset]);
      return {rows:rows.map(entry),total};
    }),
    // Customers a user was assigned through requirements received by one of our
    // numbers (session); rows without a session belong to the main number.
    async numbersFor(userId,session,main){
      const key=userId+'|'+session+'|'+(main?1:0),seen=version;
      if(assigned.has(key))return assigned.get(key);
      const phones=await db.use(async s=>(await s.all('SELECT DISTINCT COALESCE(c.original_chat_phone,r.PHONE) AS phone FROM '+table+
        ' r LEFT JOIN intake_context c ON c.ID=r.ID WHERE EXISTS(SELECT 1 FROM json_each(r.assigned_user) WHERE value=?)'+
        ' AND (r.RECEIVED_SESSION=? OR (r.RECEIVED_SESSION IS NULL AND ?=1))',[userId,session,main?1:0])).map(r=>r.phone));
      if(version===seen)assigned.set(key,phones);
      return phones;
    },
    get:id=>db.use(async s=>{const row=await s.get(select+' WHERE r.ID=?',[id]);return row?entry(row):null;}),
    setAssignees:write((id,ids,expected,eligible)=>db.transaction(async s=>{
      const row=await s.get(select+' WHERE r.ID=?',[id]);
      if(!row)return {status:404};
      const current=entry(row).assignedUserIds.filter(n=>eligible.has(n));
      if(expected&&(current.length!==expected.length || !current.every(n=>expected.includes(n))))return {status:409};
      await s.run('UPDATE '+table+' SET assigned_user=? WHERE ID=?',[JSON.stringify(ids),id]);
      return {status:200,requirement:{...row,assignedUserIds:ids}};
    })),
    // Admin-entered requirement (no WhatsApp intake conversation behind it).
    create:write(({name,phone,query,dateReceived,receivedSession=null,receivedBy=null})=>db.transaction(async s=>{
      const {id}=await s.run('INSERT INTO '+table+'(NAME,PHONE,QUERY,DATE_RECIEVED,RECEIVED_SESSION,RECEIVED_BY) VALUES(?,?,?,?,?,?)',
        [name,phone,query,dateReceived,receivedSession,receivedBy]);
      return entry(await s.get(select+' WHERE r.ID=?',[id]));
    })),
    // Admin edit of the details. When the requirement came from a WhatsApp
    // intake, its version moves on (the intake then re-reads instead of
    // overwriting the edit) and the original chat stays visible to assignees.
    update:write((id,{name,phone,query,dateReceived,receivedSession=null,receivedBy=null})=>db.transaction(async s=>{
      const row=await s.get(select+' WHERE r.ID=?',[id]);
      if(!row)return null;
      await s.run('UPDATE '+table+' SET NAME=?,PHONE=?,QUERY=?,DATE_RECIEVED=?,RECEIVED_SESSION=?,RECEIVED_BY=? WHERE ID=?',
        [name,phone,query,dateReceived,receivedSession,receivedBy,id]);
      await s.run('UPDATE intake_context SET version=version+1,original_chat_phone=CASE WHEN ?<>? THEN COALESCE(original_chat_phone,?) ELSE original_chat_phone END WHERE ID=?',
        [phone,row.phone,row.phone,id]);
      return entry(await s.get(select+' WHERE r.ID=?',[id]));
    })),
    remove:write(id=>db.use(async s=>(await s.run('DELETE FROM '+table+' WHERE ID=?',[id])).changes>0)),
    lookup:write((keys,verifiedPhone)=>db.transaction(async s=>{
      const old=(await matches(s,keys)).at(-1);
      if(old||!verifiedPhone)return record(old);
      const row=await s.get('SELECT '+fields+' FROM '+table+' r WHERE PHONE=? AND NOT EXISTS(SELECT 1 FROM intake_context c WHERE c.ID=r.ID) ORDER BY r.ID DESC LIMIT 1',[verifiedPhone]);
      if(!row)return null;
      await s.run("INSERT INTO intake_context VALUES(?,?,'[]',1,NULL)",[row.id,JSON.stringify(keys)]);
      return {...row,history:[],version:1};
    })),
    add:write(input=>db.transaction(async s=>{
      const {name,phone,query,dateReceived,keys,history,updateVersion,baseId,separateAfter,callbackPhone,newName}=input;
      if(!name||!query||!Number.isSafeInteger(phone)||phone<=0||phone>999999999999999)throw Error('Incomplete requirement');
      const old=(await matches(s,keys)).at(-1);
      const separate=old&&separateAfter===old.id&&baseId===old.id&&!updateVersion;
      if(old&&((baseId&&baseId!==old.id)||(!separate&&old.version!==updateVersion)))return {state:'existing',record:record(old)};
      if(updateVersion&&!old)throw Error('Saved requirement unavailable');
      const recent=history.slice(-6).map(line=>line.slice(0,1000));
      if(old&&!separate){
        if(callbackPhone!==undefined&&(!Number.isSafeInteger(callbackPhone)||!/^[1-9]\d{6,14}$/.test(String(callbackPhone))))throw Error('Invalid callback number');
        if(newName!==undefined&&(typeof newName!=='string'||!newName.trim()||newName.length>128))throw Error('Invalid name');
        const updated={id:old.id,name:newName?.trim()??old.name,phone:callbackPhone??old.phone,query,history:recent,version:updateVersion+1};
        await s.run('UPDATE '+table+' SET NAME=?,PHONE=?,QUERY=? WHERE ID=?',[updated.name,updated.phone,query,old.id]);
        await s.run('UPDATE intake_context SET sender_keys=?,customer_context=?,version=?,original_chat_phone=COALESCE(original_chat_phone,?) WHERE ID=?',
          [JSON.stringify([...new Set([...JSON.parse(old.keys),...keys])]),JSON.stringify(recent),updated.version,callbackPhone===undefined?null:old.phone,old.id]);
        return {state:'updated',record:updated};
      }
      const {id}=await s.run('INSERT INTO '+table+'(NAME,PHONE,QUERY,DATE_RECIEVED) VALUES(?,?,?,?)',[name,phone,query,dateReceived]);
      await s.run('INSERT INTO intake_context VALUES(?,?,?,1,NULL)',[id,JSON.stringify(keys),JSON.stringify(recent)]);
      return {state:'created',record:{id,name,phone,query,history:recent,version:1}};
    }))
  };
}

export async function senderPhone(chatId,waha,session,headers){
  const digits=jid=>typeof jid==='string' && /^([1-9]\d{0,14})@(?:c\.us|s\.whatsapp\.net)$/.exec(jid)?.[1];
  if(digits(chatId))return Number(digits(chatId));
  const lid=/^(\d+)@lid$/.exec(chatId);
  if(!lid)return null;
  try{
    const res=await fetch(waha+'/api/'+encodeURIComponent(session)+'/lids/'+lid[1],{headers:headers(),redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!res.ok){await res.body?.cancel();return null;}
    const pn=digits((await res.json()).pn);
    return pn?Number(pn):null;
  }catch{return null;}
}
