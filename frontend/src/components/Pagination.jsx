import {useEffect,useState} from 'react';
import Icon from './Icon.jsx';
import './pagination.css';
// Grids show one server page at a time. Previous sits in the left corner,
// Next in the right, and the range in between.
export const PAGE_SIZE=10;

export default function Pagination({page,pageSize=PAGE_SIZE,total,onPage,disabled=false,noun='rows'}){
 if(!total)return null;
 const pages=Math.max(1,Math.ceil(total/pageSize));
 const from=Math.min(total,(page-1)*pageSize+1),to=Math.min(total,page*pageSize);
 return <nav className="pager" aria-label={'Pages of '+noun}>
  <button type="button" className="pager-btn" disabled={disabled||page<=1} onClick={()=>onPage(page-1)}>
   <Icon name="back" size={16}/><span>Previous</span></button>
  <p className="pager-info" aria-live="polite"><strong>{from}–{to}</strong> of {total} {noun}
   {pages>1&&<span className="pager-page">Page {page} of {pages}</span>}</p>
  <button type="button" className="pager-btn next" disabled={disabled||page>=pages} onClick={()=>onPage(page+1)}>
   <span>Next</span><Icon name="back" size={16}/></button>
 </nav>;
}

// Search text applied once typing pauses, so each keystroke is not a request.
export function useDebounced(value,ms=300){
 const [settled,setSettled]=useState(value);
 useEffect(()=>{const timer=setTimeout(()=>setSettled(value),ms);return ()=>clearTimeout(timer);},[value,ms]);
 return settled;
}

// The query string for one page of a grid.
export const pageQuery=(page,q,extra={})=>new URLSearchParams({...extra,page:String(page),pageSize:String(PAGE_SIZE),...(q?{q}:{})});
