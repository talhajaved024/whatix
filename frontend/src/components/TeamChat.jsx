// Facebook-style team chat dock, fixed to the bottom right of the window:
// a launcher with the contact list, and docked chat windows beside it.
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import Icon from "./Icon.jsx";
import {GROUP,endsOnClose,initials,isPrivileged,roleLabel} from "../team-chat.js";
import "./team-chat.css";

const clock = at => new Date(at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});

function Avatar({name, online, size}) {
  return <span className={"tc-avatar" + (size ? " tc-avatar-" + size : "")} aria-hidden="true">
    {initials(name)}{online !== undefined && <i className={"tc-dot" + (online ? " is-online" : "")}/>}
  </span>;
}

function Composer({disabled, placeholder, onSend, autoFocus}) {
  const [text, setText] = useState("");
  const field = useRef(null);
  // autoFocus is a counter that changes each time this window is opened or re-opened.
  useEffect(() => { if (autoFocus) field.current?.focus(); }, [autoFocus]);
  // Grow with the text up to a few lines.
  useLayoutEffect(() => {
    const el = field.current; if (!el) return;
    el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 110) + "px";
    el.style.overflowY = el.scrollHeight > 110 ? "auto" : "hidden";
  }, [text]);
  const submit = event => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value); setText("");
  };
  return <form className="tc-composer" onSubmit={submit}>
    <textarea ref={field} rows={1} value={text} maxLength={4000} disabled={disabled} placeholder={placeholder} aria-label={placeholder}
      onChange={e => setText(e.target.value)}
      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e); }}/>
    <button type="submit" className="tc-send" disabled={disabled || !text.trim()} aria-label="Send message"><Icon name="send"/></button>
  </form>;
}

// One tick: sent (recipient offline). Two grey: delivered. Two green: read.
const TICK_LABEL = {sent:"Sent", delivered:"Delivered", read:"Read"};
function Ticks({status}) {
  const label = TICK_LABEL[status];
  if (!label) return null;
  return <span className={"tc-ticks is-" + status} role="img" aria-label={label} title={label}>
    <svg viewBox="0 0 18 11" width="17" height="11" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {status === "sent" ? <path d="m4 5.5 3 3 6-6.5"/> : <><path d="m1 5.5 3 3 6-6.5"/><path d="m7.5 8.2.3.3 6-6.5"/></>}
    </svg>
  </span>;
}
function statusText(item) {
  if (item.status === "sending") return "Sending…";
  if (item.status === "failed") return item.error || "Not sent";
  return "";
}

function Thread({items, contact}) {
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({block:"end"}); }, [items.length]);
  if (!items.length) return <div className="tc-thread tc-thread-empty">
    <Avatar name={contact.name} size="lg"/>
    <strong>{contact.name}</strong>
    <span>{contact.online ? "Say hello." : contact.name + " is offline. They’ll get your message when they sign in."}</span>
  </div>;
  return <div className="tc-thread" role="log" aria-live="polite" aria-label={"Conversation with " + contact.name}>
    {items.map((item, index) => {
      const next = items[index + 1];
      const tail = !next || next.mine !== item.mine || next.at - item.at > 120000;
      const note = item.mine && statusText(item);
      return <div key={item.id} className={"tc-msg" + (item.mine ? " is-mine" : "") + (tail ? " is-tail" : "") + (item.status === "failed" ? " is-failed" : "")}>
        <div className="tc-bubble" title={clock(item.at)}>{item.group && <span className="tc-group-tag">{item.mine ? "Group message" : "Sent to a group"}</span>}{item.text}</div>
        {(tail || item.mine) && <span className="tc-meta">{note || <>{clock(item.at)}{item.mine && <Ticks status={item.status}/>}</>}</span>}
      </div>;
    })}
    <div ref={end}/>
  </div>;
}

function WindowHead({title, subtitle, avatar, minimized, unread, onMinimize, onClose, closeLabel}) {
  return <header className="tc-head">
    <button type="button" className="tc-head-main" onClick={onMinimize} aria-expanded={!minimized} aria-label={(minimized ? "Expand " : "Minimize ") + "chat with " + title}>
      {avatar}
      <span className="tc-head-text"><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
      {minimized && unread > 0 && <span className="tc-badge">{unread > 99 ? "99+" : unread}</span>}
    </button>
    <button type="button" className="tc-icon" onClick={onMinimize} aria-label={minimized ? "Expand" : "Minimize"}><span className="tc-minus" aria-hidden="true"/></button>
    <button type="button" className="tc-icon" onClick={onClose} aria-label={closeLabel || "Close chat with " + title} title={closeLabel}><Icon name="close"/></button>
  </header>;
}

