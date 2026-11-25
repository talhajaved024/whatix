import DeleteChatDialog from "./components/DeleteChatDialog.jsx";
import {LabelHighlights,ContactHighlight} from "./components/LabelHighlights.jsx";
import DeleteLabelDialog from "./components/DeleteLabelDialog.jsx";
import {mentionParts,isSelfMention} from "./group-mentions.js";
import ContactName from "./components/ContactName.jsx";
import GroupDetails from "./components/GroupDetails.jsx";
import {loadGroupMembers,messageAuthor,phoneId} from "./group-members.js";
import { authorizedFetch, checkSession, sessionRevoked } from "./auth.js";
import { receivedMedia } from "./media.js";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { broadcastTracker } from "./broadcasts.js";
import AttachmentAlbum, {attachmentGroups} from "./components/AttachmentAlbum.jsx";
import SessionPill from "./components/SessionPill.jsx";
import NewChatDialog from "./components/NewChatDialog.jsx";
import BroadcastProgress from "./components/BroadcastProgress.jsx";
import { SESSION, markAttended, sendFile, sendImage, sendSeen, sendText, sendVideo, sendVoice, uploadSizeError } from "./sender.js";

import { isGroupChat, conversationKey, groupConversations } from "./conversations.js";
import { mergeHistory, useWahaHistory } from "./waha-history.js";
import { businessLabels, labelRecipients } from "./business-labels.js";
import AssignedList from "./components/AssignedList.jsx";
import WaitingAlerts from "./components/WaitingAlerts.jsx";
import TeamChatDock from "./components/TeamChat.jsx";
import { useTeamChat } from "./team-chat.js";
import ManageLabels from "./components/ManageLabels.jsx";
import { applyHistoryChange, chatDeletionTimes, cleanSavedHistory, loadHistory, save, saveViewed } from "./history.js";
import { receipt, mergeAck } from "./receipts.js";
import Constellation from "./Constellation.jsx";

import Icon from "./components/Icon.jsx";
import ContactAvatar from "./components/ContactAvatar.jsx";
import { IncomingCalls, listenForCalls, useIncomingCalls } from "./components/IncomingCalls.jsx";

import {VoiceRecorder,VoicePlayer} from "./components/VoiceNote.jsx";
import {useMessageDeletion,visibleCopies,deletionPlaceholder} from "./message-deletion.js";
import {MessageMenu,DeleteMessageDialog} from "./components/MessageDeletion.jsx";

const formats = {image: ["image/jpeg","image/png","image/webp","image/gif"], video: ["video/mp4"], document: ["application/pdf","text/plain","application/octet-stream"]};
function Preview({kind, src, filename, incoming,recordedDuration}) {
  const viewer = useRef(null);
  const [expanded,setExpanded] = useState(false);
  const [failed,setFailed] = useState(false);
  const [retrying,setRetrying] = useState(false);
  const [fresh,setFresh] = useState(null);
  if (fresh) ({kind,src,filename} = fresh);
  useEffect(() => {
    if (expanded) viewer.current?.showModal();
  }, [expanded]);
  async function retry() {
    setRetrying(true);
    try {
      const chat = encodeURIComponent(incoming.sender??incoming.chatId);
      const id = encodeURIComponent(incoming.id.replace(/^(incoming|remote):/,""));
      const response = await authorizedFetch(`/api/${SESSION}/chats/${chat}/messages/${id}?downloadMedia=true`, {cache:"no-store"});
      if (!response.ok) throw new Error();
      const media = receivedMedia(await response.json());
      if (!media.src) throw new Error();
      setFresh({...media,src:media.src+"?v="+Date.now()});
      setFailed(false);
    } catch { setFailed(true); }
    finally { setRetrying(false); }
  }
  if (incoming && (!src || failed)) return <div className="media-unavailable">
    <small>{filename || kind} · Preview unavailable</small>
    <button type="button" disabled={retrying} onClick={retry}>{retrying ? "Loading…" : "Reload media"}</button>
    {src && <a href={src} download={filename || "attachment"}>Download</a>}
  </div>;
  if (!src) return <small>{filename || "Attachment"} · Media unavailable</small>;
  if (kind === "voice") return <VoicePlayer key={src} src={src} recordedDuration={recordedDuration} onError={()=>setFailed(true)}/>;
  if (kind === "document") return <a className="file-download" href={src} download={filename || "attachment"}><Icon name="document"/>{filename || "Download file"}</a>;
  if (kind === "video") return <video className="chat-player" src={src} aria-label={filename || "Video"} controls playsInline preload="metadata" onError={()=>setFailed(true)}/>;
  return <>
    <button type="button" className="photo-thumb" aria-label="View full image" onClick={()=>setExpanded(true)}>
      <img src={src} alt={filename || "Attached image"} onError={()=>setFailed(true)}/>
    </button>
    {expanded && <dialog className="photo-viewer" aria-label="Full image" ref={viewer} onClose={()=>setExpanded(false)}
      onClick={e=>{if(e.target === e.currentTarget) viewer.current.close();}}>
      <button type="button" autoFocus aria-label="Close image" onClick={()=>viewer.current.close()}><Icon name="close"/></button>
      <img src={src} alt={filename || "Attached image"}/>
    </dialog>}
  </>;
}

const senderLookups = new Map();

function SenderLabel({sender,onResolved,groupMember,mention}) {
  const [resolved, setResolved] = useState(null);
  const lid = /^(\d+)@lid$/.exec(sender)?.[1];
  useEffect(() => {
    if (!lid) return;
    let active = true;
    if (!senderLookups.has(lid)) {
      const lookup = authorizedFetch(`/api/${SESSION}/lids/${lid}`)
        .then(async response => {
          if (!response.ok) return null;
          const {pn} = await response.json();
          return phoneId(pn).split("@")[0] || null;
        })
        .catch(() => null)
        .then(number => {
          if (!number) senderLookups.delete(lid);
          return number;
        });
      senderLookups.set(lid, lookup);
    }
    senderLookups.get(lid).then(number => {
      if (active && number) { setResolved({lid, number}); onResolved?.(sender,number); }
    });
    return () => { active = false; };
  }, [lid,sender,onResolved]);
  if (lid) return resolved?.lid === lid ? "+" + resolved.number : mention ? "Group member" : groupMember ? "Phone unavailable (WhatsApp ID " + lid + ")" : "WhatsApp ID · " + sender;
  return sender.replace(/^(\d+)@(?:c\.us|s\.whatsapp\.net)$/, "+$1");
}

function listenForReadPreference(refresh) {
  window.addEventListener("storage", refresh);
  window.addEventListener("read-preference-changed", refresh);
  return () => {
    window.removeEventListener("storage", refresh);
    window.removeEventListener("read-preference-changed", refresh);
  };
}

function allowsReadReceipts(preferenceKey) {
  try { return Boolean(preferenceKey) && localStorage.getItem(preferenceKey) === "on"; }
  catch { return false; }
}

