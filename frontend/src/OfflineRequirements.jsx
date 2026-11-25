import {useCallback, useEffect, useRef, useState} from 'react';
import {authorizedFetch, checkSession} from './auth.js';
import Icon from './components/Icon.jsx';

const endpoint = '/api/admin/offline-requirements';

function AssignmentEditor({row, read, onSave, onConflict, onCancel}) {
  const dialog = useRef(null);
  const [original] = useState(()=>(row.assignedUsers ?? []).map(user=>user.id));
  const [selected,setSelected] = useState(original);
  const [users,setUsers] = useState(null);
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
      const body = await read(endpoint+'/assignees',{signal,cache:'no-store'});
      if (signal.aborted || !body) return;
      if (!Array.isArray(body.users)) throw new Error('Could not read the assignee list.');
      const eligible = new Set(body.users.map(user=>user.id));
      setSelected(ids=>ids.filter(id=>eligible.has(id)));
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
  const matches = users?.filter(user=>(user.name+' @'+user.username).toLowerCase().includes(needle));
  return <dialog ref={dialog} className="idle-dialog um-dialog an-assign" aria-labelledby="requirement-editor-title"
    onCancel={event=>{event.preventDefault();if (!saving) onCancel();}}>
    <h2 id="requirement-editor-title">Assigned users for {row.name}</h2>
    <p>Requirement #{row.id} · +{row.phone}</p>
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
      {!matches.length && <small role="status">{users.length?'No matching users.':'No eligible users.'}</small>}
      <button type="button" className="admin-refresh" disabled={!selected.length} onClick={()=>setSelected([])}>Clear selection</button>
    </fieldset> : !error && <p role="status">Loading users…</p>}
    <div className="idle-actions">
      <button type="button" className="idle-leave" disabled={saving} onClick={onCancel}>Cancel</button>
      <button type="button" className="um-primary" disabled={!users || saving} onClick={save}>{saving?'Saving…':'Save'}</button>
    </div>
  </dialog>;
}

export default function OfflineRequirements({onForbidden,onOpenChat,sending}) {
  const [dates,setDates] = useState({from:'',to:''});
  const [rows,setRows] = useState([]);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const request = useRef(null);
  const editVersion = useRef(0);
  const lastRange = useRef(null);
  const appliedRange = useRef(null);
  const [editing,setEditing] = useState(null);
  const [notice,setNotice] = useState('');

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
    return response.json();
  },[onForbidden]);

  const load = useCallback(async (range = null, preserveDates = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const {signal} = controller;
    const version = editVersion.current;
    lastRange.current = range;
    setLoading(true);
    setError('');
    try {
      const query = range ? '?' + new URLSearchParams(range) : '';
      const body = await read(endpoint+query,{signal,cache:'no-store'});
      if (signal.aborted || !body) return;
      if (!Array.isArray(body.requirements) || !body.from || !body.to) throw new Error('The server returned an incomplete report.');
      setRows(body.requirements);
      appliedRange.current = {from:body.from,to:body.to};
      if (!preserveDates && version === editVersion.current) setDates(appliedRange.current);
    } catch (err) {
      if (!signal.aborted) setError(err instanceof TypeError ? 'Could not reach the server. Check your connection and retry.' : err.message);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  },[read]);

  useEffect(()=>{
    load();
    return ()=>request.current?.abort();
  },[load]);
  function changeDate(event) {
    const {name,value} = event.target;
    editVersion.current++;
    setDates(previous=>({...previous,[name]:value}));
  }
  function apply(event) {
    event.preventDefault();
    if (dates.from && dates.to && dates.from <= dates.to) load(dates);
  }

  return <section id="panel-offline-requirements" role="tabpanel" aria-labelledby="tab-offline-requirements" className="admin-panel">
    <header className="admin-head">
      <h1>Offline Requirements</h1>
      <form className="um-head-actions requirements-filters" onSubmit={apply}>
        <label className="um-field">From<input type="date" name="from" required value={dates.from} max={dates.to || undefined} onChange={changeDate}/></label>
        <label className="um-field">To<input type="date" name="to" required value={dates.to} min={dates.from || undefined} onChange={changeDate}/></label>
        <button className="um-primary" type="submit">Apply</button>
        <button className="admin-refresh" type="button" onClick={()=>load()}>This month</button>
      </form>
    </header>
    {notice && <p className="admin-msg" role="status">{notice}</p>}
    {loading ? <div className="admin-empty" role="status"><span className="admin-spin" aria-hidden="true"/>Loading requirements…</div>
    : error ? <div className="admin-msg error" role="alert">{error} <button type="button" className="admin-refresh" onClick={()=>load(lastRange.current)}>Retry</button></div>
    : !rows.length ? <div className="admin-empty" role="status"><h2>No offline requirements in this date range</h2></div>
    : <div className="admin-table-wrap"><table className="admin-table">
      <caption className="idle-sr">Offline Requirements</caption>
      <thead><tr>{['ID','Name','Phone','Query','Date Received','Assigned users','Actions'].map(name=><th scope="col" key={name}>{name}</th>)}</tr></thead>
      <tbody>{rows.map(row=><tr key={row.id}>
        <th scope="row">{row.id}</th><td>{row.name}</td><td>
          <button type="button" className="requirement-phone um-mono" disabled={sending}
            aria-label={'Open chat with '+row.name+' at +'+row.phone}
            onClick={()=>onOpenChat(String(row.phone))}><Icon name="chat"/>+{row.phone}</button>
        </td>
        <td className="requirement-query">{row.query}</td><td><time dateTime={row.dateReceived}>{row.dateReceived}</time></td>
        <td>{row.assignedUsers?.length ? row.assignedUsers.map(user=>user.name || user.username).join(', ') : 'Unassigned'}</td>
        <td><button type="button" className="admin-refresh" aria-label={'Update assigned users for requirement '+row.id}
          onClick={()=>{setNotice('');setEditing(row);}}>Update</button></td>
      </tr>)}</tbody>
    </table></div>}
    {editing && <AssignmentEditor key={editing.id} row={editing} read={read} onCancel={()=>setEditing(null)}
      onSave={updated=>{setRows(current=>current.map(row=>row.id===updated.id?updated:row));setEditing(null);}}
      onConflict={()=>{
        setNotice('Assignments changed for requirement #'+editing.id+'. Review the newer assignments and choose Update to edit again.');
        setEditing(null);
        load(appliedRange.current,true);
      }}/>}
  </section>;
}
