import {useEffect,useRef,useState} from "react";
import {authorizedFetch} from "../auth.js";

export default function DeleteChatDialog({id,alias,contact,onClose,onDeleted}){
  const dialog=useRef(null),saving=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{const el=dialog.current;el.showModal();return ()=>el.close();},[]);
  async function remove(){
    if(saving.current)return;
    saving.current=true;setBusy(true);setError("");
    try{
      const response=await authorizedFetch("/api/chats/"+encodeURIComponent(id)+"/from-my-list",{
        method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({alias})
      });
      const result=await response.json();
      if(!response.ok || !result.personalChats)throw new Error(result.error || "Could not remove this chat.");
      onDeleted(result.personalChats);
    }catch(err){setError(err.message);}
    finally{saving.current=false;setBusy(false);}
  }
  return <dialog ref={dialog} className="idle-dialog" aria-labelledby="delete-personal-chat"
    onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
    <h2 id="delete-personal-chat">Delete from my chats?</h2>
    <p>Remove {contact} and its current conversation history from your Whatix view. A new message will bring the chat back.</p>
    <p>Other staff and WhatsApp participants keep their copies.</p>
    {error&&<p role="alert" className="um-error">{error}</p>}
    <div className="idle-actions"><button autoFocus disabled={busy} onClick={onClose}>Cancel</button>
      <button disabled={busy} onClick={remove}>{busy?"Removing…":"Delete from my chats"}</button></div>
  </dialog>;
}
