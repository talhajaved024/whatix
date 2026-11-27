import {useCallback,useEffect,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import Icon from './Icon.jsx';
import './dropdown.css';
// The app's select box. Native <select> popups cannot be styled, so this is a
// button + listbox following the ARIA select-only combobox pattern: arrow keys,
// Home/End, type-ahead, Enter/Space to choose, Escape to close.
//
// The menu opens in the browser's top layer (Popover API), so it is never
// clipped by scrolling panels and sits above modal dialogs it belongs to.
// Older browsers get an absolutely positioned menu instead.
//
// options: [{value, label, description?, swatch? (CSS colour), icon?, disabled?}]
// variant: 'field' (forms), 'pill' (toolbars), 'rich' (two-line, icon tile), 'compact'
const topLayer=typeof HTMLElement!=='undefined' && typeof HTMLElement.prototype.showPopover==='function';
const GAP=6,MARGIN=12,MAX_HEIGHT=340;

export default function Dropdown({value,options,onChange,disabled=false,placeholder='Select…',label,id,variant='field',
  icon,searchable,searchPlaceholder='Search…',emptyText='Nothing matches your search',className='',menuMinWidth=220}){
 const uid=useId(),listId=uid+'list',optionId=i=>uid+'o'+i;
 const wrap=useRef(null),trigger=useRef(null),menu=useRef(null),list=useRef(null),search=useRef(null),typed=useRef({text:'',at:0});
 const [open,setOpen]=useState(false);
 const [query,setQuery]=useState('');
 const [active,setActive]=useState(-1);
 const [place,setPlace]=useState(null);
 const selected=options.find(o=>o.value===value);
 const withSearch=searchable??options.length>8;
 const needle=query.trim().toLowerCase();
 const shown=useMemo(()=>needle?options.filter(o=>[o.label,o.description].some(t=>String(t??'').toLowerCase().includes(needle))):options,[options,needle]);

 const position=useCallback(()=>{
  const t=trigger.current,m=menu.current;
  if(!t||!m||!topLayer)return;
  const r=t.getBoundingClientRect(),vh=window.innerHeight,vw=window.innerWidth;
  const below=vh-r.bottom-GAP-MARGIN,above=r.top-GAP-MARGIN;
  const wanted=Math.min(MAX_HEIGHT,m.scrollHeight);
  const up=below<wanted && above>below;
  const width=Math.min(Math.max(r.width,menuMinWidth),vw-2*MARGIN);
  const left=Math.min(Math.max(MARGIN,r.left),vw-MARGIN-width);
  const maxHeight=Math.max(140,Math.min(MAX_HEIGHT,up?above:below));
  setPlace(up?{left,width,maxHeight,bottom:vh-r.top+GAP,up}:{left,width,maxHeight,top:r.bottom+GAP,up});
 },[menuMinWidth]);

 const close=useCallback((refocus=true)=>{
  setOpen(false);
  if(refocus)trigger.current?.focus({preventScroll:true});
 },[]);
 function show(){
  if(disabled)return;
  setQuery('');
  const at=options.findIndex(o=>o.value===value && !o.disabled);
  setActive(at>=0?at:options.findIndex(o=>!o.disabled));
  setOpen(true);
 }
 function choose(option){
  if(!option||option.disabled)return;
  close();
  if(option.value!==value)onChange(option.value);
 }

 useLayoutEffect(()=>{
  const m=menu.current;
  if(!m||!topLayer)return;
  if(open){
   if(!m.matches(':popover-open'))m.showPopover();
   position();
  }else if(m.matches(':popover-open'))m.hidePopover();
 },[open,position]);
 useEffect(()=>{
  if(open)(withSearch?search:list).current?.focus({preventScroll:true});
 },[open,withSearch]);
 // Typing in the search box highlights the first match.
 useEffect(()=>{if(open)setActive(shown.findIndex(o=>!o.disabled));},[needle]); // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{
  if(open && active>=0)list.current?.querySelector('[data-index="'+active+'"]')?.scrollIntoView({block:'nearest'});
 },[open,active]);
 useEffect(()=>{
  if(!open)return;
  const outside=e=>{if(!wrap.current?.contains(e.target))close(false);};
  const scrolled=e=>{if(!menu.current?.contains(e.target))position();};
  document.addEventListener('pointerdown',outside,true);
  window.addEventListener('resize',position);
  window.addEventListener('scroll',scrolled,true);
  return ()=>{
   document.removeEventListener('pointerdown',outside,true);
   window.removeEventListener('resize',position);
   window.removeEventListener('scroll',scrolled,true);
  };
 },[open,close,position]);
 // A disabled control (e.g. while sending) never keeps its menu open.
 useEffect(()=>{if(disabled && open)close(false);},[disabled,open,close]);

 const step=(from,direction)=>{
  for(let i=from+direction;i>=0 && i<shown.length;i+=direction)if(!shown[i].disabled)return i;
  return from;
 };
 function typeAhead(key){
  const now=Date.now(),memory=typed.current;
  memory.text=(now-memory.at>700?'':memory.text)+key.toLowerCase();memory.at=now;
  const start=memory.text.length>1?Math.max(active,0):active+1;
  for(let k=0;k<shown.length;k++){
   const i=(start+k)%shown.length;
   if(!shown[i].disabled && String(shown[i].label).toLowerCase().startsWith(memory.text)){setActive(i);return;}
  }
 }
 function keys(e){
  const inSearch=e.target===search.current;
  switch(e.key){
   case 'ArrowDown':e.preventDefault();setActive(a=>step(a,1));break;
   case 'ArrowUp':e.preventDefault();setActive(a=>step(a,-1));break;
   case 'Home':if(!inSearch){e.preventDefault();setActive(step(-1,1));}break;
   case 'End':if(!inSearch){e.preventDefault();setActive(step(shown.length,-1));}break;
   case 'Enter':e.preventDefault();choose(shown[active]);break;
   case ' ':if(!inSearch){e.preventDefault();choose(shown[active]);}break;
   // Close only this menu, not a dialog it sits in.
   case 'Escape':e.preventDefault();e.stopPropagation();close();break;
   case 'Tab':close(false);break;
   default:if(!inSearch && e.key.length===1 && !e.ctrlKey && !e.metaKey && !e.altKey)typeAhead(e.key);
  }
 }
 const menuStyle=topLayer&&place?{left:place.left,width:place.width,maxHeight:place.maxHeight,
  ...(place.up?{bottom:place.bottom,top:'auto'}:{top:place.top,bottom:'auto'})}:undefined;
 const activeId=open && active>=0 && shown[active]?optionId(active):undefined;
 return <div ref={wrap} className={['dd','dd-'+variant,open&&'open',className].filter(Boolean).join(' ')}>
  <button ref={trigger} id={id} type="button" className="dd-trigger" disabled={disabled}
   aria-haspopup="listbox" aria-expanded={open} aria-controls={open?listId:undefined}
   aria-label={label?label+': '+(selected?.label??placeholder):undefined}
   onClick={()=>open?close():show()}
   onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();show();}}}>
   {icon&&<span className="dd-icon"><Icon name={icon} size={variant==='rich'?18:16}/></span>}
   {selected?.swatch&&<i className="dd-swatch" style={{background:selected.swatch}}/>}
   <span className="dd-value">{selected
    ?<><span className="dd-text">{selected.label}</span>{variant==='rich'&&selected.description&&<small>{selected.description}</small>}</>
    :<span className="dd-placeholder">{placeholder}</span>}</span>
   <span className="dd-chevron"><Icon name="chevron" size={16}/></span>
  </button>
  <div ref={menu} className={['dd-menu',topLayer?'':'inline',place?.up&&'up'].filter(Boolean).join(' ')}
   popover={topLayer?'manual':undefined} hidden={!topLayer&&!open} style={menuStyle} onKeyDown={keys}
   // Inside a <label>, a click on an option would also "click" the label's control (our trigger)
   // once React has closed the menu, reopening it straight away. Cancelling the click's default
   // stops that; the search box keeps its own (clear button).
   onClick={e=>{if(e.target!==search.current)e.preventDefault();}}>
   {withSearch&&<label className="dd-search"><Icon name="search" size={15}/>
    <input ref={search} className="dd-search-input" type="search" value={query} placeholder={searchPlaceholder} aria-label={searchPlaceholder}
     autoComplete="off" spellCheck={false} role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeId}
     onChange={e=>setQuery(e.target.value)}/></label>}
   <ul ref={list} id={listId} role="listbox" tabIndex={-1} aria-label={label} aria-activedescendant={withSearch?undefined:activeId}>
    {shown.map((o,i)=><li key={String(o.value)} id={optionId(i)} data-index={i} role="option" aria-selected={o.value===value}
     aria-disabled={o.disabled||undefined} className={[i===active&&'active',o.value===value&&'selected'].filter(Boolean).join(' ')||undefined}
     onPointerMove={()=>{if(!o.disabled&&i!==active)setActive(i);}} onClick={()=>choose(o)}>
     {o.icon&&<span className="dd-opt-icon"><Icon name={o.icon} size={16}/></span>}
     {o.swatch&&<i className="dd-swatch" style={{background:o.swatch}}/>}
     <span className="dd-opt-text"><span>{o.label}</span>{o.description&&<small>{o.description}</small>}</span>
     <span className="dd-check">{o.value===value&&<Icon name="check" size={16}/>}</span>
    </li>)}
    {!shown.length&&<li className="dd-empty" role="presentation">{emptyText}</li>}
   </ul>
  </div>
 </div>;
}