function ChatWindow({chat, contact, minimized, focus}) {
  const items = chat.threads.get(contact.id) || [];
  const unread = chat.unread.get(contact.id)?.count || 0;
  const offline = !contact.online;
  const subtitle = chat.status !== "online" ? "Connecting…" : offline ? "Offline" : "Active now";
  return <section className={"tc-window" + (minimized ? " is-minimized" : "") + (unread ? " has-unread" : "")} aria-label={"Chat with " + contact.name}>
    <WindowHead title={contact.name} subtitle={[roleLabel(contact.role), subtitle].filter(Boolean).join(" · ")} avatar={<Avatar name={contact.name} online={contact.online}/>}
      minimized={minimized} unread={unread} onMinimize={() => chat.minimize(contact.id)} onClose={() => chat.close(contact.id)}
      closeLabel={endsOnClose(chat.me, contact) ? "End chat (removes it for " + contact.name + ")" : undefined}/>
    {!minimized && <>
      <Thread items={items} contact={contact}/>
      {offline && items.length > 0 && <p className="tc-notice">{contact.name} is offline. New messages are delivered when they sign in.</p>}
      <Composer autoFocus={focus} disabled={chat.status !== "online"} placeholder={"Message " + contact.name} onSend={text => chat.send([contact.id], text)}/>
    </>}
  </section>;
}

// Admins and the super user: one message to several regular users.
function GroupWindow({chat, minimized, focus}) {
  const regular = useMemo(() => chat.contacts.filter(c => !isPrivileged(c.role))
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name)), [chat.contacts]);
  const [picked, setPicked] = useState(() => new Set());
  const [query, setQuery] = useState("");
  const shown = regular.filter(c => (c.name + " " + c.username).toLowerCase().includes(query.trim().toLowerCase()));
  const selected = regular.filter(c => picked.has(c.id));
  const toggle = id => setPicked(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const allPicked = shown.length > 0 && shown.every(c => picked.has(c.id));
  const last = chat.groupLog[chat.groupLog.length - 1];
  const name = id => chat.contacts.find(c => c.id === id)?.name || "Unknown user";
  return <section className={"tc-window tc-group" + (minimized ? " is-minimized" : "")} aria-label="Message several users">
    <WindowHead title="Group message" subtitle={selected.length ? selected.length + " selected" : "Choose recipients"}
      avatar={<span className="tc-avatar tc-avatar-group" aria-hidden="true"><Icon name="users"/></span>}
      minimized={minimized} onMinimize={() => chat.minimize(GROUP)} onClose={() => chat.close(GROUP)}/>
    {!minimized && <>
      <div className="tc-pick">
        <div className="tc-pick-bar">
          <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search users" aria-label="Search users"/>
          <button type="button" className="tc-link" disabled={!shown.length} onClick={() => setPicked(previous => {
            const next = new Set(previous);
            for (const c of shown) allPicked ? next.delete(c.id) : next.add(c.id);
            return next;
          })}>{allPicked ? "Clear" : "Select all"}</button>
        </div>
        <ul className="tc-pick-list">
          {shown.map(c => <li key={c.id}>
            <label>
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)}/>
              <Avatar name={c.name} online={c.online}/>
              <span className="tc-pick-name">{c.name}<small>{"@" + c.username + (c.online ? " · Active now" : " · Offline")}</small></span>
            </label>
          </li>)}
          {!shown.length && <li className="tc-empty">{regular.length ? "No users match your search." : "There are no regular users yet."}</li>}
        </ul>
      </div>
      {last && <p className={"tc-result" + (last.status === "failed" ? " is-error" : "")} role="status">
        {last.status === "sending" ? "Sending…" : last.status === "failed" ? last.error :
          [last.delivered.length ? "Delivered to " + last.delivered.length : "",
            last.queued.length ? (last.queued.length > 2 ? last.queued.length + " offline users" : last.queued.map(name).join(", ")) + " will get it when they sign in" : ""].filter(Boolean).join(" · ")}
      </p>}
      <Composer autoFocus={focus} disabled={!selected.length || chat.status !== "online"}
        placeholder={selected.length ? "Message " + selected.length + (selected.length === 1 ? " user" : " users") : "Select users first"}
        onSend={text => chat.send(selected.map(c => c.id), text)}/>
    </>}
  </section>;
}

