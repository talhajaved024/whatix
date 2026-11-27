import { createHash, randomInt } from 'node:crypto';
import { Router } from 'express';
import { validMessageId } from './sent-messages.js';

const kinds=new Map([['text','sendText'],['document','sendFile'],['image','sendImage'],['video','sendVideo'],['voice','sendVoice']]);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const minBatchSize=10;
// One person cannot flood the shared queue: a recipient ceiling per job and a
// few unfinished jobs per person at a time.
const MAX_RECIPIENTS=5000;
const MAX_ACTIVE_JOBS=3;
function nextBatchSize(){return randomInt(minBatchSize,15 + 1);}

function normalize(input){
  if(!input || typeof input.id!=='string' || !uuid.test(input.id) || !Array.isArray(input.recipients))return;
  const chats=new Set();
  for(const value of input.recipients){
    if(typeof value!=='string')return;
    const match=/^\+?([1-9]\d{0,19})(?:@(lid|c\.us|s\.whatsapp\.net))?$/.exec(value);
    if(!match)return;
    chats.add(match[1]+(match[2]==='lid'?'@lid':'@c.us'));
  }
  if(chats.size<=minBatchSize || !kinds.has(input.kind))return;
  const {kind,text='',convert=false}=input;
  if(typeof text!=='string' || typeof convert!=='boolean')return;
  let body;
  if(kind==='text'){
    if(!text.trim())return;
    body={text,linkPreview:true,linkPreviewHighQuality:false};
  }else{
    const f=input.file;
    if(!f || typeof f.filename!=='string' || !f.filename.trim() || typeof f.mimetype!=='string' || !f.mimetype.trim())return;
    const file={filename:f.filename,mimetype:f.mimetype};
    // Media links are downloaded into `data` before this point (send-body.js);
    // WAHA itself is never asked to fetch a URL.
    if(typeof f.data==='string' && f.data.length && f.url===undefined && /^[A-Za-z0-9+/]*={0,2}$/.test(f.data))file.data=f.data;
    else return;
    body={file};
    if(kind!=='voice')body.caption=text;
    if(kind==='video' || kind==='voice')body.convert=convert;
    if(kind==='video')body.asNote=false;
  }
  return {id:input.id.toLowerCase(),recipients:[...chats],kind,body};
}

function summary(job,queued){
  const processed=job.results.length;
  const total=job.recipients.length;
  const sent=job.results.filter(row=>row.ok).length;
  return {id:job.id,total,processed,sent,unsuccessful:processed-sent,nextBatchAt:job.nextBatchAt,
    status:processed===total?(sent===total?'completed':'completed_with_errors'):queued?'queued':job.nextBatchAt>Date.now()?'waiting':'sending',
    results:job.results};
}

