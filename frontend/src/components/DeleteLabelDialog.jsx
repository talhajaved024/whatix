import {useEffect,useRef,useState} from "react";
import {authorizedFetch} from "../auth.js";

const choices=[
  ["label","Delete only the campaign","Keep the chats and messages."],
  ["history","Delete campaign and Whatix history","Clear this campaign’s saved conversation across Whatix browsers. Keep the individual WhatsApp chats."],
  ["chats","Delete campaign and WhatsApp chats","Delete every associated chat from the connected WhatsApp account, including chats in other campaigns. This affects everyone using that account."]
];

export default function DeleteLabelDialog({id,name,onClose,onDeleted,onChange}){
  const dialog=useRef(null),running=useRef(false);
  const [scope,setScope]=useState("label"),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [members,setMembers]=useState(null),[revision,refresh]=useState(0);
  const path="/api/business-labels/"+encodeURIComponent(id);
  useEffect(()=>{const el=dialog.current;el.showModal();return ()=>el.close();},[]);
  useEffect(()=>{
    if(scope!=="chats")return;
    const controller=new AbortController();
    (async()=>{
      const response=await authorizedFetch(path+"/deletion-preview",{signal:controller.signal});
      const body=await response.json();
      if(!response.ok||!Array.isArray(body.chats))throw new Error(body.error||"Could not load the campaign’s members.");
      if(!controller.signal.aborted)setMembers(body.chats);
    })().catch(err=>{if(!controller.signal.aborted)setError(err.message);});
    return ()=>controller.abort();
  },[scope,path,revision]);
  async function remove(){
    if(running.current)return;
    running.current=true;setBusy(true);setError("");
    try{
      const response=await authorizedFetch(path,{method:"DELETE",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({scope,expectedChats:scope==="chats"?members:undefined})});
      const body=await response.json();
      if(!response.ok)throw new Error(body.error||"Deletion failed.");
      onDeleted();
    }catch(err){
      setError(err.message);onChange();
      if(scope==="chats"){setMembers(null);refresh(n=>n+1);}
    }finally{running.current=false;setBusy(false);}
  }
  return <dialog ref={dialog} className="idle-dialog label-manager label-delete-dialog" aria-labelledby="delete-label-title"
    onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
    <h2 id="delete-label-title">Delete “{name}”?</h2>
    <fieldset disabled={busy}><legend>Choose what to delete</legend>{choices.map(([key,title,detail])=>
      <label key={key}><input type="radio" name="delete-scope" checked={scope===key} onChange={()=>{setScope(key);setMembers(null);setError("");}}/>
        <span><strong>{title}</strong><small>{detail}</small></span></label>)}</fieldset>
    {scope==="chats"&&<p role="status">{members===null?"Checking campaign members…":members.length+" WhatsApp chat(s) will be deleted."}</p>}
    {error&&<p role="alert" className="um-error">{error} {scope==="chats"&&members===null&&<button onClick={()=>refresh(n=>n+1)}>Refresh membership</button>}</p>}
    <div className="idle-actions"><button autoFocus disabled={busy} onClick={onClose}>Cancel</button>
      <button disabled={busy||(scope==="chats"&&members===null)} onClick={remove}>{busy?"Deleting…":choices.find(c=>c[0]===scope)[1]}</button></div>
  </dialog>;
}