function MessageReactions({id,peer,history,changes,onChange}) {
  const [open,setOpen] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const details = useRef(null);
  const [filter,setFilter] = useState("");
  const actors = new Map();
  for (const r of [...(history || []),changes.get(id+"|self"),changes.get(id+"|peer")]) {
    if (r && (!actors.has(r.actor) || actors.get(r.actor).at <= r.at)) actors.set(r.actor,r);
  }
  const counts = new Map();
  for (const {text} of actors.values()) if (text) counts.set(text,(counts.get(text)||0)+1);
  const people = ["self","peer"].map(actor=>actors.get(actor)).filter(r=>r?.text);
  const selected = counts.has(filter) ? filter : "";
  async function choose(emoji) {
    setBusy(true); setError("");
    const text = actors.get("self")?.text === emoji ? "" : emoji;
    try {
      const response = await authorizedFetch("/api/reaction",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({messageId:id,reaction:text})});
      if (!response.ok) throw Error("Reaction could not be updated (HTTP "+response.status+").");
      onChange({id,actor:"self",text,at:Date.now()});
      setOpen(false);
      details.current?.close();
    } catch(err) { setError(err.message); } finally { setBusy(false); }
  }
  return <div className="message-reactions">
    {!!people.length && <button type="button" className="reaction-badge" aria-label={"View reactions, "+people.length} aria-haspopup="dialog"
      onClick={()=>{setOpen(false);setFilter("");details.current.showModal();}}>
      {[...counts.keys()].join(" ")}{people.length>1 && <small>{people.length}</small>}
    </button>}
    <button className="reaction-trigger" type="button" title="React to message" aria-label="React to message" aria-expanded={open} onClick={()=>setOpen(!open)}>☺</button>
    {open && <div className="reaction-picker" role="group" aria-label="Choose reaction">{[...new Set(["👍","❤️","😂","😮","😢","🙏",actors.get("self")?.text].filter(Boolean))].map(emoji=>
      <button type="button" key={emoji} disabled={busy} aria-pressed={actors.get("self")?.text===emoji} onClick={()=>choose(emoji)}>{emoji}</button>)}</div>}
    <dialog ref={details} className="reaction-details" aria-label="Message reactions"
      onClick={e=>{if(e.target===details.current)details.current.close();}}>
      <section>
        <header><strong>Message reactions</strong><button type="button" autoFocus aria-label="Close" onClick={()=>details.current.close()}>×</button></header>
        <div className="reaction-filters" role="group" aria-label="Filter reactions">
          <button type="button" aria-pressed={!selected} onClick={()=>setFilter("")}>All {people.length}</button>
          {[...counts].map(([emoji,count])=><button type="button" key={emoji} aria-pressed={selected===emoji} onClick={()=>setFilter(emoji)}>{emoji} {count}</button>)}
        </div>
        {people.filter(r=>!selected || r.text===selected).map(r=>r.actor==="self"
          ? <button className="reaction-person" type="button" key={r.actor} disabled={busy} onClick={()=>choose(r.text)}>
              <span>You<small>Click to remove</small></span><span>{r.text}</span></button>
          : <div className="reaction-person" key={r.actor}><ContactHighlight id={peer}><SenderLabel sender={peer}/></ContactHighlight><span>{r.text}</span></div>)}
        {!people.length && <p>No reactions</p>}
        {error && <small role="alert">{error}</small>}
      </section>
    </dialog>
    {error && <small role="alert">{error}</small>}
  </div>;
}

function IncomingBubble({body,authorLabel,item,children,seen,onSeen,onResolved,preferenceKey,allowRead}) {
  const bubble = useRef(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (seen || !allowRead) return;
    let visible = false;
    let started = false;
    let mounted = true;
    function acknowledge() {
      if (!mounted || started || !visible || !allowsReadReceipts(preferenceKey) || document.visibilityState !== "visible" || !document.hasFocus()) return;
      started = true;
      stopWatching();
      sendSeen(item.sender).then(() => onSeen(item.id)).catch(err => {
        if (mounted) setError(err.message);
      });
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting && entry.intersectionRect.height > 0;
      acknowledge();
    });
    function stopWatching() {
      observer.disconnect();
      document.removeEventListener("visibilitychange", acknowledge);
      window.removeEventListener("focus", acknowledge);
    }
    observer.observe(bubble.current);
    document.addEventListener("visibilitychange", acknowledge);
    window.addEventListener("focus", acknowledge);
    return () => { mounted = false; stopWatching(); };
  }, [item.sender,item.id,attempt,seen,onSeen,preferenceKey,allowRead]);
  return <article className="bubble incoming" ref={bubble}>
    <strong>{authorLabel || <ContactName id={item.sender}><SenderLabel sender={item.sender} onResolved={onResolved}/></ContactName>}</strong>
    {item.kind && <Preview kind={item.kind} src={item.src} filename={item.filename} incoming={item}/>}
    <div className="body-text">{body}</div><div className="meta"><time>{new Date(item.timestamp).toLocaleDateString()} · {item.time}</time></div>
    {children}
    {allowRead && error && <div className="error" role="status">Read receipt failed · {error}
      <button type="button" onClick={() => { setError(""); setAttempt(value => value + 1); }}>Retry read receipt</button>
    </div>}
  </article>;
}

function Ticks({ack}) {
  if (ack === -1) return "Failed";
  if (!ack) return "Pending";
  const label = ack >= 3 ? "Read" : ack === 2 ? "Delivered" : "Sent";
  return <span className={ack >= 3 ? "receipt read" : "receipt"} title={label}>
    <svg viewBox="0 0 22 14" width="21" height="14" aria-hidden="true">
      <path d="m1 8 4 4 11-11" />{ack >= 2 && <path d="m9 10 2 2L21 1" />}
    </svg> {label}
  </span>;
}

function Delivery({item, acknowledgments, active}) {
  const results = item.results.map(result => ({...result,
    ack: mergeAck(result.ack, acknowledgments.get(result.id))}));
  const failed = results.some(r => !r.ok || r.ack === -1);
  const accepted = results.filter(r => r.ok && r.ack !== -1).length;
  const stage = results.reduce((lowest, r) => Math.min(lowest, r.ack ?? 0), 4);
  return <details><summary>{results.length < item.total ? (active ? "Sending…" : "Status unknown") : failed ? "View failures" : <Ticks ack={stage}/>} · {accepted}/{item.total}</summary>
    {results.map(r => <div className="result" key={r.number}><ContactHighlight id={r.number}>+{r.number}</ContactHighlight> · {r.ok ? <Ticks ack={r.ack}/> : r.error}
      {r.request && <details><summary>Request payload</summary><pre>{r.request}</pre></details>}</div>)}
  </details>;
}

// `nav` (super users' tabs) sits in the mast; while `panel` is shown the chat stays mounted but hidden, so drafts,
// history and the live stream (which carries session-ended) survive switching tabs.
// The signed-in user's full name (NAME column), after Log out in the header.
function UserPill({name}) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0,2).map(word => [...word][0].toUpperCase()).join("");
  return <span className="user-pill" title={"Signed in as " + name}><span className="user-pill-initials" aria-hidden="true">{initials}</span><span className="user-pill-name">{name}</span></span>;
}

