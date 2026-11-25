import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {authorizedFetch} from './auth.js';

export const deletionPlaceholder='Message deletion requested';
const headers={'Content-Type':'application/json'};
function validState(row){
  return row && ['mine','hidden','revocationRequested'].every(key=>typeof row[key]==='boolean');
}
async function responseError(response,fallback){
  const body=await response.json().catch(()=>null);
  return new Error(body?.error||fallback+' (HTTP '+response.status+').');
}

// This hook lives in the keyed, authenticated workspace. No ownership state is persisted.
export function useMessageDeletion(history,view,panelOpen){
  const ids=useMemo(()=>JSON.stringify([...new Set(history.flatMap(item=>item.sender?[]:
    (item.results??[]).map(r=>r.id).filter(id=>typeof id==='string'&&id)))].sort()),[history]);
  const [states,setStates]=useState(()=>new Map());
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  const refresh=useCallback(()=>setRevision(n=>n+1),[]);
  const mutations=useRef(new Map());
  const checked=useRef(new Set());
  useEffect(()=>{
    const returned=()=>{if(document.visibilityState==='visible')refresh();};
    document.addEventListener('visibilitychange',returned);
    window.addEventListener('focus',returned);
    return ()=>{document.removeEventListener('visibilitychange',returned);window.removeEventListener('focus',returned);};
  },[refresh]);
  useEffect(()=>{checked.current.clear();},[view,panelOpen,revision]);
  useEffect(()=>{
    if(panelOpen)return;
    const controller=new AbortController();
    const versions=new Map(mutations.current);
    async function load(){
      setError('');
      const all=JSON.parse(ids).filter(id=>!checked.current.has(id));
      for(let i=0;i<all.length;i+=100){
        const batch=all.slice(i,i+100);
        const response=await authorizedFetch('/api/messages/deletion-state',{method:'POST',headers,
          body:JSON.stringify({ids:batch}),signal:controller.signal,cache:'no-store'});
        if(!response.ok)throw await responseError(response,'Could not check message deletion state');
        const {messages}=await response.json();
        if(controller.signal.aborted)return;
        const rows=new Map(messages.map(row=>[row.id,row]));
        if(!batch.every(id=>validState(rows.get(id))))throw new Error('Incomplete message deletion state. Please retry.');
        for(const id of batch)checked.current.add(id);
        setStates(previous=>{
          const next=new Map(previous);
          for(const id of batch)if(versions.get(id)===mutations.current.get(id))next.set(id,rows.get(id));
          return next;
        });
      }
    }
    load().catch(err=>{if(!controller.signal.aborted)setError(err.message);});
    return ()=>controller.abort();
  },[ids,view,panelOpen,revision]);
  async function remove(id,scope){
    if(!states.get(id)?.mine)throw new Error('This message is no longer eligible for deletion.');
    const response=await authorizedFetch('/api/messages/'+encodeURIComponent(id),{method:'DELETE',headers,body:JSON.stringify({scope})});
    if(response.status===404){
      mutations.current.set(id,(mutations.current.get(id)??0)+1);
      setStates(previous=>new Map(previous).set(id,{...previous.get(id),mine:false}));
      refresh();
    }
    if(response.status!==200)throw await responseError(response,'Could not delete the message');
    const result=await response.json();
    if(!validState(result)){refresh();throw new Error('Could not confirm the message deletion state.');}
    mutations.current.set(id,(mutations.current.get(id)??0)+1);
    setStates(previous=>new Map(previous).set(id,result));
  }
  return {states,error,refresh,remove};
}

// Keep a broadcast in its original conversation, with distinct receipts for each outcome.
export function visibleCopies(item,states){
  if(item.sender||!item.results?.length)return [item];
  const normal=[],revoked=[],unchecked=[];
  for(const receipt of item.results){
    const state=states.get(receipt.id);
    if(state?.hidden)continue;
    if(receipt.id&&!state)unchecked.push(receipt);
    else if(state?.revocationRequested)revoked.push(receipt);
    else normal.push(receipt);
  }
  const copies=[],pending=Math.max(0,item.total-item.results.length);
  if(normal.length||pending)copies.push({...item,results:normal,total:normal.length+pending});
  if(unchecked.length)copies.push({...item,display:'checking',results:unchecked,total:unchecked.length});
  if(revoked.length)copies.push({...item,display:'revoked',results:revoked,total:revoked.length});
  return copies;
}
