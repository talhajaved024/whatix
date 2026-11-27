import {useEffect,useRef,useState} from 'react';
import Icon from './components/Icon.jsx';
import './mobile-tabs.css';
// Phone-only bottom navigation, icons only (CSS hides it above 680px, where
// the header tabs are used). Each button keeps its name for screen readers. The first tabs get their own button; the rest sit behind
// "More", a sheet that slides up above the bar.
// tabs: [id, label, icon]
export default function MobileTabs({tabs,primary,tab,onChange}){
 const [more,setMore]=useState(false);
 const sheet=useRef(null),toggle=useRef(null);
 const main=primary.map(id=>tabs.find(t=>t[0]===id)).filter(Boolean);
 const extra=tabs.filter(([id])=>!primary.includes(id));
 const inMore=extra.some(([id])=>id===tab);
 useEffect(()=>{
  if(!more)return;
  const list=sheet.current;
  (list?.querySelector('[aria-current=page]')||list?.querySelector('button'))?.focus();
  const key=e=>{if(e.key==='Escape'){e.preventDefault();setMore(false);toggle.current?.focus();}};
  window.addEventListener('keydown',key);
  return ()=>window.removeEventListener('keydown',key);
 },[more]);
 function go(id){setMore(false);if(id!==tab)onChange(id);}
 return <div className="mobile-tabs-host">
  {more&&<div className="mt-scrim" aria-hidden="true" onClick={()=>setMore(false)}/>}
  {more&&<div ref={sheet} id="mt-more" className="mt-sheet" role="dialog" aria-label="More sections">
   <span className="mt-grip" aria-hidden="true"/>
   {extra.map(([id,label,icon])=><button key={id} type="button" aria-current={tab===id?'page':undefined} onClick={()=>go(id)}>
    <span className="mt-sheet-icon"><Icon name={icon} size={20}/></span><span>{label}</span>
    {tab===id&&<span className="mt-sheet-check"><Icon name="check" size={18}/></span>}</button>)}
  </div>}
  <nav className="mobile-tabs" aria-label="Workspace sections">
   {main.map(([id,label,icon])=><button key={id} type="button" aria-current={tab===id&&!more?'page':undefined} aria-label={label} onClick={()=>go(id)}>
    <span className="mt-icon"><Icon name={icon} size={23}/></span></button>)}
   <button ref={toggle} type="button" className={inMore&&!more?'mt-in-more':undefined} aria-current={inMore&&!more?'page':undefined}
    aria-expanded={more} aria-controls="mt-more" aria-label={inMore?'More sections, '+extra.find(([id])=>id===tab)[1]+' open':'More sections'}
    onClick={()=>setMore(m=>!m)}>
    <span className="mt-icon"><Icon name={more?'close':'grid'} size={23}/></span></button>
  </nav>
 </div>;
}