// Single-process worker, matching the backend's session store. Each committed
// cursor precedes its external send; uncertain outcomes are never auto-retried.
export async function broadcastQueue(store,{send,canSend}){
  const jobs=new Map();
  const key=(owner,id)=>owner+'-'+id;
  const statePath=j=>key(j.owner,j.id)+'.json';
  const payloadPath=j=>key(j.owner,j.id)+'.payload';
  async function commit(j){
    await store.put(statePath(j),JSON.stringify(j));
    jobs.set(key(j.owner,j.id),j);
    return j;
  }
  const files=await store.keys();
  const committed=new Set(files.filter(name=>name.endsWith('.json')));
  for(const name of files){
    if(name.endsWith('.tmp') || (name.endsWith('.payload') && !committed.has(name.slice(0,-8)+'.json'))){
      await store.drop(name);
      continue;
    }
    if(!name.endsWith('.json'))continue;
    const job=JSON.parse(await store.get(name));
    jobs.set(key(job.owner,job.id),job);
    if(job.results.length===job.recipients.length)await store.drop(payloadPath(job));
  }

  function advance(job,result){
    const results=[...job.results,result];
    const more=results.length<job.recipients.length;
    const pause=more && results.length===job.batchEnd;
    return {...job,results,inFlight:false,nextBatchAt:pause?Date.now()+randomInt(10 * 60_000,20 * 60_000 + 1):0,
      batchEnd:pause?Math.min(job.recipients.length,results.length+nextBatchSize()):job.batchEnd};
  }
  let timer,running=false,closed=false;
  const next=()=>[...jobs.values()].filter(j=>j.results.length<j.recipients.length).sort((a,b)=>a.createdAt-b.createdAt)[0];
  const progress=job=>summary(job,next()!==job);
  async function work(){
    if(running || closed)return;
    running=true;
    let retry=0;
    try{
      let job=next();
      if(!job || job.nextBatchAt>Date.now())return;
      if(job.inFlight){
        const number=job.recipients[job.results.length];
        job=await commit(advance(job,{number,ok:false,error:'Delivery unconfirmed after interruption'}));
      }
      if(job.results.length<job.recipients.length && job.nextBatchAt<=Date.now()){
        if(!await canSend(job.owner)){
          const skipped=job.recipients.slice(job.results.length).map(number=>({number,ok:false,error:'Sender account unavailable'}));
          job=await commit({...job,results:[...job.results,...skipped],nextBatchAt:0});
        }else{
          const body=JSON.parse(await store.get(payloadPath(job)));
          const stop=job.batchEnd;
          while(!closed && job.results.length<stop){
            const number=job.recipients[job.results.length];
            job=await commit({...job,inFlight:true,nextBatchAt:0});
            let result;
            try{result=await send(job,number,body);}
            catch{result={ok:false,error:'Send outcome unconfirmed'};}
            const {retryAt,...outcome}=result;
            const updated=advance(job,{number,...outcome});
            if(retryAt && updated.results.length<updated.recipients.length){
              updated.nextBatchAt=Math.max(updated.nextBatchAt,retryAt);
            }
            job=await commit(updated);
            if(job.nextBatchAt)break;
          }
        }
      }
      if(job.results.length===job.recipients.length)await store.drop(payloadPath(job));
    }catch{console.error('Broadcast worker could not read or save job state');retry=5000;}
    finally{
      running=false;
      const job=next();
      if(!closed && job)timer=setTimeout(work,Math.min(2**31-1,Math.max(retry,job.nextBatchAt-Date.now(),0))).unref();
    }
  }
  function wake(){if(!running && !closed){clearTimeout(timer);timer=setTimeout(work,0).unref();}}
  wake();
  let admission=Promise.resolve();
  const router=Router();
  router.post('/',async(req,res)=>{
    const input=normalize(req.body);
    if(!input)return res.status(400).json({error:`Expected a UUID, more than ${minBatchSize} distinct direct recipients and a valid message`});
    const {id,recipients,kind,body}=input;
    if(recipients.length>MAX_RECIPIENTS)return res.status(400).json({error:`A broadcast can reach at most ${MAX_RECIPIENTS} recipients. Split the list.`});
    const owner=req.userId;
    const payload=JSON.stringify(body);
    const digest=createHash('sha256').update(JSON.stringify([kind,recipients])).update(payload).digest('hex');
    const task=admission.then(async()=>{
      const existing=jobs.get(key(owner,id));
      if(existing)return existing.digest===digest ? existing : null;
      const active=[...jobs.values()].filter(j=>j.owner===owner && j.results.length<j.recipients.length).length;
      if(active>=MAX_ACTIVE_JOBS)return 'busy';
      const job={id,owner,recipients,kind,digest,createdAt:Date.now(),batchEnd:Math.min(recipients.length,nextBatchSize()),nextBatchAt:0,inFlight:false,results:[]};
      await store.put(payloadPath(job),payload);
      await commit(job);
      wake();
      return job;
    });
    admission=task.catch(()=>{});
    try{
      const job=await task;
      if(!job)return res.status(409).json({error:'Broadcast ID already used for a different request'});
      if(job==='busy')return res.status(429).json({error:`You already have ${MAX_ACTIVE_JOBS} broadcasts in progress. Wait for one to finish.`});
      res.status(202).json(progress(jobs.get(key(owner,id))));
    }catch{res.status(503).json({error:'Could not store broadcast'});}
  });
  router.get('/:id',(req,res)=>{
    const job=jobs.get(key(req.userId,req.params.id.toLowerCase()));
    if(!job)return res.status(404).json({error:'Broadcast not found'});
    res.json(progress(job));
  });
  return {router,close(){closed=true;clearTimeout(timer);}};
}

export function broadcastSender(waha,session,headers,sent){
  return async(job,number,body)=>{
    const response=await fetch(waha+'/api/'+kinds.get(job.kind),{method:'POST',headers:{...headers(),'Content-Type':'application/json'},
      redirect:'error',signal:AbortSignal.timeout(120000),body:JSON.stringify({...body,session,chatId:number})});
    if(!response.ok){
      await response.body?.cancel();
      if(response.status===429){
        const hint=response.headers.get('retry-after')?.trim();
        const deadline=hint && /^\d+$/.test(hint)?Date.now()+Number(hint)*1000:Date.parse(hint);
        const retryAt=Number.isSafeInteger(deadline) && deadline>Date.now()?deadline:Date.now()+900000;
        return {ok:false,error:'WAHA HTTP 429',retryAt};
      }
      return {ok:false,error:'WAHA HTTP '+response.status};
    }
    const receipt=await response.json().catch(()=>null);
    const id=typeof receipt?.id==='string'?receipt.id:receipt?.id?._serialized;
    if(!validMessageId(id) || receipt?.fromMe===false)return {ok:true};
    try{await sent.record(id,number,job.owner);}catch{console.warn('Broadcast receipt ownership could not be saved');}
    return {ok:true,id,...(Number.isInteger(receipt.ack)?{ack:receipt.ack}:{})};
  };
}