function ContactList({chat, onPick, onClose}) {
  const [query, setQuery] = useState("");
  const box = useRef(null);
  const {refreshContacts} = chat;
  useEffect(() => { refreshContacts(); }, [refreshContacts]);
  useEffect(() => {
    const escape = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    box.current?.querySelector("input")?.focus();
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  const privileged = isPrivileged(chat.me?.role);
  const sorted = [...chat.contacts]
    .filter(c => (c.name + " " + c.username).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => ((chat.unread.get(b.id)?.at || 0) - (chat.unread.get(a.id)?.at || 0)) || (b.online - a.online) || a.name.localeCompare(b.name));
  const status = chat.status === "online" ? "Connected" : chat.status === "connecting" ? "Connecting…" : "Reconnecting…";
  return <div className="tc-panel" ref={box} role="dialog" aria-label="Team chat">
    <div className="tc-panel-head">
      <strong>Team chat</strong>
      <span className={"tc-conn is-" + chat.status}>{status}</span>
    </div>
    <div className="tc-panel-tools">
      <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={privileged ? "Search users" : "Search admins"} aria-label="Search contacts"/>
      {privileged && <button type="button" className="tc-group-btn" onClick={() => onPick(GROUP)}><Icon name="users"/>Message several users</button>}
    </div>
    {chat.error && <p className="tc-panel-error" role="alert">{chat.error}</p>}
    <ul className="tc-contacts">
      {sorted.map(c => {
        const unread = chat.unread.get(c.id)?.count || 0;
        return <li key={c.id}><button type="button" className={unread ? "has-unread" : ""} onClick={() => onPick(c.id)}>
          <Avatar name={c.name} online={c.online}/>
          <span className="tc-contact-text"><strong>{c.name}</strong><small>{[roleLabel(c.role), c.online ? "Active now" : "Offline"].filter(Boolean).join(" · ")}</small></span>
          {unread > 0 && <span className="tc-badge" aria-label={unread + " unread"}>{unread > 99 ? "99+" : unread}</span>}
        </button></li>;
      })}
      {!sorted.length && <li className="tc-empty">{chat.status !== "online" && !chat.me ? "Connecting to team chat…" : chat.contacts.length ? "No one matches your search." : privileged ? "No other users yet." : "No admins are available."}</li>}
    </ul>
    <p className="tc-panel-foot">Green dot = signed in now. Offline users get your message when they sign in. Chats aren’t saved and are cleared daily at 9:00 PM (PKT).</p>
  </div>;
}

export default function TeamChatDock({chat}) {
  const [listOpen, setListOpen] = useState(false);
  const dock = useRef(null);
  const focusFor = id => chat.focus === id ? chat.focusTick : 0;
  useEffect(() => {
    if (!listOpen) return;
    const outside = e => { if (!dock.current?.querySelector(".tc-launch-wrap")?.contains(e.target)) setListOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [listOpen]);
  const pick = id => { chat.open(id); setListOpen(false); };
  const privileged = isPrivileged(chat.me?.role);
  return <div className="tc-dock" ref={dock}>
    <div className="tc-launch-wrap">
      {listOpen && <ContactList chat={chat} onPick={pick} onClose={() => setListOpen(false)}/>}
      <button type="button" className={"tc-launch" + (chat.unreadTotal ? " has-unread" : "")} aria-expanded={listOpen}
        aria-label={"Team chat" + (chat.unreadTotal ? ", " + chat.unreadTotal + " unread" : "")} onClick={() => setListOpen(v => !v)}>
        <Icon name="chat"/>
        {chat.unreadTotal > 0 && <span className="tc-badge tc-launch-badge" aria-hidden="true">{chat.unreadTotal > 99 ? "99+" : chat.unreadTotal}</span>}
        <i className={"tc-launch-dot is-" + chat.status} aria-hidden="true"/>
      </button>
    </div>
    {chat.windows.map(w => {
      if (w.id === GROUP) return privileged ? <GroupWindow key={GROUP} chat={chat} minimized={w.minimized} focus={focusFor(GROUP)}/> : null;
      const contact = chat.contacts.find(c => c.id === w.id);
      return contact ? <ChatWindow key={w.id} chat={chat} contact={contact} minimized={w.minimized} focus={focusFor(w.id)}/> : null;
    })}
  </div>;
}
