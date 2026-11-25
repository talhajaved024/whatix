import {useEffect,useRef,useState} from 'react';

export function MessageMenu({receipts,onDelete,preview=false}){
  const menu=useRef(null);
  const [open,setOpen]=useState(false);
  useEffect(()=>{
    if(!open)return;
    const outside=e=>{if(!menu.current?.contains(e.target))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    return ()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  return <div className="message-menu" ref={menu} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setOpen(false);}}
    onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);menu.current.firstElementChild.focus();}}}>
    <button type="button" className="message-chevron" aria-label={preview?'Previewed message options':'Message options'} aria-expanded={open}
      onClick={()=>setOpen(!open)}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="m3 6 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2"/></svg></button>
    {open&&<button type="button" className="message-delete" onClick={()=>{setOpen(false);onDelete(receipts);}}>{preview?'Delete previewed message':'Delete message'}</button>}
  </div>;
}

export function DeleteMessageDialog({receipts,states,remove,onClose,broadcast}){
  const dialog=useRef(null);
  const [id,setId]=useState(receipts[0].id),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const state=states.get(id);
  const enabled=state?.mine&&!state.hidden&&!busy;
  useEffect(()=>{dialog.current.showModal();},[]);
  async function confirm(scope){
    if(!enabled)return;
    setBusy(true);setError('');
    try{await remove(id,scope);onClose();}
    catch(err){setError(err.message);setBusy(false);}
  }
  return <dialog ref={dialog} className="idle-dialog message-dialog" aria-labelledby="delete-message-title"
    onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
    <h2 id="delete-message-title">Delete message?</h2>
    <p>Delete for me hides this message only for your signed-in account. Delete for everyone requests its removal from the recipient’s chat.</p>
    {broadcast&&<label>Recipient<select value={id} disabled={busy} onChange={e=>{setId(e.target.value);setError('');}}>
      {receipts.map(r=><option key={r.id} value={r.id}>{r.number}</option>)}</select></label>}
    {error&&<p className="idle-error" role="alert">{error}</p>}
    <div className="idle-actions"><button type="button" className="idle-leave" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="admin-end" disabled={!enabled} onClick={()=>confirm('me')}>Delete for me</button>
      <button type="button" className="um-danger" disabled={!enabled||state.revocationRequested} onClick={()=>confirm('everyone')}>Delete for everyone</button></div>
  </dialog>;
}
