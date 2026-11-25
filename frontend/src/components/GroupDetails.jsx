import React,{useEffect,useRef} from "react";

export default function GroupDetails({title,members,error,onRetry,onClose,memberLabel}) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  },[]);
  return <dialog ref={dialog} className="new-chat-dialog group-details" aria-labelledby="group-details-title"
    onCancel={event => {event.preventDefault();onClose();}}>
    <header><h2 id="group-details-title">{title}</h2>
      <button type="button" aria-label="Close group details" onClick={onClose}>×</button></header>
    {error ? <p role="alert">{error} <button onClick={onRetry}>Retry</button></p> :
      members ? <><h3>{members.length} {members.length === 1 ? "member" : "members"}</h3>
        <ul>{members.map((member,index) => <li key={member.id || index}>
          <span>{memberLabel(member)}</span><small>{member.role}</small>
        </li>)}</ul></> : <p role="status">Loading group members…</p>}
  </dialog>;
}
