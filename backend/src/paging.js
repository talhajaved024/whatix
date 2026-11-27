// Paged lists: every data grid asks for ?page=N&pageSize=M (and optionally
// ?q= to search). A request without `page` or `pageSize` gets the full list,
// so pickers and older callers keep working unchanged.
export const PAGE_SIZE=10;
export const MAX_PAGE_SIZE=100;

// null: no paging asked for. false: invalid. Otherwise {page, pageSize, offset}.
export function pageRequest(query){
  if(query.page===undefined && query.pageSize===undefined)return null;
  const page=query.page===undefined?1:Number(query.page);
  const pageSize=query.pageSize===undefined?PAGE_SIZE:Number(query.pageSize);
  if(!/^\d+$/.test(String(query.page??1)) || !/^\d+$/.test(String(query.pageSize??PAGE_SIZE)))return false;
  if(!Number.isSafeInteger(page) || page<1 || !Number.isSafeInteger(pageSize) || pageSize<1 || pageSize>MAX_PAGE_SIZE)return false;
  return {page,pageSize,offset:(page-1)*pageSize};
}
// Lower-cased search text; '' when absent, false when unusable.
export function searchTerm(value){
  if(value===undefined || value==='')return '';
  if(typeof value!=='string' || value.length>100)return false;
  return value.trim().toLowerCase();
}
// A page past the end comes back empty with the real total, so the grid can
// step back to the last page after rows were removed elsewhere.
export const pageMeta=(paging,total)=>({page:paging.page,pageSize:paging.pageSize,total,pages:Math.max(1,Math.ceil(total/paging.pageSize))});
export const badPage=res=>res.status(400).json({error:'Use page (1 or more), pageSize (1-'+MAX_PAGE_SIZE+') and a search of at most 100 characters'});
