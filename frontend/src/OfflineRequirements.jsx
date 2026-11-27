import {useCallback, useEffect, useRef, useState} from 'react';
import {authorizedFetch, checkSession} from './auth.js';
import Icon from './components/Icon.jsx';
import Pagination,{pageQuery,useDebounced} from './components/Pagination.jsx';
import Dropdown from './components/Dropdown.jsx';
import {loadCampaigns} from './campaign-directory.js';

const endpoint = '/api/admin/offline-requirements';

function AssignmentEditor({row, read, onSave, onConflict, onCancel}) {
  const dialog = useRef(null);
  const [original] = useState(()=>(row.assignedUsers ?? []).map(user=>user.id));
  const [selected,setSelected] = useState(original);
  const [users,setUsers] = useState(null);
  const [phone,setPhone] = useState('');
  const [search,setSearch] = useState('');
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [saving,setSaving] = useState(false);
  const [revision,setRevision] = useState(0);
  const saveRequest = useRef(null);

  useEffect(()=>{
    dialog.current.showModal();
    return ()=>saveRequest.current?.abort();
  },[]);
  useEffect(()=>{
    const controller = new AbortController();
    const {signal} = controller;
    async function lookup() {
      setUsers(null);
      setError('');
      const body = await read(endpoint+'/assignees?requirement='+encodeURIComponent(row.id),{signal,cache:'no-store'});
      if (signal.aborted || !body) return;
      if (!Array.isArray(body.users)) throw new Error('Could not read the assignee list.');
      const eligible = new Set(body.users.map(user=>user.id));
      setSelected(ids=>ids.filter(id=>eligible.has(id)));
      setPhone(typeof body.phone === 'string' ? body.phone : '');
      setUsers(body.users);
    }
    lookup().catch(err=>{if (!signal.aborted) setError(err.message);});
    return ()=>controller.abort();
  },[read,revision]);

  async function save() {
    if (saveRequest.current || !users) return;
    const controller = new AbortController();
    saveRequest.current = controller;
    setSaving(true);
    setError('');
    try {
      const body = await read(endpoint+'/'+row.id+'/assignees',{
        method:'PATCH', signal:controller.signal, headers:{'Content-Type':'application/json'},
        body:JSON.stringify({userIds:selected,expectedUserIds:original})
      });
      if (!controller.signal.aborted && body) {
        if (body.requirement?.id !== row.id) throw new Error('The server did not confirm the updated requirement.');
        onSave(body.requirement);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err.status === 409) onConflict();
      else if (err.status === 422) {
        setNotice('An account is no longer eligible. Review the refreshed selection before saving.');
        setUsers(null);
        setRevision(value=>value+1);
      } else setError(err.message);
    } finally {
      saveRequest.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }
  const needle = search.trim().toLowerCase();
  // Assigned earlier but without the campaign: they cannot see the chat.
  const dropped = users ? (row.assignedUsers ?? []).filter(user=>!users.some(eligible=>eligible.id===user.id)) : [];
  const matches = users?.filter(user=>(user.name+' @'+user.username).toLowerCase().includes(needle));
  return <dialog ref={dialog} className="idle-dialog um-dialog an-assign" aria-labelledby="requirement-editor-title"
    onCancel={event=>{event.preventDefault();if (!saving) onCancel();}}>
    <h2 id="requirement-editor-title">Assigned users for {row.name}</h2>
    <p>Requirement #{row.id} · +{row.phone}</p>
    {users && <p className="req-assign-hint">Only users holding the campaign of the number that received this requirement{phone ? ' (+'+phone+')' : ''} are listed: they are the ones who can open this customer's chat.</p>}
    {users && dropped.length > 0 && <p className="req-assign-warn" role="status">Assigned without this campaign, so the chat is hidden from them: {dropped.map(user=>user.name || user.username).join(', ')}. Saving removes them from this requirement.</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <div role="alert" className="idle-error">{error}
      {!users && <button type="button" className="admin-refresh" onClick={()=>setRevision(value=>value+1)}>Retry</button>}
    </div>}
    {users ? <fieldset className="an-contacts" disabled={saving}>
      <legend>Assigned users · {selected.length} selected</legend>
      <label className="um-field">Search users<input type="search" value={search} onChange={event=>setSearch(event.target.value)}/></label>
      <ul className="an-list">{matches.map(user=><li key={user.id}><label>
        <input type="checkbox" value={user.id} checked={selected.includes(user.id)} onChange={event=>{
          const checked=event.target.checked;
          setSelected(ids=>checked ? [...ids,user.id] : ids.filter(id=>id!==user.id));
        }}/>
        <span className="um-who"><strong>{user.name}</strong><small>@{user.username}</small></span>
      </label></li>)}</ul>
      {!matches.length && <small role="status">{users.length?'No matching users.':'No user holds this number\'s campaign yet. Assign it on the Assign WA Num tab first.'}</small>}
      <button type="button" className="admin-refresh" disabled={!selected.length} onClick={()=>setSelected([])}>Clear selection</button>
    </fieldset> : !error && <p role="status">Loading users…</p>}
    <div className="idle-actions">
      <button type="button" className="idle-leave" disabled={saving} onClick={onCancel}>Cancel</button>
      <button type="button" className="um-primary" disabled={!users || saving} onClick={save}>{saving?'Saving…':'Save'}</button>
    </div>
  </dialog>;
}

const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now());
// Same rules as the server: every field is required.
function requirementErrors(f) {
  const e = {}, digits = f.phone.replace(/[\s()-]/g,'').replace(/^\+/,'');
  if (!f.name.trim()) e.name = 'Enter the customer name.'; else if (f.name.trim().length > 128) e.name = 'Use 128 characters or fewer.';
  if (!digits) e.phone = 'Enter the phone number with country code.';
  else if (!/^\d+$/.test(digits)) e.phone = 'Use digits only.';
  else if (/^0/.test(digits)) e.phone = 'Include the country code, without a leading 0.';
  else if (digits.length < 7 || digits.length > 15) e.phone = 'Use 7 to 15 digits with country code.';
  if (!f.query.trim()) e.query = 'Enter the requirement.'; else if (f.query.length > 4000) e.query = 'Use 4000 characters or fewer.';
  if (!f.receivedSession) e.receivedSession = 'Choose which of our numbers received it.';
  if (!f.dateReceived) e.dateReceived = 'Choose the date received.'; else if (f.dateReceived > today()) e.dateReceived = 'The date cannot be in the future.';
  return {errors:e, phone:digits ? Number(digits) : null};
}

// Add (row === null) or edit a requirement's details.
function RequirementForm({row, read, onSaved, onCancel}) {
  const dialog = useRef(null);
  const [form,setForm] = useState(()=>row ? {name:row.name, phone:String(row.phone), query:row.query, dateReceived:row.dateReceived, receivedSession:row.receivedBy?.session ?? ''}
    : {name:'', phone:'', query:'', dateReceived:today(), receivedSession:''});
  // Our connected WhatsApp numbers ("Received by"); the main one first.
  const [numbers,setNumbers] = useState(null);
  useEffect(()=>{
    const controller = new AbortController();
    loadCampaigns(controller.signal).then(({campaigns,defaultSession})=>{
      if (controller.signal.aborted) return;
      const options = campaigns.map(c=>({value:c.name, label:'+'+c.phone, description:c.name+(c.name===defaultSession?' · main number':''), icon:'phone'}));
      // An existing requirement whose number is offline now keeps it as a choice.
      if (row?.receivedBy && !options.some(o=>o.value===row.receivedBy.session))
        options.push({value:row.receivedBy.session, label:row.receivedBy.phone ? '+'+row.receivedBy.phone : row.receivedBy.session, description:row.receivedBy.session+' · not connected now', icon:'phone'});
      setNumbers(options);
      if (!row) setForm(f=>f.receivedSession ? f : {...f, receivedSession:(campaigns.find(c=>c.name===defaultSession) ?? campaigns[0])?.name ?? ''});
    }).catch(()=>{ if (!controller.signal.aborted) setNumbers([]); });
    return ()=>controller.abort();
  },[row]);
  const [errors,setErrors] = useState({});
  const [error,setError] = useState('');
  const [saving,setSaving] = useState(false);
  const saveRequest = useRef(null);
  useEffect(()=>{dialog.current.showModal();return ()=>saveRequest.current?.abort();},[]);
  const edit = (key,value) => {setForm(f=>({...f,[key]:value}));setErrors(e=>e[key]?{...e,[key]:''}:e);setError('');};
  async function save(event) {
    event.preventDefault();
    if (saving) return;
    const {errors:found,phone} = requirementErrors(form);
    setErrors(found);
    const first = Object.keys(found).find(key=>found[key]);
    if (first) { document.getElementById('req-'+first)?.focus(); return; }
    const controller = new AbortController();
    saveRequest.current = controller;
    setSaving(true);setError('');
    try {
      const body = await read(endpoint+(row ? '/'+row.id : ''),{method:row?'PATCH':'POST',signal:controller.signal,
        headers:{'Content-Type':'application/json'},body:JSON.stringify({name:form.name.trim(),phone,query:form.query.trim(),dateReceived:form.dateReceived,receivedSession:form.receivedSession})});
      if (controller.signal.aborted || !body) return;
      if (!body.requirement?.id) throw new Error('The server did not confirm the saved requirement.');
      onSaved(body.requirement);
    } catch (err) {
      if (!controller.signal.aborted) setError(err.status === 404 ? 'This requirement no longer exists.' : err.message);
    } finally {
      saveRequest.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }
  const field = (key,label,input) => <label className="um-field" htmlFor={'req-'+key}><span>{label} <small>required</small></span>
    {input({id:'req-'+key, value:form[key], disabled:saving, 'aria-required':true, 'aria-invalid':!!errors[key]||undefined,
      'aria-describedby':errors[key]?'req-'+key+'-error':undefined, onChange:event=>edit(key,event.target.value)})}
    {errors[key] && <small id={'req-'+key+'-error'} className="um-error">{errors[key]}</small>}</label>;
  return <dialog ref={dialog} className="idle-dialog um-dialog req-dialog" aria-labelledby="req-form-title"
    onCancel={event=>{event.preventDefault();if (!saving) onCancel();}}>
    <h2 id="req-form-title">{row ? 'Edit requirement #'+row.id : 'Add requirement'}</h2>
    <p>All fields are required.</p>
    <form className="req-form" onSubmit={save} noValidate>
      {field('name','Customer name',props=><input {...props} autoComplete="off" maxLength={128}/>)}
      {field('phone','Client phone',props=><input {...props} inputMode="tel" autoComplete="off" maxLength={20} placeholder="923001234567"/>)}
      <div className="um-field"><span>Received by <small>required · which of our numbers got it</small></span>
        <Dropdown id="req-receivedSession" variant="field" icon="phone" label="Received by" value={form.receivedSession} disabled={saving || !numbers?.length}
          placeholder={numbers ? 'No connected numbers' : 'Loading numbers…'} searchPlaceholder="Search numbers" menuMinWidth={260}
          options={numbers ?? []} onChange={value=>edit('receivedSession',value)}/>
        {errors.receivedSession && <small id="req-receivedSession-error" className="um-error">{errors.receivedSession}</small>}</div>
      {field('dateReceived','Date received',props=><input {...props} type="date" max={today()}/>)}
      {field('query','Requirement',props=><textarea {...props} rows={4} maxLength={4000}/>)}
      {error && <div role="alert" className="idle-error">{error}</div>}
      <div className="idle-actions">
        <button type="button" className="idle-leave" disabled={saving} onClick={onCancel}>Cancel</button>
        <button type="submit" className="um-primary" disabled={saving}>{saving ? 'Saving…' : row ? 'Save changes' : 'Add requirement'}</button>
      </div>
    </form>
  </dialog>;
}

function DeleteRequirement({row, read, onDeleted, onCancel}) {
  const dialog = useRef(null);
  const [error,setError] = useState('');
  const [deleting,setDeleting] = useState(false);
  const request = useRef(null);
  useEffect(()=>{dialog.current.showModal();return ()=>request.current?.abort();},[]);
  async function remove() {
    if (deleting) return;
    const controller = new AbortController();
    request.current = controller;
    setDeleting(true);setError('');
    try {
      const body = await read(endpoint+'/'+row.id,{method:'DELETE',signal:controller.signal});
      if (!controller.signal.aborted && body) onDeleted(row);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err.status === 404) onDeleted(row); else setError(err.message);
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setDeleting(false);
    }
  }
  return <dialog ref={dialog} className="idle-dialog um-dialog" aria-labelledby="req-delete-title" aria-describedby="req-delete-desc"
    onCancel={event=>{event.preventDefault();if (!deleting) onCancel();}}>
    <h2 id="req-delete-title">Delete requirement #{row.id}?</h2>
    <p id="req-delete-desc">{row.name} · +{row.phone}. This permanently removes the requirement, and assigned users stop seeing this customer through it.</p>
    {error && <div role="alert" className="idle-error">{error}</div>}
    <div className="idle-actions">
      <button type="button" className="idle-leave" autoFocus disabled={deleting} onClick={onCancel}>Cancel</button>
      <button type="button" className="um-danger" disabled={deleting} onClick={remove}>{deleting ? 'Deleting…' : 'Delete'}</button>
    </div>
  </dialog>;
}

export default function OfflineRequirements({onForbidden,onOpenChat,sending}) {
  const [dates,setDates] = useState({from:'',to:''});
  const [rows,setRows] = useState(null);
  const [fetching,setFetching] = useState(true);
  const [error,setError] = useState('');
  const request = useRef(null);
  const editVersion = useRef(0);
  const appliedRange = useRef(null);
  const shownView = useRef('');
  const [editing,setEditing] = useState(null);
  const [form,setForm] = useState(null);       // 'new' or the row being edited
  const [removing,setRemoving] = useState(null);
  const [notice,setNotice] = useState('');
  // The range on the server (null: this month), the page and the search are what
  // is shown; changing any of them fetches that one page.
  const [applied,setApplied] = useState({range:null,preserveDates:false,nonce:0});
  const [page,setPage] = useState(1);
  const [search,setSearch] = useState('');
  const query = useDebounced(search.trim().toLowerCase());
  const [total,setTotal] = useState(0);

  const read = useCallback(async (url,options) => {
    const response = await authorizedFetch(url,options);
    if (options.signal.aborted) return;
    if (response.status === 403) { onForbidden(); return; }
    if (response.status === 401) {
      await checkSession();
      throw new Error('Could not access requirements with this session. Please retry.');
    }
    if (!response.ok) {
      const body = await response.json().catch(()=>null);
      throw Object.assign(new Error(body?.error || 'Requirements request failed (HTTP '+response.status+').'),{status:response.status});
    }
    if (response.status === 204) return {};
    return response.json();
  },[onForbidden]);

  useEffect(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const {signal} = controller;
    const version = editVersion.current, {range,preserveDates} = applied;
    const view = JSON.stringify([range,page,query]);
    if (view !== shownView.current) setFetching(true);
    setError('');
    (async () => {
      try {
        const body = await read(endpoint+'?'+pageQuery(page,query,range ?? {}),{signal,cache:'no-store'});
        if (signal.aborted || !body) return;
        if (!Array.isArray(body.requirements) || !body.from || !body.to) throw new Error('The server returned an incomplete report.');
        if (body.total > 0 && body.page > body.pages) { setPage(body.pages); return; }
        shownView.current = view;
        setRows(body.requirements);
        setTotal(body.total ?? body.requirements.length);
        appliedRange.current = {from:body.from,to:body.to};
        if (!preserveDates && version === editVersion.current) setDates(appliedRange.current);
      } catch (err) {
        if (!signal.aborted) setError(err instanceof TypeError ? 'Could not reach the server. Check your connection and retry.' : err.message);
      } finally {
        if (!signal.aborted) setFetching(false);
      }
    })();
    return () => controller.abort();
  },[read,applied,page,query]);
  const show = (range,preserveDates=false) => { setPage(1); setApplied(a=>({range,preserveDates,nonce:a.nonce+1})); };
  const retry = () => setApplied(a=>({...a,nonce:a.nonce+1}));
  function changeDate(event) {
    const {name,value} = event.target;
    editVersion.current++;
    setDates(previous=>({...previous,[name]:value}));
  }
  function apply(event) {
    event.preventDefault();
    if (dates.from && dates.to && dates.from <= dates.to) show(dates);
  }

  return <section id="panel-offline-requirements" role="tabpanel" aria-labelledby="tab-offline-requirements" className="admin-panel">
    <header className="admin-head">
      <h1>Whatix AI</h1>
      <form className="um-head-actions requirements-filters" onSubmit={apply}>
        <label className="um-field">From<input type="date" name="from" required value={dates.from} max={dates.to || undefined} onChange={changeDate}/></label>
        <label className="um-field">To<input type="date" name="to" required value={dates.to} min={dates.from || undefined} onChange={changeDate}/></label>
        <button className="um-primary" type="submit">Apply</button>
        <button className="admin-refresh" type="button" onClick={()=>show(null)}>This month</button>
      </form>
    </header>
    <div className="cp-toolbar">
      <label className="cp-search"><Icon name="search" size={16}/><span className="idle-sr">Search requirements</span>
        <input type="search" value={search} placeholder="Search client, phone, query or our number" onChange={event=>{setSearch(event.target.value);setPage(1);}}/></label>
      <button type="button" className="um-primary req-add" onClick={()=>{setNotice('');setForm('new');}}><Icon name="plus" size={16}/>Add requirement</button>
    </div>
    {notice && <p className="admin-msg" role="status">{notice}</p>}
    {rows === null && fetching ? <div className="admin-empty" role="status"><span className="admin-spin" aria-hidden="true"/>Loading requirements…</div>
    : error ? <div className="admin-msg error" role="alert">{error} <button type="button" className="admin-refresh" onClick={retry}>Retry</button></div>
    : !rows?.length ? <div className="admin-empty" role="status"><h2>{query ? 'No requirements match your search' : 'No requirements in this date range'}</h2></div>
    : <><div className={'admin-table-wrap'+(fetching?' grid-loading':'')} aria-busy={fetching}><table className="admin-table">
      <caption className="idle-sr">Whatix AI requirements</caption>
      <thead><tr>{['ID','Name','Client Phone','Received by','Query','Date Received','Assigned users','Actions'].map(name=><th scope="col" key={name}>{name}</th>)}</tr></thead>
      <tbody>{rows.map(row=><tr key={row.id}>
        <th scope="row" data-label="ID">{row.id}</th><td data-label="Name">{row.name}</td><td data-label="Phone">
          <button type="button" className="requirement-phone um-mono" disabled={sending}
            aria-label={'Open chat with '+row.name+' at +'+row.phone+(row.receivedBy && !row.receivedBy.main ? ' in the +'+row.receivedBy.phone+' inbox' : '')}
            onClick={()=>onOpenChat(String(row.phone),row.receivedBy)}><Icon name="chat"/>+{row.phone}</button>
        </td>
        <td data-label="Received by"><span className="req-received">
          <strong className="um-mono">{row.receivedBy?.phone ? '+'+row.receivedBy.phone : '—'}</strong>
          <small>{row.receivedBy?.session}{row.receivedBy?.main ? ' · main' : ''}</small></span></td>
        <td data-label="Query" className="requirement-query">{row.query}</td><td data-label="Date received"><time dateTime={row.dateReceived}>{row.dateReceived}</time></td>
        <td data-label="Assigned users">{row.assignedUsers?.length ? row.assignedUsers.map(user=>user.name || user.username).join(', ') : 'Unassigned'}</td>
        <td data-label="Actions"><span className="row-actions">
          <button type="button" className="row-icon" title="Edit requirement" aria-label={'Edit requirement '+row.id}
            onClick={()=>{setNotice('');setForm(row);}}><Icon name="edit" size={17}/></button>
          <button type="button" className="row-icon" title="Assign users" aria-label={'Assign users to requirement '+row.id}
            onClick={()=>{setNotice('');setEditing(row);}}><Icon name="users" size={17}/></button>
          <button type="button" className="row-icon danger" title="Delete requirement" aria-label={'Delete requirement '+row.id}
            onClick={()=>{setNotice('');setRemoving(row);}}><Icon name="trash" size={17}/></button>
        </span></td>
      </tr>)}</tbody>
    </table></div>
    <Pagination page={page} total={total} onPage={setPage} disabled={fetching} noun="requirements"/></>}
    {editing && <AssignmentEditor key={editing.id} row={editing} read={read} onCancel={()=>setEditing(null)}
      onSave={updated=>{setRows(current=>current.map(row=>row.id===updated.id?updated:row));setEditing(null);}}
      onConflict={()=>{
        setNotice('Assignments changed for requirement #'+editing.id+'. Review the newer assignments and choose Update to edit again.');
        setEditing(null);
        setApplied(a=>({range:appliedRange.current,preserveDates:true,nonce:a.nonce+1}));
      }}/>}
    {form && <RequirementForm key={form==='new'?'new':form.id} row={form==='new'?null:form} read={read} onCancel={()=>setForm(null)}
      onSaved={saved=>{
        setNotice((form==='new'?'Added requirement #':'Saved requirement #')+saved.id+'.');
        setRows(current=>current?.map(row=>row.id===saved.id?saved:row) ?? current);
        setForm(null);
        // Re-read the page: a new or re-dated requirement may belong elsewhere in the list.
        setApplied(a=>({range:appliedRange.current,preserveDates:true,nonce:a.nonce+1}));
      }}/>}
    {removing && <DeleteRequirement key={removing.id} row={removing} read={read} onCancel={()=>setRemoving(null)}
      onDeleted={row=>{
        setNotice('Deleted requirement #'+row.id+'.');
        setRows(current=>current?.filter(item=>item.id!==row.id) ?? current);
        setRemoving(null);
        setApplied(a=>({range:appliedRange.current,preserveDates:true,nonce:a.nonce+1}));
      }}/>}
  </section>;
}
