import {ContactHighlight} from "./LabelHighlights.jsx";
import {useEffect,useRef,useState} from 'react';
import {addLabelContact,createLabel,previewLabelWorkbook,labelPalette} from '../business-labels.js';
import {parseRecipients} from '../sender.js';

const projectTypes=['SHP(Single Unit)','Water Bottles','HDHP(Full Share)','Gaza Water Tank Units','Gaza Food'];
const statusText={pending:'Pending',saving:'Adding…',added:'Added',already_added:'Already added',failed:'Failed'};

export default function ManageLabels({canCreate,labels,initialId,chats,onRefresh,onClose}){
  const dialog=useRef(null),operation=useRef(null);
  const [page,setPage]=useState('choose'),[name,setName]=useState(''),[color,setColor]=useState(0);
  const [id,setId]=useState(initialId),[created,setCreated]=useState(null);
  const [checked,setChecked]=useState([]),[paste,setPaste]=useState(''),[results,setResults]=useState(null);
  const [source,setSource]=useState('manual'),[project,setProject]=useState('');
  const [file,setFile]=useState(null),[preview,setPreview]=useState(null);
  const excel=source==='excel';
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    dialog.current.showModal();
    return ()=>operation.current?.abort();
  },[]);
  const options=created&&!labels.some(l=>l.id===created.id)?[...labels,created]:labels;
  const parsed=parseRecipients(paste);
  // Keys are conversation identities (resolved phones where known); values retain the original chat IDs.
  const selected=new Map();
  for(const chat of chats)if(checked.includes(chat.key))selected.set(chat.key,chat.contactId);
  for(const number of parsed.numbers)if(!selected.has(number))selected.set(number,number);
  if(excel){
    selected.clear();
    for(const number of preview?.numbers || [])selected.set(number,number);
  }
  const review=results??Array.from(selected,([key,contactId])=>({key,contactId,status:'pending'}));
  const failed=review.filter(r=>r.status==='failed');
  const complete=review.filter(r=>['added','already_added','failed'].includes(r.status)).length;

  async function run(action){
    if(operation.current)return;
    const controller=new AbortController();
    operation.current=controller;setBusy(true);setError('');
    try{await action(controller.signal);}
    catch(err){if(!controller.signal.aborted)setError(err.message);}
    finally{operation.current=null;if(!controller.signal.aborted)setBusy(false);}
  }
  function loadPreview(nextFile,nextProject){
    setFile(nextFile);setProject(nextProject);setPreview(null);setError('');
    if(nextFile && nextProject)run(async signal=>{
      const data=await previewLabelWorkbook(nextFile,nextProject,signal);
      if(!signal.aborted)setPreview(data);
    });
  }
  function create(){
    run(async signal=>{
      const label=await createLabel(name.trim(),color,signal);
      if(signal.aborted)return;
      setCreated(label);setId(label.id);setPage('created');onRefresh(label.id,label);
    });
  }
  function save(){
    const targets=results?failed:review;
    run(async signal=>{
      const retryKeys=new Set(targets.map(r=>r.key));
      setResults(review.map(r=>retryKeys.has(r.key)?{...r,status:'pending',error:''}:r));
      for(const row of targets){
        if(signal.aborted)return;
        const update=(status,error='')=>setResults(prev=>prev.map(r=>r.key===row.key?{...r,status,error}:r));
        update('saving');
        try{const status=await addLabelContact(id,row.contactId,signal);if(!signal.aborted)update(status);}
        catch(err){if(!signal.aborted)update('failed',err.message);}
      }
      if(!signal.aborted)onRefresh(id);
    });
  }
  return <dialog ref={dialog} className="idle-dialog label-manager" aria-labelledby="label-dialog-title"
    onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
    <h2 id="label-dialog-title">{{choose:'Manage labels',create:'Create label',created:'Label created',contacts:'Add contacts to label'}[page]}</h2>
    {page==='choose'&&<div className="label-choices">{canCreate&&<button type="button" className="um-primary" onClick={()=>setPage('create')}>Create label</button>}
      <button type="button" className="admin-refresh" onClick={()=>setPage('contacts')}>Add contacts to label</button></div>}
    {canCreate&&page==='create'&&<form className="label-fields" onSubmit={e=>{e.preventDefault();if(name.trim())create();}}>
      <label>Label name<input required autoFocus disabled={busy} value={name} onChange={e=>setName(e.target.value)}/></label>
      <fieldset disabled={busy}><legend>Label color · {color}</legend><div className="label-palette">{labelPalette.map((hex,index)=>
        <label key={hex} style={{backgroundColor:hex}}><input type="radio" name="label-color" aria-label={'Color '+index} checked={color===index} onChange={()=>setColor(index)}/>
          <span aria-hidden="true">{color===index?'✓':''}</span></label>)}</div></fieldset>
      <button type="submit" className="um-primary" disabled={busy||!name.trim()}>{busy?'Creating…':'Create label'}</button>
    </form>}
    {page==='created'&&<><p role="status">Created {created.name}.</p><button type="button" className="um-primary" onClick={()=>setPage('contacts')}>Add contacts to label</button></>}
    {page==='contacts'&&<div className="label-fields">
      <label>Label<select value={id} disabled={!!created||!!results||busy} onChange={e=>setId(e.target.value)}>
        <option value="">Choose a label</option>{options.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      {!results&&<label>Add numbers<select value={source} disabled={busy} onChange={e=>{setError('');setSource(e.target.value);}}>
        <option value="manual">Add manually</option><option value="excel">Import from Excel</option></select></label>}
      {!results&&excel&&<>
        <label>Project Type<select value={project} disabled={busy} onChange={e=>loadPreview(file,e.target.value)}>
          <option value="">Choose a project type</option>{projectTypes.map(type=><option key={type}>{type}</option>)}</select></label>
        <label>Upload Excel workbook (.xlsx)<input type="file" accept=".xlsx" disabled={busy||!project}
          onChange={e=>{const next=e.target.files?.[0];if(next)loadPreview(next,project);e.target.value='';}}/></label>
        {file&&<small>{file.name}</small>}
        {busy&&<p role="status">Reading workbook…</p>}
        {preview&&!review.length&&<p role="status">{preview.matchingRows?'No valid international numbers in the matching rows.':'No rows match this project type.'}</p>}
        {!!preview?.skipped&&<p role="status">Skipped empty or invalid contact entries: {preview.skipped}.</p>}
      </>}
      {!results&&!excel&&<>
        {!!chats.length&&<fieldset><legend>Direct chats</legend><div className="label-chats">{chats.map(chat=>
          <label key={chat.key}><input type="checkbox" checked={checked.includes(chat.key)} onChange={e=>setChecked(e.target.checked?[...checked,chat.key]:checked.filter(k=>k!==chat.key))}/>
            <ContactHighlight id={chat.contactId} alternate={chat.key}>{chat.key.includes('@')?chat.key:'+'+chat.key}</ContactHighlight></label>)}</div></fieldset>}
        <label>International phone numbers<textarea value={paste} rows="3" placeholder="+15551234567, +442079460000" onChange={e=>setPaste(e.target.value)}/></label>
        {parsed.invalid.length>0&&<p className="um-error" role="alert">Check the number format: {parsed.invalid.join(', ')}</p>}
      </>}
      {review.length>0&&<section><h3>Selected contacts ({review.length})</h3>
        {results&&<p role="status">{complete} of {review.length} checked</p>}
        <ul className={excel&&!results?"label-number-pills":"label-review"}>{review.map(r=><li key={r.key}><ContactHighlight id={r.contactId} alternate={r.key}>{excel?r.key:r.contactId.includes('@')?r.contactId:'+'+r.contactId}</ContactHighlight>
          {results&&<strong>{statusText[r.status]}</strong>}{r.error&&<small className="um-error">{r.error}</small>}</li>)}</ul></section>}
      {(!results||failed.length>0)&&<button type="button" className="um-primary" disabled={busy||!id||!review.length||(!excel&&!!parsed.invalid.length)} onClick={save}>
        {results?'Retry failed':excel?'Save to label':'Add contacts'}</button>}
    </div>}
    {error&&<p className="um-error" role="alert">{error}</p>}
    <div className="idle-actions"><button type="button" className="idle-leave" disabled={busy} onClick={onClose}>{results||page==='created'?'Done':'Cancel'}</button></div>
  </dialog>;
}
