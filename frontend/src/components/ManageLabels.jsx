import {ContactHighlight} from "./LabelHighlights.jsx";
import {useEffect,useRef,useState} from 'react';
import {addLabelContact,createLabel,previewLabelWorkbook,labelColor,labelPalette} from '../business-labels.js';
import Dropdown from './Dropdown.jsx';
import {parseRecipients} from '../sender.js';
import {keepSession} from '../auth.js';

const statusText={pending:'Pending',saving:'Adding…',added:'Added',already_added:'Already added',failed:'Failed'};

export default function ManageLabels({canCreate,labels,initialId,chats,onRefresh,onClose}){
  const dialog=useRef(null),operation=useRef(null);
  const [page,setPage]=useState('choose'),[name,setName]=useState(''),[color,setColor]=useState(0);
  const [id,setId]=useState(initialId),[created,setCreated]=useState(null);
  const [checked,setChecked]=useState([]),[paste,setPaste]=useState(''),[results,setResults]=useState(null);
  const [source,setSource]=useState('manual'),[project,setProject]=useState('');
  const [file,setFile]=useState(null),[workbook,setWorkbook]=useState(null);
  // Spreadsheets usually hold local numbers (0300 1234567); this code makes them international.
  const [country,setCountry]=useState('92');
  // Re-read the workbook once typing in the country code pauses.
  const previewed=useRef('92');
  useEffect(()=>{
    if(country===previewed.current||!file||results)return;
    const timer=setTimeout(()=>{previewed.current=country;loadPreview(file,country);},400);
    return ()=>clearTimeout(timer);
  },[country]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // The chosen Project Type, exactly as the workbook groups it.
  const preview=workbook?.projects.find(p=>p.name===project)??null;
  if(excel){
    selected.clear();
    for(const number of preview?.numbers || [])selected.set(number,number);
  }
  const review=results??Array.from(selected,([key,contactId])=>({key,contactId,status:'pending'}));
  const failed=review.filter(r=>r.status==='failed');
  const complete=review.filter(r=>['added','already_added','failed'].includes(r.status)).length;

  async function run(action,{preview=false}={}){
    // A newer workbook preview replaces one still loading; anything else waits its turn.
    if(preview&&operation.current?.preview){operation.current.abort();operation.current=null;}
    if(operation.current)return;
    const controller=Object.assign(new AbortController(),{preview});
    operation.current=controller;setBusy(true);setError('');
    try{await action(controller.signal);}
    catch(err){if(!controller.signal.aborted)setError(err.message);}
    finally{if(operation.current===controller)operation.current=null;if(!controller.signal.aborted)setBusy(false);}
  }
  // Reads every Project Type in the workbook. The chosen one is kept when the
  // country code changes; a new file starts from its own list.
  function loadPreview(nextFile,nextCountry=country){
    if(nextFile!==file){setProject('');setWorkbook(null);}
    setFile(nextFile);setError('');
    previewed.current=nextCountry;
    if(nextFile)run(async signal=>{
      const data=await previewLabelWorkbook(nextFile,nextCountry,signal);
      if(signal.aborted)return;
      setWorkbook(data);
      setProject(current=>data.projects.some(p=>p.name===current)?current:data.projects.length===1?data.projects[0].name:'');
    },{preview:true});
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
      // A long import has no clicks or typing; keep the session from timing out meanwhile.
      let renewed=Date.now();
      for(const row of targets){
        if(Date.now()-renewed>90000){renewed=Date.now();keepSession().catch(()=>{});}
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
    <h2 id="label-dialog-title">{{choose:'Manage campaigns',create:'Create campaign',created:'Campaign created',contacts:'Add contacts to campaign'}[page]}</h2>
    {page==='choose'&&<div className="label-choices">{canCreate&&<button type="button" className="um-primary" onClick={()=>setPage('create')}>Create campaign</button>}
      <button type="button" className="admin-refresh" onClick={()=>setPage('contacts')}>Add contacts to campaign</button></div>}
    {canCreate&&page==='create'&&<form className="label-fields" onSubmit={e=>{e.preventDefault();if(name.trim())create();}}>
      <label>Campaign name<input required autoFocus disabled={busy} value={name} onChange={e=>setName(e.target.value)}/></label>
      <fieldset disabled={busy}><legend>Campaign color · {color}</legend><div className="label-palette">{labelPalette.map((hex,index)=>
        <label key={hex} style={{backgroundColor:hex}}><input type="radio" name="label-color" aria-label={'Color '+index} checked={color===index} onChange={()=>setColor(index)}/>
          <span aria-hidden="true">{color===index?'✓':''}</span></label>)}</div></fieldset>
      <button type="submit" className="um-primary" disabled={busy||!name.trim()}>{busy?'Creating…':'Create campaign'}</button>
    </form>}
    {page==='created'&&<><p role="status">Created {created.name}.</p><button type="button" className="um-primary" onClick={()=>setPage('contacts')}>Add contacts to campaign</button></>}
    {page==='contacts'&&<div className="label-fields">
      <label>Campaign<Dropdown label="Campaign" value={id} disabled={!!created||!!results||busy} onChange={setId} placeholder="Choose a campaign"
        searchPlaceholder="Search campaigns" options={options.map(l=>({value:l.id,label:l.name||'Campaign '+l.id,swatch:labelColor(l)}))}/></label>
      {!results&&<label>Add numbers<Dropdown label="Add numbers" value={source} disabled={busy} onChange={value=>{setError('');setSource(value);}}
        options={[{value:'manual',label:'Add manually',description:'Type or paste phone numbers',icon:'contacts'},
          {value:'excel',label:'Import from Excel',description:'Upload a .xlsx workbook',icon:'document'}]}/></label>}
      {!results&&excel&&<>
        <label>Upload Excel workbook (.xlsx)<input type="file" accept=".xlsx" disabled={busy}
          onChange={e=>{const next=e.target.files?.[0];if(next)loadPreview(next);e.target.value='';}}/></label>
        {file&&<small>{file.name}{workbook&&` · ${workbook.projects.length} project type${workbook.projects.length===1?'':'s'} found`}</small>}
        <label>Project Type<Dropdown label="Project type" value={project} disabled={busy||!workbook?.projects.length} onChange={setProject}
          placeholder={!file?'Upload a workbook first':!workbook?'Reading workbook…':workbook.projects.length?'Choose a project type':'No project types in this workbook'}
          searchPlaceholder="Search project types"
          options={(workbook?.projects??[]).map(p=>({value:p.name,label:p.name,
            description:`${p.rows} row${p.rows===1?'':'s'} · ${p.numbers.length} number${p.numbers.length===1?'':'s'}`}))}/></label>
        <label>Country code for local numbers
          <span className="label-country"><span aria-hidden="true">+</span><input inputMode="numeric" value={country} disabled={busy} maxLength={4}
            aria-describedby="label-country-hint" onChange={e=>setCountry(e.target.value.replace(/\D/g,''))}/></span>
          <small id="label-country-hint">Numbers like 0300 1234567, or 3001234567 after Excel drops the 0, become +{country||'…'} 300 1234567. Leave empty to accept only international numbers.</small></label>
        {busy&&!results&&<p role="status">Reading workbook…</p>}
        {preview&&<div className="label-import-summary" role="status">
          <p><strong>{preview.numbers.length}</strong> number{preview.numbers.length===1?'':'s'} from <strong>{preview.rows}</strong> row{preview.rows===1?'':'s'} with project type “{preview.name}”</p>
          <ul>
            {!!preview.converted&&<li className="ok">{preview.converted} local number{preview.converted===1?'':'s'} converted to +{workbook.country}</li>}
            {!!preview.duplicates&&<li>{preview.duplicates} repeated number{preview.duplicates===1?'':'s'} merged</li>}
            {!!preview.skipped&&<li className="warn">{preview.skipped} entr{preview.skipped===1?'y':'ies'} not usable as a phone number{preview.skippedSamples?.length?': '+preview.skippedSamples.map(s=>'“'+s+'”').join(', '):''}</li>}
          </ul>
          {!review.length&&<p>No usable phone numbers in these rows.</p>}
        </div>}
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
        {results&&complete===review.length&&<ImportSummary rows={review}/>}
        <ul className={excel&&!results?"label-number-pills":"label-review"}>{review.map(r=><li key={r.key}><ContactHighlight id={r.contactId} alternate={r.key}>{excel?r.key:r.contactId.includes('@')?r.contactId:'+'+r.contactId}</ContactHighlight>
          {results&&<strong>{statusText[r.status]}</strong>}{r.error&&<small className="um-error">{r.error}</small>}</li>)}</ul></section>}
      {(!results||failed.length>0)&&<button type="button" className="um-primary" disabled={busy||!id||!review.length||(!excel&&!!parsed.invalid.length)} onClick={save}>
        {results?'Retry failed':excel?'Save to campaign':'Add contacts'}</button>}
    </div>}
    {error&&<p className="um-error" role="alert">{error}</p>}
    <div className="idle-actions"><button type="button" className="idle-leave" disabled={busy} onClick={onClose}>{results||page==='created'?'Done':'Cancel'}</button></div>
  </dialog>;
}

// After an import: how many were added, and every failure grouped by reason,
// with the failed numbers ready to copy back into a spreadsheet.
function ImportSummary({rows}){
  const [copied,setCopied]=useState(false);
  const added=rows.filter(r=>r.status==='added').length,already=rows.filter(r=>r.status==='already_added').length;
  const failures=rows.filter(r=>r.status==='failed');
  const reasons=new Map();
  for(const r of failures)reasons.set(r.error||'Unknown error',(reasons.get(r.error||'Unknown error')||0)+1);
  async function copy(){
    try{await navigator.clipboard.writeText(failures.map(r=>r.contactId.includes('@')?r.contactId:'+'+r.contactId).join('\n'));setCopied(true);}
    catch{setCopied(false);}
  }
  return <div className="label-import-summary" role="status">
    <p><strong>{added}</strong> added{already?<> · <strong>{already}</strong> already in the campaign</>:null}{failures.length?<> · <strong>{failures.length}</strong> failed</>:null}</p>
    {failures.length>0&&<><ul>{[...reasons].sort((a,b)=>b[1]-a[1]).map(([reason,count])=><li key={reason} className="warn">{count} × {reason}</li>)}</ul>
      <button type="button" className="admin-refresh" onClick={copy}>{copied?'Copied failed numbers':'Copy failed numbers'}</button></>}
  </div>;
}
