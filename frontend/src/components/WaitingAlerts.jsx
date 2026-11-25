import {ContactHighlight} from "./LabelHighlights.jsx";
import { useEffect, useRef, useState } from "react";
import Icon from "./Icon.jsx";

function ago(since, now) {
  const minutes = Math.max(0, Math.round((now - since) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.round(minutes / 60);
  return hours + (hours === 1 ? " hour ago" : " hours ago");
}

// Header bell: clients who received a holding reply and are still waiting.
// The backend removes an entry for everyone once a staff member opens or
// answers that chat; Dismiss only hides it in this browser.
// Team chat: unread messages from app users show above the waiting clients as
// "<name> sent you a message." Opening one opens that chat window.
export default function WaitingAlerts({ alerts, onOpen, onDismiss, chatAlerts = [], onOpenChat, onDismissChat }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const box = useRef(null);
  const count = alerts.length + chatAlerts.length;
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30000);
    const outside = event => { if (!box.current?.contains(event.target)) setOpen(false); };
    const escape = event => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      clearInterval(tick);
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const latest = alerts[0];
  const latestChat = chatAlerts[0];
  const announcement = latestChat ? latestChat.name + " sent you a message." : latest ? (latest.phoneNumber || latest.chatId) + " is waiting for your reply." : "";
  return <div className="waiting-alerts" ref={box}>
    <button type="button" className={"waiting-bell" + (count ? " has-alerts" : "")} aria-haspopup="dialog" aria-expanded={open}
      aria-label={count ? "Notifications, " + count + " unread" : "Notifications"}
      onClick={() => setOpen(value => !value)}>
      <Icon name="bell" />
      {count > 0 && <span className="waiting-count" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
    </button>
    <span className="visually-hidden" aria-live="polite">{announcement}</span>
    {open && <div className="waiting-panel" role="dialog" aria-label="Notifications">
      <div className="waiting-head">Notifications</div>
      {count ? <ul>
        {chatAlerts.map(alert => <li key={alert.id} className="waiting-chat">
          <button type="button" className="waiting-item" onClick={() => { setOpen(false); onOpenChat?.(alert); }}>
            <span><strong>{alert.name}</strong> sent you a message.{alert.count > 1 && <em className="waiting-chat-count">{alert.count}</em>}</span>
            <time dateTime={new Date(alert.since).toISOString()}>{ago(alert.since, now)}</time>
          </button>
          <button type="button" className="waiting-dismiss" aria-label={"Mark message from " + alert.name + " as read"} onClick={() => onDismissChat?.(alert)}>
            <Icon name="close" />
          </button>
        </li>)}
        {alerts.map(alert => <li key={alert.id}>
          <button type="button" className="waiting-item" onClick={() => { setOpen(false); onOpen(alert); }}>
            <span><strong><ContactHighlight id={alert.chatId} alternate={alert.phoneNumber}>{alert.phoneNumber || alert.chatId}</ContactHighlight></strong> is waiting for your reply.</span>
            <time dateTime={new Date(alert.since).toISOString()}>{ago(alert.since, now)}</time>
          </button>
          <button type="button" className="waiting-dismiss" aria-label={"Dismiss notification for " + (alert.phoneNumber || alert.chatId)} onClick={() => onDismiss(alert.id)}>
            <Icon name="close" />
          </button>
        </li>)}
      </ul> : <p className="waiting-empty">No new notifications.</p>}
    </div>}
  </div>;
}