export default function App({onLogout,nav,panel,role,username,fullName,onShowChat}) {
  const [calls, dispatchCall] = useIncomingCalls();
  // Clients who got a holding reply and are still waiting (newest first).
  const [waiting, setWaiting] = useState([]);
  // Live chat between app users (not WhatsApp); unread messages also show in the bell.
  const teamChat = useTeamChat();
  const [newChatOpen,setNewChatOpen] = useState(false);
  const [message,setMessage] = useState("");
  const [attachments,setAttachments] = useState([]);
  const attachment = attachments[0];
  const [menu,setMenu] = useState(false);
  const [sending,setSending] = useState(false);
  const [reactions,setReactions] = useState(new Map());
  const [history,setHistory] = useState([]);
  const [error,setError] = useState("");
  const [acknowledgments,setAcknowledgments] = useState(new Map());
  const trackedIds = useRef(new Set());
  const early = useRef(null);
  const [receiveStatus, setReceiveStatus] = useState("Connecting");
  const [sessionIdentity,setSessionIdentity] = useState(null);
  useEffect(() => {
    if (role !== "admin" && role !== "super_user") return;
    const controller = new AbortController();
    let timer;
    async function refreshIdentity() {
      try {
        const response = await authorizedFetch("/api/session-identity",{cache:"no-store",signal:controller.signal});
        if (!response.ok) throw new Error("Session identity unavailable");
        const identity = await response.json();
        if (!controller.signal.aborted) setSessionIdentity(identity);
      } catch {
        if (!controller.signal.aborted) setSessionIdentity({session:SESSION,number:null});
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refreshIdentity,60000);
      }
    }
    refreshIdentity();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [role]);
  const sessionName = sessionIdentity?.session || SESSION;
  const sessionLine = sessionIdentity?.number || (sessionIdentity ? "Number unavailable" : "Loading number…");
  const [streamGeneration, reopenStream] = useState(0);
  const [loaded,setLoaded] = useState(false);
  const [storageError,setStorageError] = useState("");
  const [view,setView] = useState("");
  const labelId = view.startsWith("label:") ? view.slice(6) : "";
  const [labelFilter,setLabelFilter] = useState("");
  const filterLabel = labelId || labelFilter;
  const [labels,setLabels] = useState(null);
  const [audience,setAudience] = useState(null);
  const [labelError,setLabelError] = useState("");
  const [revision,refreshLabels] = useState(0);
  const hasAdminAccess=role==="admin" || role==="super_user";
  const [deletingLabel,setDeletingLabel]=useState(false);
  const [personalChats,setPersonalChats]=useState({});
  const [deletingChat,setDeletingChat]=useState(null);
  function rememberPersonalChats(incoming){
    setPersonalChats(prev=>{
      const additions=Object.entries(incoming || {}).filter(([id,at])=>at>(prev[id] || 0));
      return additions.length?{...prev,...Object.fromEntries(additions)}:prev;
    });
  }
  const [historyChanges,setHistoryChanges]=useState(null);
  useEffect(()=>{
    const controller=new AbortController();
    async function sync(){
      try{
        const response=await authorizedFetch("/api/business-labels/history-changes",{signal:controller.signal});
        if(!response.ok)throw new Error();
        const changes=await response.json();
        if(!controller.signal.aborted){
          rememberPersonalChats(changes.personalChats);
          setHistoryChanges(prev=>JSON.stringify(prev)===JSON.stringify(changes)?prev:changes);
        }
      }catch{if(!controller.signal.aborted)setStorageError("Could not sync deleted conversations.");}
    }
    sync();
    const timer=setInterval(sync,60000);
    return ()=>{controller.abort();clearInterval(timer);};
  },[revision]);
  const [managingLabels,setManagingLabels]=useState(false);
  useEffect(() => {
    const refresh = () => refreshLabels(value => value + 1);
    window.addEventListener("focus",refresh);
    return () => window.removeEventListener("focus",refresh);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const {signal} = controller;
    setAudience(null);
    setLabelError("");
    async function load() {
      const list = await businessLabels(signal);
      if (signal.aborted) return;
      setLabels(list);
      if (!filterLabel) return;
      if (!list.some(label => label.id === filterLabel)) throw new Error("This label is no longer available.");
      const members = await labelRecipients(filterLabel,signal);
      if (!signal.aborted) setAudience({labelId:filterLabel,members});
    }
    let loading=false;
    async function refresh(){
      if(loading)return;
      loading=true;
      try{await load();if(!signal.aborted)setLabelError("");}
      catch(err){if(!signal.aborted)setLabelError(err.message);}
      finally{loading=false;}
    }
    refresh();
    const timer=setInterval(()=>{if(document.visibilityState==="visible")refresh();},60000);
    return () => {clearInterval(timer);controller.abort();};
  }, [filterLabel,revision]);
  const [contacts,setContacts] = useState(new Map());
  const [viewed,setViewed] = useState(new Set());
  const seen = useRef(new Map());
  const persist = useCallback((store,key,value) => {
    save(store,key,value).catch(() => setStorageError("History could not be saved in this browser. Check available storage."));
  }, []);
  const broadcasts = useMemo(() => broadcastTracker(username, (item, confirmed) => {
    if (confirmed) {
      for (const result of item.results) if (result.id) trackedIds.current.add(result.id);
      persist("messages",item.id,{...item,src:item.blob ? undefined : item.src});
    }
    setHistory(previous => previous.map(row => row.id === item.id ? item : row));
  }), [username,persist]);
  useEffect(() => () => broadcasts.close(), [broadcasts]);
  const rememberReaction = useCallback(change => {
    const key = change.id + "|" + change.actor;
    persist("reactions",key,change);
    setReactions(prev => prev.get(key)?.at > change.at ? prev : new Map(prev).set(key,change));
  },[persist]);
  const onSeen = useCallback(id => {
    seen.current.set(id,true);
    persist("seen",id,true);
  }, [persist]);
  const onResolved = useCallback((sender,number) => {
    setContacts(prev => prev.get(sender) === number ? prev : new Map(prev).set(sender,number));
    persist("contacts",sender,number);
  }, [persist]);
  useEffect(() => {
    let active = true;
    loadHistory().then(data => {
      if (!active) return;
      const messages = data.messages.filter(item => !item.job || item.owner === username);
      for (const item of messages) {
        if (item.blob) { item.src = URL.createObjectURL(item.blob); blobUrls.current.add(item.src); }
        for (const r of item.results || []) if (r.id) trackedIds.current.add(r.id);
      }
      setHistory(messages);
      for (const item of messages) if (item.job) broadcasts.track(item);
      setReactions(data.reactions);
      setAcknowledgments(data.receipts);
      seen.current = data.seen;
      setViewed(data.viewed);
      setContacts(data.contacts);
    }).catch(() => { if (active) setStorageError("Saved history could not be opened."); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [username,broadcasts]);
  useEffect(() => {
    if (!loaded) return;
    const stream = new EventSource("/api/incoming-text");
    listenForCalls(stream, dispatchCall);
    stream.addEventListener("ready", () => setReceiveStatus("Listening for messages"));
    // Each new connection starts with the full list, so reconnects stay in sync.
    stream.addEventListener("client.waiting.snapshot", event => {
      try { setWaiting(JSON.parse(event.data).sort((a,b) => b.since - a.since)); } catch { /* malformed: keep the current list */ }
    });
    stream.addEventListener("client.waiting", event => {
      try { const alert = JSON.parse(event.data); setWaiting(previous => [alert, ...previous.filter(item => item.id !== alert.id)]); } catch { /* malformed */ }
    });
    stream.addEventListener("client.attended", event => {
      try { const {id} = JSON.parse(event.data); setWaiting(previous => previous.filter(item => item.id !== id)); } catch { /* malformed */ }
    });
    stream.addEventListener("reaction", event => rememberReaction(JSON.parse(event.data)));
    stream.addEventListener("receipt", event => {
      const {id,ack} = JSON.parse(event.data);
      if (trackedIds.current.has(id) || broadcasts.hasActiveJobs()) {
        persist("receipts",id,ack);
        setAcknowledgments(prev => new Map(prev).set(id, mergeAck(prev.get(id), ack)));
      }
      if (early.current) {
        early.current.set(id, mergeAck(early.current.get(id), ack));
      }
    });
    // Admin revoke: the server names the reason on this stream; end locally and in sibling tabs.
    stream.addEventListener("session-ended", event => {
      let reason;
      try { reason = JSON.parse(event.data)?.reason; } catch { /* malformed: ignore */ }
      if (reason === "admin_revoked") { stream.close(); sessionRevoked(); }
    });
    // A drop may mean the session ended while we weren't listening (missed event, sleep): ask /me, at most every 10 s.
    // If the browser gave up on the stream (e.g. a 401 before a token refresh) but the session is fine, open a new one.
    let rechecked = 0;
    stream.onerror = () => {
      dispatchCall({type:"clear"});
      setReceiveStatus("Reconnecting");
      if (Date.now() - rechecked < 10000) return;
      rechecked = Date.now();
      checkSession().then(ok => ok, () => true).then(ok => {
        if (ok && stream.readyState === EventSource.CLOSED) setTimeout(() => reopenStream(n => n + 1), 3000);
      });
    };
    stream.onmessage = event => {
      const item = JSON.parse(event.data);
      const time = new Date(item.timestamp).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
      persist("messages",item.id,{...item,time});
      setHistory(previous => previous.some(existing => existing.id === item.id)
        ? previous : [...previous, {...item, time}]);
    };
    return () => {
      stream.close();
      dispatchCall({type:"clear"});
    };
  }, [loaded,persist,streamGeneration,dispatchCall,broadcasts]);
  const lock = useRef(false);
  const currentBatch = useRef(null);
  const pickers = useRef({});
  const viewport = useRef(null);
  function jumpToLatest() {
    if (viewport.current) viewport.current.scrollTop = 0;
  }
  const blobUrls = useRef(new Set());
  const menuBox = useRef(null);
  const key = labelId ? view : conversationKey(view ? view.split(",") : [], contacts);
  const members = audience?.labelId === labelId ? audience.members : [];
  const labelNumbers = conversationKey(members,contacts);
  const numbers = labelId ? (labelNumbers ? labelNumbers.split(",") : []) : view ? key.split(",") : [];
  const filterLoaded = !!filterLabel && audience?.labelId === filterLabel;
  // Regular users only see chats whose every member is one of their assigned numbers (null until loaded).
  const [assignedNumbers,setAssignedNumbers] = useState(null);
  const restricted = role === "user";
  const visibleToUser = id => !restricted || (!!assignedNumbers && id.split(",").every(member => assignedNumbers.has(member)));
  const labelMembers = new Set(filterLoaded ? conversationKey(audience.members,contacts).split(",").filter(Boolean) : []);
  const selectedId = view && !labelId && !view.includes(",") ? (view.includes("@") ? view : view+"@c.us") : "";
  const remote = useWahaHistory(selectedId,contacts,!restricted);
  const chatTimes=useMemo(()=>chatDeletionTimes(historyChanges,contacts),[historyChanges,contacts]);
  useEffect(()=>{
    if(!loaded || !historyChanges || (!chatTimes.size && !Object.keys(historyChanges.labels).length))return;
    cleanSavedHistory(historyChanges,chatTimes,contacts).catch(()=>setStorageError("Could not clean saved conversation history."));
  },[historyChanges,chatTimes,contacts,loaded]);
  const merged=useMemo(()=>{
    const apply=item=>applyHistoryChange(item,historyChanges,chatTimes,contacts);
    const local=history.map(apply).filter(Boolean);
    return mergeHistory(local,remote.messages).filter(item=>apply(item));
  },[history,remote.messages,historyChanges,chatTimes,contacts]);
  const deletion=useMessageDeletion(merged,view,!!panel);
  const [deleteTarget,setDeleteTarget]=useState(null);
  const personalTimes=useMemo(()=>chatDeletionTimes({chats:personalChats},contacts),[personalChats,contacts]);
  const threads = useMemo(() => {
    const grouped = groupConversations(merged, contacts);
    for(const [id,items] of grouped){
      const cutoff=personalTimes.get(id);
      const current=cutoff?items.filter(item=>item.timestamp>cutoff):items;
      if(cutoff && !current.length)grouped.delete(id);
      else grouped.set(id,current.flatMap(item=>visibleCopies(item,deletion.states)));
    }
    for (const id of remote.directory.keys()) {
      const key = conversationKey([id],contacts);
      if (!grouped.has(key) && !chatTimes.has(key) && !personalTimes.has(key)) grouped.set(key,[]);
    }
    return grouped;
  }, [merged,contacts,remote.directory,deletion.states,chatTimes,personalTimes]);
  const visible = threads.get(key) || [];
  const activeKey = key;
  const groupId = !restricted && isGroupChat(key) ? key : "";
  const [detailsFor,setDetailsFor] = useState("");
  const [groupRevision,refreshGroup] = useState(0);
  const [roster,setRoster] = useState(null);
  useEffect(() => {
    if (!groupId) return;
    const controller = new AbortController();
    loadGroupMembers(groupId,controller.signal).then(members => {
      if (!controller.signal.aborted) setRoster({groupId,members});
    }).catch(err => {
      if (!controller.signal.aborted) setRoster({groupId,error:err.message});
    });
    return () => controller.abort();
  },[groupId,groupRevision]);
  const membersById = useMemo(() => new Map(roster?.members?.flatMap(member =>
    [member.id,member.phone].filter(Boolean).map(id => [id,member]))),[roster]);
  const groupContacts = useMemo(() => {
    const found = new Map();
    if (groupId) for (const item of visible) {
      if (item.sender !== groupId) continue;
      const author = messageAuthor(item);
      for (const id of [author.participant,author.participantLid].filter(Boolean)) {
        const previous = found.get(id);
        found.set(id,{phone:phoneId(author.participant) || previous?.phone,
          name:author.participantName || previous?.name});
      }
    }
    return found;
  },[visible,groupId]);
  function memberLabel(member,mention=false) {
    const contact = groupContacts.get(member.id) || groupContacts.get(member.phone);
    const name = member.name || contact?.name;
    const id = member.phone || contact?.phone || member.id;
    const number = phoneId(id);
    return <ContactName id={member.id || id} alternate={id} known={name} preferName={mention}>{number ? "+" + number.split("@")[0] :
      /^\d+@lid$/.test(id) ? <SenderLabel sender={id} groupMember mention={mention}/> : "Phone unavailable"}</ContactName>;
  }
  const photoIds = useMemo(()=>{
    const ids=new Map();
    function remember(raw){
      if(typeof raw!=='string'||!/^\d+@(lid|c\.us|s\.whatsapp\.net)$/.test(raw))return;
      const key=conversationKey([raw],contacts);
      if(!ids.has(key)||raw.endsWith('@lid'))ids.set(key,raw);
    }
    for(const raw of contacts.keys())remember(raw);
    for(const raw of remote.directory.keys())remember(raw);
    for(const [key,items] of threads){
      if(key.includes(',')||key.startsWith('label:'))continue;
      for(const item of items)remember(item.sender??item.recipients?.[0]);
    }
    return ids;
  },[contacts,remote.directory,threads]);
  const labelChats=useMemo(()=>Array.from(threads.keys())
    .filter(id=>/^\d+(?:@(lid|c\.us|s\.whatsapp\.net))?$/.test(id))
    .map(id=>({key:id,contactId:photoIds.get(id)??id})),[threads,photoIds]);
  const preferenceKey = activeKey ? "dispatch-read-receipts:"+SESSION+":"+activeKey : "";
  const allowRead = useSyncExternalStore(listenForReadPreference, () => allowsReadReceipts(preferenceKey));
  function changeReadPreference(checked) {
    try {
      if (checked) localStorage.setItem(preferenceKey, "on");
      else localStorage.removeItem(preferenceKey);
      window.dispatchEvent(new Event("read-preference-changed"));
    } catch { setStorageError("Could not save the read-receipt setting in this browser."); }
  }
  useEffect(() => {
    const unread = (threads.get(activeKey) || []).filter(item => item.sender && !item.remote && !viewed.has(item.id));
    if (!unread.length) return;
    let handled = false;
    function markViewed() {
      if (handled || document.visibilityState !== "visible" || !document.hasFocus()) return;
      handled = true;
      const ids = unread.map(item => item.id);
      setViewed(previous => new Set([...previous,...ids]));
      saveViewed(ids).catch(() => setStorageError("Unread counts could not be saved in this browser."));
      for (const sender of new Set(unread.map(item => item.sender))) if (!isGroupChat(sender)) markAttended(sender).catch(() => {});
    }
    markViewed();
    window.addEventListener("focus",markViewed);
    document.addEventListener("visibilitychange",markViewed);
    return () => {
      window.removeEventListener("focus",markViewed);
      document.removeEventListener("visibilitychange",markViewed);
    };
  }, [activeKey,threads,viewed]);
  const isBroadcast = Boolean(labelId) || numbers.length > 1;
  const label = id => isGroupChat(id) ? remote.directory.get(id) || id : id.endsWith("@lid") ? id : "+" + id;
  function directLabel(id) {
    const raw = photoIds.get(id) || phoneId(id) || id;
    return <ContactName id={raw} alternate={id} known={remote.directory.get(raw)}>
      {id.endsWith("@lid") ? <SenderLabel sender={id} onResolved={onResolved}/> : label(id)}
    </ContactName>;
  }
  function highlightedRecipients(ids){
    return ids.map((id,i)=><Fragment key={id}>{i>0?", ":""}<ContactHighlight id={id}>{label(id)}</ContactHighlight></Fragment>);
  }
  const title = labelId ? labels?.find(item => item.id === labelId)?.name || "WhatsApp Business label"
    : isBroadcast ? "Broadcast" : numbers.length ? label(numbers[0]) : "New chat";
  const drafts = useRef(new Map());
  function openChat(next) {
    if (lock.current) return;
    if (next === view) {
      jumpToLatest();
      return;
    }
    drafts.current.set(view || key, { message, attachments });
    const draft = drafts.current.get(next);
    setMessage(draft?.message || "");
    setAttachments(draft?.attachments || []);
    setMenu(false);
    setError("");
    setDetailsFor("");
    setView(next);
  }
  const longest = numbers.reduce((a,b) => a.length >= b.length ? a : b, "");
  const file = attachment?.file;
  const url = attachment?.url?.trim();
  const validUrl = !!url && /^https?:\/\//i.test(url) && URL.canParse(url);
  const sizeError = attachments.map(a => a.file && uploadSizeError(a.kind,longest,a.file,message,a.convert)).find(Boolean);
  const ready = loaded && numbers.length && !sizeError && (attachment ? file || validUrl : message.trim());

  useEffect(() => {
    const urls = blobUrls.current;
    return () => { for (const url of urls) URL.revokeObjectURL(url); };
  }, []);
  const chatHidden = Boolean(panel);
  useLayoutEffect(() => {
    if (!chatHidden) jumpToLatest();
  }, [activeKey,chatHidden]);

  useEffect(() => {
    if (!menu) return;
    const outside = e => { if (!menuBox.current?.contains(e.target)) setMenu(false); };
    const escape = e => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("pointerdown",outside);
    document.addEventListener("keydown",escape);
    return () => { document.removeEventListener("pointerdown",outside); document.removeEventListener("keydown",escape); };
  }, [menu]);

  function discard(a) {
    if (a.file && !history.some(item => item.src === a.src)) {
      URL.revokeObjectURL(a.src);
      blobUrls.current.delete(a.src);
    }
  }
  function replaceAttachment(next) {
    attachments.forEach(discard);
    setAttachments(next ? [next] : []);
    setError("");
  }
  function pickFile(e,kind) {
    const files = Array.from(e.target.files);
    e.target.value = "";
    if (!files.length) return;
    const invalid = files.find(f => !f.size || (kind !== "document" && !formats[kind].includes(f.type)));
    if (invalid) return setError("Unsupported or empty file: " + invalid.name);
    const added = files.map(file => {
      const src = URL.createObjectURL(file);
      blobUrls.current.add(src);
      return {kind,file,src,convert:false};
    });
    const keep = attachments.filter(a => a.file && a.kind !== "voice");
    attachments.filter(a => !keep.includes(a)).forEach(discard);
    setAttachments([...keep,...added]);
    setError("");
  }
  function patchAttachment(target,changes) {
    setAttachments(prev => prev.map(a => a === target ? {...a,...changes} : a));
  }
  async function submit(e) {
    e.preventDefault();
    if (!ready || lock.current) return;
    lock.current = true;
    setSending(true);
    setMenu(false);
    setError("");
    try {
      if (labelId) {
        const list = await businessLabels();
        setLabels(list);
        if (!list.some(item => item.id === labelId)) {
          setAudience(null);
          throw new Error("This label is no longer available.");
        }
        const fresh = await labelRecipients(labelId);
        if (conversationKey(fresh,contacts) !== labelNumbers) {
          setAudience({labelId,members:fresh});
          throw new Error("Label membership changed. Review the updated recipients before sending.");
        }
      }
      const newAlbumId = attachments.length > 1 ? crypto.randomUUID() : undefined;
      const queue = attachments.length ? attachments.map(item =>
        newAlbumId && !item.albumId ? {...item,albumId:newAlbumId} : item) : [null];
      for (const [index, attachment] of queue.entries()) {
        const file = attachment?.file, url = attachment?.url?.trim();
        let payload;
        if (file) {
          const encoded = await new Promise((resolve,reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(",")[1]);
            reader.onerror = () => reject(new Error("Could not read the attachment. Please select it again."));
            reader.readAsDataURL(file);
          });
          payload = {filename:file.name,mimetype:file.type || "application/octet-stream",data:encoded};
        } else if (attachment) {
          const ext = attachment.mime.split("/")[1].replace("jpeg","jpg");
          payload = {filename:attachment.name.trim() || attachment.kind+"."+ext,mimetype:attachment.mime,url};
        }
        const id = crypto.randomUUID();
        currentBatch.current = id;
        const recipients=[...new Set(numbers)].filter(number=>!attachment?.sentTo?.includes(number));
        const batch = {id, albumId:attachment?.albumId, recipients:[...numbers], timestamp:Date.now(), blob:file, text:message, kind:attachment?.kind, recordedDuration:attachment?.recordedDuration, filename:payload?.filename, src:attachment?.src || url, time:new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}), total:recipients.length, results:[]};
        const stored = {...batch,src:file ? undefined : batch.src};
        if (labelId) { batch.labelId = labelId; stored.labelId = labelId; }
        if (recipients.length > 10) {
          const kind = attachment?.kind || "text";
          const pendingBody = JSON.stringify({id, recipients, kind, text:message, file:payload,
            convert:kind === "video" || kind === "voice" ? !!attachment.convert : undefined});
          const job = {status:"submitting",total:recipients.length,processed:0,sent:0,unsuccessful:0,nextBatchAt:0};
          const item = {...batch, owner:username, pendingBody, job};
          await save("messages",id,{...item,src:stored.src});
          setHistory(previous => [...previous,item]);
          const status = await broadcasts.track(item,true);
          if (status === "rejected") throw new Error("Broadcast submission failed. Check the message status.");
          setAttachments(queue.slice(index + 1));
          continue;
        }
        persist("messages",id,stored);
        setHistory(prev => [...prev,batch]);
        let accepted = 0;
        for (const number of recipients) {
          let result = {number,ok:true};
          early.current = new Map();
          try {
            let response;
            if (attachment?.kind === "image") response = await sendImage(number,payload,message);
            else if (attachment?.kind === "video") response = await sendVideo(number,payload,message,attachment.convert);
            else if (attachment?.kind === "voice") response = await sendVoice(number,payload,attachment.convert);
            else if (attachment?.kind === "document") response = await sendFile(number,payload,message);
            else response = await sendText(number,message);
            const {id:messageId,ack} = receipt(response);
            if (messageId) trackedIds.current.add(messageId);
            result.id = messageId;
            result.ack = mergeAck(ack, early.current.get(messageId));
            accepted++;
          } catch (err) { result = {number,ok:false,error:err.message,request:err.request}; }
          stored.results = [...stored.results,result];
          persist("messages",id,{...stored});
          early.current = null;
          setHistory(prev => prev.map(item => item.id === id ? {...item,results:[...item.results,result]} : item));
        }
        if (accepted<recipients.length && (attachment || !accepted)) {
          const failed=stored.results.find(result=>!result.ok);
          setError(failed.error);
          if (attachment) setAttachments([{...attachment,sentTo:[...(attachment.sentTo??[]),...stored.results.filter(result=>result.ok).map(result=>result.number)]},...queue.slice(index+1)]);
          return;
        }
        setAttachments(queue.slice(index + 1));
      }
      drafts.current.delete(key); setView(key); setMessage("");
    } catch (err) { setError(err.message); }
    finally { currentBatch.current = null; lock.current = false; setSending(false); }
  }

  function messageBody(item) {
    if (!groupId || !item.text?.includes("@")) return item.text;
    const currentMember = id => roster?.groupId === groupId && membersById.get(id);
    const knownId = digits => {
      const matches = [digits+"@lid",digits+"@c.us"].filter(id => currentMember(id) || groupContacts.has(id) || isSelfMention(id,sessionIdentity));
      return matches.length === 1 ? matches[0] : null;
    };
    return mentionParts(item.text,item.mentions || [],knownId).map((part,index) => {
      if (typeof part === "string") return part;
      const member = currentMember(part.id);
      const phone = member?.phone || groupContacts.get(part.id)?.phone || contacts.get(part.id);
      const self = isSelfMention(part.id,sessionIdentity,phone);
      return <strong key={index}>@{self ? "you" : memberLabel(member || {id:part.id},true)}</strong>;
    });
  }
  function renderMessage(item) {
    const body = messageBody(item);
    const id = item.sender ? item.id.replace(/^incoming:/,"") : item.results?.length === 1 ? item.results[0].id : null;
    const controls = id && !item.display && <MessageReactions id={id} peer={item.sender || item.chatId || String(item.results[0].number).replace(/^(\d+)$/,"$1@c.us")} changes={reactions} onChange={rememberReaction} history={remote.messages.get((item.sender?"incoming:":"remote:")+id)?.reactions}/>;
    const author = groupId && item.sender === groupId ? messageAuthor(item) : null;
    const member = author && roster?.groupId === groupId && membersById.get(author.participant);
    if(item.sender)return <IncomingBubble body={body} authorLabel={author && memberLabel(member || {id:author.participant,name:author.participantName})} key={item.id} item={item} seen={item.alreadyRead || seen.current.has(item.id)} allowRead={allowRead} preferenceKey={preferenceKey} onSeen={onSeen} onResolved={onResolved}>{controls}</IncomingBubble>;
    const eligible=item.results?.filter(r=>deletion.states.get(r.id)?.mine)??[];
    const showJob = item.job && !item.display && item.job.status !== "completed";
    return <Fragment key={JSON.stringify([item.id,item.display])}><article className="bubble">
    {!!eligible.length&&<MessageMenu receipts={eligible} onDelete={receipts=>setDeleteTarget({receipts,broadcast:isBroadcast})}/>}
    {item.display?<div className="message-placeholder">{item.display==='revoked'?deletionPlaceholder:'Checking message…'}</div>:<>
      {item.kind && <Preview kind={item.kind} src={item.src} filename={item.filename} recordedDuration={item.recordedDuration} incoming={item.chatId?item:undefined}/>}
      <div className="body-text">{body}</div></>}
    <div className="meta"><time>{new Date(item.timestamp).toLocaleDateString()} · {item.time}</time>{!showJob && <Delivery active={sending && item.id === currentBatch.current} item={item} acknowledgments={acknowledgments}/>}</div>
    {controls}
  </article>{showJob && <BroadcastProgress item={item}/>}</Fragment>;
  }

  return <LabelHighlights labels={labels} contacts={contacts}>
    <Constellation/>
    <header className="mast"><div className="brand"><img className="logo" src="/whatix.svg" alt=""/>Whatix!</div>{nav}<div className="mast-end">{role !== "user" && <SessionPill name={sessionName} number={sessionLine}/>}<WaitingAlerts alerts={waiting} onDismiss={id => setWaiting(previous => previous.filter(item => item.id !== id))}
      onOpen={alert => { onShowChat?.(); openChat(alert.openKey); markAttended(alert.chatId).catch(() => {}); }}
      chatAlerts={teamChat.alerts} onOpenChat={alert => teamChat.open(alert.contactId)} onDismissChat={alert => teamChat.markRead(alert.contactId)}/>{onLogout && <button type="button" className="auth-logout" onClick={onLogout}>Log out</button>}{(fullName || username) && <UserPill name={fullName || username}/>}</div></header>
    <IncomingCalls calls={calls} dispatch={dispatchCall}/>
    <TeamChatDock chat={teamChat}/>
    <main id="panel-chat" role={nav ? "tabpanel" : undefined} aria-labelledby={nav ? "tab-chat" : undefined} hidden={!!panel} className={view ? "has-chat" : undefined}>
      <aside className="audience">
        <div className="chat-list-heading"><h2>Chats</h2>{hasAdminAccess && <button type="button" disabled={sending} onClick={()=>setNewChatOpen(true)}>New chat</button>}</div>
        <div className="history-picker">
          <label htmlFor="business-label">WhatsApp Business label</label>
          <select id="business-label" value={filterLabel} disabled={sending} onChange={e=>{setLabelFilter(e.target.value);openChat(e.target.value ? "label:"+e.target.value : "");}}>
            <option value="">Choose a label</option>
            {filterLabel && !labels?.some(item=>item.id===filterLabel) && <option value={filterLabel}>Unavailable label</option>}
            {labels?.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <div className="label-picker-actions"><button type="button" className="admin-refresh" disabled={sending} onClick={()=>setManagingLabels(true)}>Manage labels</button>
            <button type="button" className="admin-refresh" disabled={sending} onClick={()=>refreshLabels(value=>value+1)}>Refresh labels</button></div>
          {labelError ? <small className="error" role="alert">{labelError}</small>
            : !labels ? <small role="status">Loading labels…</small>
            : !labels.length ? <small role="status">Create a label in WhatsApp Business, apply it to your chats, then refresh here.</small>
            : filterLabel && <small role="status">{!filterLoaded ? "Loading recipients…" : labelMembers.size + " individual chats"}</small>}
        </div>
        {restricted && <AssignedList onOpen={openChat} onLoaded={setAssignedNumbers} current={key} disabled={sending}/>}
        <nav className="chat-list" aria-label="Saved conversations">
          {[...threads.entries()].filter(([id])=>!id.startsWith("label:") && visibleToUser(id) && (!filterLabel || labelMembers.has(id))).sort((a,b)=>(b[1].at(-1)?.timestamp || 0)-(a[1].at(-1)?.timestamp || 0)).map(([id,items])=>{
            const members = id.split(",");
            const broadcast = members.length > 1;
            const latest = items.at(-1);
            const eligible=latest&&!latest.sender?latest.results?.filter(r=>deletion.states.get(r.id)?.mine):null;
            const unread = items.reduce((count,item) => count + Number(!!item.sender && !item.remote && !viewed.has(item.id)),0);
            return <div key={id} className="chat-list-entry"><button type="button" className="chat-row" aria-current={id===key ? "true" : undefined}
              disabled={sending} onClick={()=>openChat(id)}>
              <ContactAvatar broadcast={broadcast || isGroupChat(id)} contactId={photoIds.get(id)??id}>
                {unread > 0 && <span className="unread-count" aria-label={unread+" unread "+(unread===1 ? "message" : "messages")}>{unread}</span>}</ContactAvatar>
              <span className="row-copy"><strong>{broadcast ? "Broadcast · "+members.length : isGroupChat(id) ? label(id) : directLabel(id)}</strong>
                {broadcast && <span title={members.map(label).join(", ")}>{highlightedRecipients(members)}</span>}
                <small>{latest?.display==='revoked'?deletionPlaceholder:latest?.display==='checking'?'Checking message…':latest ? latest.text || (latest.filename || (latest.kind==="video" ? "Video" : "Photo")) : "Open conversation"}</small></span>
            </button>
            {!!eligible?.length&&!sending&&<MessageMenu key={latest.id} preview receipts={eligible} onDelete={receipts=>setDeleteTarget({receipts,broadcast})}/>}
            </div>;
          })}
        </nav>{remote.error && <div className="error" role="status">{remote.error}<button type="button" onClick={remote.retry}>Retry history sync</button></div>}{storageError && <small className="error" role="alert">{storageError}</small>}
      </aside>
      <section className="window" aria-label="Selected conversation">
        <header className="chat-head"><button type="button" className="chat-back" aria-label="Back to chats" disabled={sending} onClick={()=>openChat("")}><Icon name="back"/></button>{groupId ? <button type="button" className="group-icon" aria-label={"View members of " + title}
          aria-haspopup="dialog" onClick={() => {setDetailsFor(groupId);refreshGroup(n => n+1);}}>
          <ContactAvatar broadcast/></button> : <ContactAvatar broadcast={isBroadcast} contactId={photoIds.get(activeKey)??activeKey}/>}
          {groupId && detailsFor === groupId && <GroupDetails title={title}
            members={roster?.groupId === groupId ? roster.members : null} error={roster?.groupId === groupId && roster.error}
            memberLabel={memberLabel} onRetry={() => refreshGroup(n => n+1)} onClose={() => setDetailsFor("")}/>}
          <div><h1>{activeKey && !isBroadcast && !groupId ? directLabel(activeKey) : title}</h1><small>{isBroadcast && <>{highlightedRecipients(numbers)} · </>}<span role="status">{receiveStatus}</span></small></div>
          {activeKey && <label className="read-preference"><input type="checkbox" checked={allowRead}
            onChange={e=>changeReadPreference(e.target.checked)}/> Allow messages to be read</label>}
        </header>
        {deletion.error&&<div className="error" role="alert">{deletion.error}<button type="button" onClick={deletion.refresh}>Retry message status</button></div>}
        <div className="thread" ref={viewport} role="log" aria-label="Chat messages">
          <div className="thread-content">
          {remote.older && <button type="button" onClick={()=>remote.older()}>Load older messages</button>}
          {!visible.length && <div className="empty"><Icon name="chat" /><h2>Start a conversation</h2><p>{key ? "Type a message or attach a file." : "Select a chat or enter recipients to begin."}</p></div>}
          {attachmentGroups(visible).map(({items})=>items.length===1 ? renderMessage(items[0]) :
            <AttachmentAlbum messageBody={messageBody} key={"album:"+items[0].id} items={items} renderMessage={renderMessage}/>)}
          </div>
        </div>
        <form onSubmit={submit}>
          <div className="attachment-list">{attachments.map((attachment,index) => {
            const {file,src} = attachment;
            return <fieldset key={src || index} disabled={sending} className="attachment"><div className="attach-head"><strong>{file?.name || "Attach a media link"}</strong><button type="button" aria-label="Remove attachment" onClick={()=>{discard(attachment);setAttachments(previous=>previous.filter(a=>a!==attachment));}}><Icon name="close"/></button></div>
            {file ? <Preview kind={attachment.kind} src={attachment.src} filename={file.name} recordedDuration={attachment.recordedDuration}/> : <div className="link-fields">
              <label>Media type<select value={attachment.kind} onChange={e=>patchAttachment(attachment,{kind:e.target.value,mime:formats[e.target.value][0],name:""})}><option value="image">Image</option><option value="video">Video</option><option value="document">Document</option></select></label>
              <label>URL<input type="url" value={attachment.url} onChange={e=>patchAttachment(attachment,{url:e.target.value})} placeholder="https://…" /></label>
              <label>Filename<input value={attachment.name} onChange={e=>patchAttachment(attachment,{name:e.target.value})} placeholder="Optional" /></label>
              <label>Format<select value={attachment.mime} onChange={e=>patchAttachment(attachment,{mime:e.target.value})}>{formats[attachment.kind].map(m=><option key={m}>{m}</option>)}</select></label>
              {validUrl && <Preview kind={attachment.kind} src={url} filename={attachment.name}/>}
            </div>}
            {attachment.kind==="video" && <label className="convert"><input type="checkbox" checked={attachment.convert} onChange={e=>patchAttachment(attachment,{convert:e.target.checked})}/> Convert with FFmpeg</label>}
          </fieldset>;})}</div>
          {(sizeError || error) && <div className="error" role="alert">{sizeError || error}</div>}
          {hasAdminAccess && selectedId && /^\d+@(lid|c\.us|s\.whatsapp\.net)$/.test(selectedId) && <button
            className="label-delete-trigger" type="button" disabled={sending} onClick={()=>setDeletingChat({
              id:selectedId.replace(/@s\.whatsapp\.net$/,"@c.us"),alias:photoIds.get(activeKey)?.replace(/@s\.whatsapp\.net$/,"@c.us"),key:activeKey
            })}>Delete from my chats…</button>}
          {labelId && hasAdminAccess && <button className="label-delete-trigger" type="button" disabled={sending} onClick={()=>setDeletingLabel(true)}>Delete label…</button>}
          <div className="compose"><div className="tools" ref={menuBox}>
            <button className="clip" type="button" aria-label="Attach media" aria-expanded={menu} disabled={sending} onClick={()=>setMenu(!menu)}><Icon name="clip"/></button>
            {menu && <div className="popover">{["image","video","document"].map(kind=><button key={kind} type="button" onClick={()=>{setMenu(false);pickers.current[kind].click();}}><Icon name={kind}/>{kind === "image" ? "Photo" : kind === "video" ? "Video" : "Document"}</button>)}
              <button type="button" onClick={()=>{setMenu(false);replaceAttachment({kind:"image",mime:"image/jpeg",url:"",name:"",convert:false});}}><Icon name="link"/>Media link</button></div>}
            {["image","video","document"].map(kind=><input hidden key={kind} type="file" multiple aria-label={"Choose "+kind} ref={el=>pickers.current[kind]=el} accept={kind === "document" ? undefined : formats[kind].join(",")} onChange={e=>pickFile(e,kind)}/>)}
          </div><textarea hidden={attachment?.kind==="voice"} aria-label={attachment ? "Caption" : "Message"} rows="1" disabled={sending} value={message} placeholder={attachment ? "Add a caption…" : "Type a message…"} onChange={e=>setMessage(e.target.value)} onKeyDown={e=>{if(e.key==="Enter" && !e.shiftKey && !e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form.requestSubmit();}}}/>
          {!panel && numbers.length>0 && !message && !attachment ? <VoiceRecorder key={view+"|"+key} disabled={sending} onError={setError} onDraft={(recording,recordedDuration)=>{
            const src=URL.createObjectURL(recording);blobUrls.current.add(src);
            replaceAttachment({kind:"voice",file:recording,src,recordedDuration,convert:!/^audio\/ogg.*opus/i.test(recording.type)});
          }}/> : <button className="send" aria-label={attachment?.kind==="voice"?"Send voice note":"Send message"} disabled={!ready || sending}><Icon name="send"/></button>}</div>
        </form>
      </section>
    </main>
    {typeof panel === "function" ? panel(number => {
      setLabelFilter("");
      openChat(number);
    }, sending) : panel}
    {hasAdminAccess && newChatOpen && <NewChatDialog onClose={()=>setNewChatOpen(false)} onDone={recipients=>{
      setNewChatOpen(false);
      setLabelFilter("");
      openChat(conversationKey(recipients,contacts));
    }}/>}
    {managingLabels&&<ManageLabels canCreate={hasAdminAccess} labels={labels??[]} initialId={labelId} chats={labelChats} onClose={()=>setManagingLabels(false)}
      onRefresh={(id,created)=>{
        if(created)setLabels(previous=>[...(previous??[]).filter(l=>l.id!==id),created]);
        openChat('label:'+id);
        refreshLabels(value=>value+1);
      }}/>}
    {deletingChat&&hasAdminAccess&&<DeleteChatDialog id={deletingChat.id} alias={deletingChat.alias} contact={directLabel(deletingChat.key)}
      onClose={()=>setDeletingChat(null)} onDeleted={state=>{
        rememberPersonalChats(state);setDeletingChat(null);openChat("");drafts.current.delete(deletingChat.key);
      }}/>}
    {deletingLabel&&labelId&&hasAdminAccess&&<DeleteLabelDialog id={labelId} name={title}
      onClose={()=>setDeletingLabel(false)} onChange={()=>refreshLabels(n=>n+1)} onDeleted={()=>{
        setDeletingLabel(false);setLabels(prev=>prev?.filter(label=>label.id!==labelId));setLabelFilter("");
        openChat("");drafts.current.delete("label:"+labelId);refreshLabels(n=>n+1);
      }}/>}
    {deleteTarget&&<DeleteMessageDialog {...deleteTarget} states={deletion.states} remove={deletion.remove} onClose={()=>setDeleteTarget(null)}/>}
  </LabelHighlights>;
}
