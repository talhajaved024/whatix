import {createContext,useContext,useEffect,useMemo,useRef,useState} from "react";
import {contactLabelIndex,labelContactKey,labelColor,labelRecipients} from "../business-labels.js";
import {resolveLid} from "../contacts-directory.js";

const Context=createContext(null);

export function LabelHighlights({labels,contacts,children}){
  const [members,setMembers]=useState(new Map());
  const [aliases,setAliases]=useState(new Map());
  const resolved=useRef(new Map());
  useEffect(()=>{
    if(!labels?.length)return;
    const controller=new AbortController(),{signal}=controller;
    async function load(){
      const lids=new Set();
      for(let i=0;i<labels.length;i+=6){
        const batch=await Promise.allSettled(labels.slice(i,i+6).map(async label=>{
          const ids=await labelRecipients(label.id,signal);
          for(const id of ids)if(id.endsWith("@lid")&&!resolved.current.has(id))lids.add(id);
          return [label.id,ids];
        }));
        if(signal.aborted)return;
        const updates=batch.filter(row=>row.status==="fulfilled").map(row=>row.value);
        setMembers(prev=>new Map([...prev,...updates]));
      }
      const ids=[...lids];
      for(let i=0;i<ids.length;i+=6){
        const rows=await Promise.all(ids.slice(i,i+6).map(async id=>[id,await resolveLid(id.split("@")[0],signal)]));
        if(signal.aborted)return;
        for(const [id,number] of rows)if(number)resolved.current.set(id,number);
        setAliases(new Map(resolved.current));
      }
    }
    load().catch(err=>{if(!signal.aborted)console.error("Could not refresh contact label colors",err);});
    return ()=>controller.abort();
  },[labels]);
  const index=useMemo(()=>contactLabelIndex(labels,members,aliases,contacts),[labels,members,aliases,contacts]);
  return <Context.Provider value={index}>{children}</Context.Provider>;
}

export function ContactHighlight({id,alternate,children}){
  const index=useContext(Context);
  const labels=new Map([...(index?.get(labelContactKey(id)) || []),...(index?.get(labelContactKey(alternate)) || [])]);
  if(!labels.size)return children;
  const list=[...labels.values()];
  const colors=[...new Set(list.map(labelColor))];
  const bands=colors.map((color,i)=>color+" "+(100*i/colors.length)+"% "+(100*(i+1)/colors.length)+"%");
  return <mark className="contact-label-highlight" title={list.map(label=>label.name).join(", ")}
    style={{backgroundColor:colors[0],backgroundImage:colors.length>1?"linear-gradient(90deg,"+bands.join(",")+")":undefined}}>
    {children}</mark>;
}
