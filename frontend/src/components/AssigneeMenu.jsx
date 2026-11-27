import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import Initials from './Initials.jsx';
import Icon from './Icon.jsx';

// Admins, in the chat list: a button at the end of every customer's row. It
// shows who handles that customer in the open WhatsApp number (initials), or
// a "not assigned" icon. It opens a list of the users who hold this number;
// picking one assigns the customer to that user, or moves it to them if
// someone else had it (the others lose it). The list renders into <body> so
// the scrolling chat list never clips it.
export default function AssigneeMenu({number,customer,assigned,users,onPick,disabled=false}){
  const chip=useRef(null),list=useRef(null);
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const [place,setPlace]=useState(null);
  const byName=new Map(users.map(user=>[user.username,user]));
  const first=byName.get(assigned[0]);
  const firstName=first?.name||assigned[0];
  const names=assigned.map(username=>byName.get(username)?.name||username);
  const summary=names.length>1?names.slice(0,-1).join(', ')+' and '+names.at(-1):names[0];
  const unassigned=!assigned.length;
  // Holders first in the list; anyone assigned but no longer holding the number is still shown.
  const options=[...users,...assigned.filter(username=>!byName.has(username)).map(username=>({username,name:username,gone:true}))];

  function close(focusChip=true){setOpen(false);setError('');if(focusChip)chip.current?.focus();}
  useLayoutEffect(()=>{
    if(!open)return;
    function position(){
      const rect=chip.current?.getBoundingClientRect();
      if(!rect)return;
      const width=Math.min(280,window.innerWidth-16);
      const left=Math.max(8,Math.min(rect.right-width,window.innerWidth-width-8));
      const below=window.innerHeight-rect.bottom-8,above=rect.top-8;
      const up=below<240 && above>below;
      setPlace({left,width,top:up?undefined:rect.bottom+6,bottom:up?window.innerHeight-rect.top+6:undefined,maxHeight:Math.max(160,Math.min(360,up?above:below))});
    }
    position();
    window.addEventListener('resize',position);
    return ()=>window.removeEventListener('resize',position);
  },[open]);
  useEffect(()=>{
    if(!open)return;
    const outside=event=>{if(!list.current?.contains(event.target) && !chip.current?.contains(event.target))close(false);};
    // Scrolling the chat list moves the chip away from the open list.
    const scrolled=event=>{if(!list.current?.contains(event.target))close(false);};
    document.addEventListener('pointerdown',outside);
    document.addEventListener('scroll',scrolled,true);
    return ()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('scroll',scrolled,true);};
  },[open]);

  // Once the list is on screen, focus the current assignee (or the first user).
  const shown=open && !!place;
  useEffect(()=>{if(shown)(list.current?.querySelector('[aria-checked=true]:not(:disabled)')??list.current?.querySelector('button:not(:disabled)'))?.focus();},[shown]);
  async function pick(username){
    if(busy)return;
    if(assigned.length===1 && assigned[0]===username){close();return;}
    setBusy(username);setError('');
    try{await onPick(number,username);setBusy('');close();}
    catch(err){setBusy('');setError(err.message||'The customer could not be moved.');}
  }
  function keys(event){
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();
    const items=[...list.current.querySelectorAll('button[role=menuitemradio]:not(:disabled)')];
    const at=items.indexOf(document.activeElement);
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:(at+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[next]?.focus();
  }

  return <>
    <button type="button" ref={chip} className={'assignee-chip'+(unassigned?' none':'')} disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      title={unassigned?'Not assigned. Click to assign this customer to a user.':'Assigned to '+summary+'. Click to change.'}
      aria-label={unassigned?customer+' is not assigned. Assign to a user':'Assigned to '+summary+'. Change who handles '+customer}
      onClick={()=>open?close():setOpen(true)}>
      {unassigned ? <span className="assignee-none" aria-hidden="true"><Icon name="userPlus" size={13}/></span> : <Initials name={firstName} size={22}/>}
      {assigned.length>1 && <span className="assignee-more">+{assigned.length-1}</span>}
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16"><path d="m3 6 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2"/></svg>
    </button>
    {open && place && createPortal(
      <div ref={list} className="assignee-menu" role="menu" aria-label={'Who handles '+customer} onKeyDown={keys}
        style={{left:place.left,width:place.width,top:place.top,bottom:place.bottom,maxHeight:place.maxHeight}}>
        <div className="assignee-head"><strong>{unassigned?'Assign to a user':'Assigned user'}</strong>
          <small>{customer} · {unassigned?'not assigned yet. Pick who handles this customer':'picking someone moves this customer to them only'}</small></div>
        <div className="assignee-options">
          {options.map(user=>{
            const on=assigned.includes(user.username);
            return <button key={user.username} type="button" role="menuitemradio" aria-checked={on}
              className={'assignee-option'+(on?' on':'')} disabled={!!busy || user.gone}
              onClick={()=>pick(user.username)}>
              <Initials name={user.name} size={28}/>
              <span className="assignee-who"><strong>{user.name}</strong><small>@{user.username}{user.gone?' · no longer holds this number':''}</small></span>
              {busy===user.username ? <span className="assignee-state">{unassigned?'Assigning…':'Moving…'}</span>
                : on ? <Icon name="check" size={16}/> : null}
            </button>;
          })}
          {!options.length && <p className="assignee-empty">No user holds this WhatsApp number yet. Assign it to someone on the Assign WA Num tab first.</p>}
        </div>
        {error && <p className="assignee-error" role="alert">{error}</p>}
      </div>,document.body)}
  </>;
}
