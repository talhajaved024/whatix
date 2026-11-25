import {ContactHighlight} from "./LabelHighlights.jsx";
import { useLayoutEffect, useReducer, useRef } from "react";
import { dismissCallBanner } from "../call-genie.js";
import { authorizedFetch } from "../auth.js";
import Icon from "./Icon.jsx";

function updateCalls(calls, action) {
  if (action.type === "clear") return [];
  const current = calls.find(call => call.id === action.id);
  if (action.type === "received") {
    const details = action.details;
    return current
      ? calls.map(call => call === current ? { ...call, ...details } : call)
      : [...calls, { id: action.id, ...details, pending: null, failed: false }];
  }
  if (!current) return calls;
  const remove = () => calls.filter(call => call !== current);
  const change = details => calls.map(call => call === current ? {...call,...details} : call);
  if (action.type === "ended") {
    if (current.hidden || (!current.pending && !current.leaving)) return remove();
    return change({leaving:true, ended:true, pending:null});
  }
  if (action.type === "exit-finished") {
    if (!current.leaving) return calls;
    return current.ended ? remove() : change({leaving:false, hidden:true});
  }
  if (action.type === "pending") {
    return calls.map(call => call === current ? { ...call, pending: action.request, failed: false } : call);
  }
  // A reconnect may already have replayed the same ID as a fresh banner.
  if (current.pending !== action.request) return calls;
  if (action.dismiss || action.requested) return change({pending:null, leaving:true, ended:action.dismiss});
  return change({pending:null, failed:true});
}

export function useIncomingCalls() {
  return useReducer(updateCalls, []);
}

export function listenForCalls(stream, dispatch) {
  function receive(type, event) {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (typeof data?.id !== "string" || !data.id) return;
    const { phoneNumber, isVideo, isGroup } = data;
    dispatch({ type, id: data.id, details: { phoneNumber, isVideo, isGroup } });
  }
  stream.addEventListener("call.received", event => receive("received", event));
  stream.addEventListener("call.ended", event => receive("ended", event));
}

function CallBanner({call, dispatch, decline}) {
  const banner = useRef(null);
  useLayoutEffect(() => {
    const card = banner.current;
    // Each stacked card starts above the viewport, regardless of its resting position.
    const distance = card.offsetTop - card.parentElement.scrollTop + card.offsetHeight;
    card.style.setProperty("--call-entry-y", -distance + "px");
  }, []);
  useLayoutEffect(() => {
    if (!call.leaving) return;
    return dismissCallBanner(banner.current, () => dispatch({type:"exit-finished", id:call.id}));
  }, [call.id,call.leaving,dispatch]);
  const caller = call.phoneNumber || "Unknown caller";
  const title = call.isVideo ? "Incoming video call" : "Incoming voice call";
  return <section ref={banner} className={call.leaving ? "incoming-call call-leaving" : "incoming-call"}
    aria-hidden={call.leaving || undefined} aria-label={title + " · " + caller}>
    <span className="incoming-call-avatar"><Icon name={call.isGroup ? "users" : "person"}/></span>
    <div className="incoming-call-details">
      <p>{title}{call.isGroup && " · Group call"}</p>
      <strong><ContactHighlight id={call.phoneNumber}>{caller}</ContactHighlight></strong>
      {call.failed && <p className="call-error">Couldn’t confirm the decline</p>}
    </div>
    <button type="button" className="call-decline" aria-label={`Decline call from ${caller}`}
      title="Decline" disabled={!!call.pending || call.leaving} onClick={() => decline(call.id)}><Icon name="hangup"/></button>
  </section>;
}

export function IncomingCalls({ calls, dispatch }) {
  async function decline(id) {
    const request = Symbol();
    dispatch({ type: "pending", id, request });
    let dismiss = false;
    let requested = false;
    try {
      const response = await authorizedFetch("/api/calls/decline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      requested = response.status === 202;
      dismiss = response.status === 204 || response.status === 409;
    } catch { /* A network failure leaves a visible call available for retry. */ }
    dispatch({ type: "settled", id, request, dismiss, requested });
  }

  return <div className="incoming-calls" aria-live="polite" aria-relevant="additions text">
    {calls.filter(call => !call.hidden).map(call =>
      <CallBanner key={call.id} call={call} decline={decline} dispatch={dispatch}/>)}
  </div>;
}
