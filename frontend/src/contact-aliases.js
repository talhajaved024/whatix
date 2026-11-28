import {createContext,useCallback,useEffect,useState} from "react";
import {authorizedFetch,onAuthChange} from "./auth.js";

// A regular user's own names for customers (the server's contact-aliases.js):
// private to that user, shown wherever the customer's name appears for them.
// One copy per tab, shared by every view; dropped at sign-out so the next
// person on this browser never sees them.
export const ALIAS_MAX_LENGTH=60;
// Map of phone digits -> name, or null where personal names are not used.
export const AliasContext=createContext(null);

let names=new Map(),loaded=false,loading=null;
const listeners=new Set();
const publish=()=>{for(const listener of [...listeners])listener(names);};
const accept=body=>{names=new Map(Object.entries(body?.aliases||{}));loaded=true;publish();};
onAuthChange(signedIn=>{if(!signedIn){names=new Map();loaded=false;loading=null;publish();}});

function load(){
  return loading??=(async()=>{
    const response=await authorizedFetch("/api/contact-aliases",{cache:"no-store"});
    if(response.ok)accept(await response.json());
  })().catch(()=>{}).finally(()=>{loading=null;});
}

// name: the new name, or "" to go back to the customer's own name.
export async function renameContact(phone,name){
  const response=await authorizedFetch("/api/contact-aliases/"+encodeURIComponent(phone),{method:"PUT",
    headers:{"Content-Type":"application/json"},body:JSON.stringify({name})});
  const body=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(typeof body?.error==="string"?body.error:"Could not save the name (HTTP "+response.status+").");
  accept(body);
}

// The signed-in user's names (a Map) when enabled, else null.
export function useContactAliases(enabled){
  const [current,setCurrent]=useState(names);
  const refresh=useCallback(()=>{if(document.visibilityState==="visible")load();},[]);
  useEffect(()=>{
    if(!enabled)return;
    listeners.add(setCurrent);
    setCurrent(names);
    if(!loaded)load();
    // Renamed on another device or tab: picked up when this one is looked at again.
    window.addEventListener("focus",refresh);
    return ()=>{listeners.delete(setCurrent);window.removeEventListener("focus",refresh);};
  },[enabled,refresh]);
  return enabled?current:null;
}
