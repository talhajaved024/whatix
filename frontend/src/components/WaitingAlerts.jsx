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
// Assignments: what an admin or the super user assigned to this user (a
// customer, one of our WhatsApp numbers, a Whatix AI requirement), kept by the
// server until the user opens or dismisses it. Opening one opens that
// customer's chat (or that number's inbox).
const roles = {super_user:"Super user", admin:"Admin"};
// What a notice is about; the same rule as the server (assignment-notices.js).
export const noticeSubject = notice => [notice.type, notice.session, notice.requirementId ?? notice.phoneNumber ?? ""].join("|");
// Customers assigned in one go (same admin, same WhatsApp number, each within
// two minutes of the next) are one entry: "assigned 30 customers to you". It
// opens to show the numbers, and its Dismiss clears them together.
const GROUP_GAP = 2 * 60 * 1000;
function groupAssignments(notices) {
  const groups = [];
  for (const notice of notices) {
    const group = groups.at(-1), previous = group?.at(-1);
    if (previous && notice.type === "contact.assigned" && previous.type === "contact.assigned" && previous.session === notice.session &&
      previous.assignedBy.username === notice.assignedBy.username && Math.abs(previous.at - notice.at) <= GROUP_GAP) group.push(notice);
    else groups.push([notice]);
  }
  return groups;
}
const By = ({notice}) => <><strong>{notice.assignedBy.name}</strong>{roles[notice.assignedBy.role] && <em className="waiting-role">{roles[notice.assignedBy.role]}</em>}</>;
// The sentence for one notice, as text (screen readers) or with emphasis.
function describe(notice, plain = false) {
  const strong = text => plain ? text : <strong>{text}</strong>;
  const customer = plain ? "+" + notice.phoneNumber : <strong><ContactHighlight id={notice.phoneNumber}>+{notice.phoneNumber}</ContactHighlight></strong>;
  if (notice.type === "number.assigned") return <> assigned WhatsApp number {strong("+" + notice.campaignPhone)} to you.</>;
  if (notice.type === "requirement.assigned") return <> assigned you a requirement: {strong(notice.name || "Customer")} · {customer}.</>;
  return <> assigned {customer} to you.</>;
}
const plainText = notice => notice.assignedBy.name + (notice.type === "number.assigned" ? " assigned WhatsApp number +" + notice.campaignPhone + " to you."
  : notice.type === "requirement.assigned" ? " assigned you a requirement: " + (notice.name || "Customer") + ", +" + notice.phoneNumber + "."
  : " assigned +" + notice.phoneNumber + " to you.");
export default function WaitingAlerts({ alerts, onOpen, onDismiss, chatAlerts = [], onOpenChat, onDismissChat, assignmentAlerts = [], onOpenAssignment, onDismissAssignment }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const box = useRef(null);
  const groups = groupAssignments(assignmentAlerts);
  // Which grouped entries are opened out, by their oldest notice (stable while the group grows).
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = key => setExpanded(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; });
  // A group counts once: 30 customers assigned together are one thing to look at.
  const count = alerts.length + chatAlerts.length + groups.length;
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
  const latestAssignment = assignmentAlerts[0];
  // The newest of the three kinds is what a screen reader hears.
  const announcement = latestAssignment && latestAssignment.at >= Math.max(latest?.since || 0, latestChat?.since || 0)
    ? (groups[0].length > 1 ? latestAssignment.assignedBy.name + " assigned " + groups[0].length + " customers to you." : plainText(latestAssignment))
    : latestChat ? latestChat.name + " sent you a message." : latest ? (latest.phoneNumber || latest.chatId) + " is waiting for your reply." : "";
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
        {groups.map(group => {
          const notice = group[0], key = group.at(-1).id;
          if (group.length === 1) return <li key={notice.id} className="waiting-assignment">
            <button type="button" className="waiting-item" onClick={() => { setOpen(false); onOpenAssignment?.(notice); }}>
              <span><By notice={notice}/>{describe(notice)}</span>
              <time dateTime={new Date(notice.at).toISOString()}>{ago(notice.at, now)}{notice.type !== "number.assigned" && <> · on +{notice.campaignPhone}</>}</time>
            </button>
            <button type="button" className="waiting-dismiss" aria-label={"Dismiss: " + plainText(notice)} onClick={() => onDismissAssignment?.(notice.id)}>
              <Icon name="close" />
            </button>
          </li>;
          const shown = expanded.has(key);
          return <li key={key} className="waiting-assignment waiting-group">
            <div className="waiting-group-head">
              <button type="button" className="waiting-item" aria-expanded={shown} onClick={() => toggle(key)}>
                <span><By notice={notice}/> assigned <strong>{group.length} customers</strong> to you.</span>
                <time dateTime={new Date(notice.at).toISOString()}>{ago(notice.at, now)} · on +{notice.campaignPhone} · {shown ? "Hide numbers" : "Show numbers"}</time>
              </button>
              <button type="button" className="waiting-dismiss" aria-label={"Dismiss all " + group.length + " assignments from " + notice.assignedBy.name} onClick={() => onDismissAssignment?.(group.map(item => item.id))}>
                <Icon name="close" />
              </button>
            </div>
            {shown && <ul className="waiting-group-list">{group.map(item => <li key={item.id}>
              <button type="button" className="waiting-item" onClick={() => { setOpen(false); onOpenAssignment?.(item); }}>
                <span><strong><ContactHighlight id={item.phoneNumber}>+{item.phoneNumber}</ContactHighlight></strong></span>
              </button>
              <button type="button" className="waiting-dismiss" aria-label={"Dismiss assignment of +" + item.phoneNumber} onClick={() => onDismissAssignment?.(item.id)}>
                <Icon name="close" />
              </button>
            </li>)}</ul>}
          </li>;
        })}
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
