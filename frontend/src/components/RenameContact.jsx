import {useEffect,useRef,useState} from "react";
import {ALIAS_MAX_LENGTH,renameContact} from "../contact-aliases.js";

// Lets a user give a customer their own name. Only that user sees it; the
// customer's number and WhatsApp name are untouched. An empty name removes it.
const offline=err=>err instanceof TypeError?"Could not reach the server. Check your connection and try again.":err.message;
export default function RenameContact({phone,current="",onClose}){
  const dialog=useRef(null),live=useRef(true);
  const [name,setName]=useState(current);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{live.current=true;dialog.current.showModal();return ()=>{live.current=false;};},[]);
  async function save(next){
    if(busy)return;
    setBusy(true);setError("");
    try{await renameContact(phone,next.trim());if(live.current)onClose();}
    catch(err){if(live.current){setError(offline(err));setBusy(false);}}
  }
  return <dialog ref={dialog} className="idle-dialog um-dialog rename-contact" aria-labelledby="rename-contact-title" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
    <form onSubmit={e=>{e.preventDefault();save(name);}}>
      <h2 id="rename-contact-title">{current?"Rename contact":"Name this contact"}</h2>
      <p className="an-hint">+{phone} · Only you see this name.</p>
      <label className="um-field">Your name for this contact
        <input type="text" value={name} maxLength={ALIAS_MAX_LENGTH} autoFocus disabled={busy} placeholder="e.g. Hassan – website project"
          onChange={e=>setName(e.target.value)}/>
      </label>
      {error&&<p className="idle-error" role="alert">{error}</p>}
      <div className="idle-actions">
        <button type="button" className="idle-leave" disabled={busy} onClick={onClose}>Cancel</button>
        {current&&<button type="button" className="idle-leave" disabled={busy} onClick={()=>save("")}>Remove name</button>}
        <button type="submit" className="um-primary" disabled={busy||name.trim()===current||(!name.trim()&&!current)}>{busy?"Saving…":"Save"}</button>
      </div>
    </form>
  </dialog>;
}
