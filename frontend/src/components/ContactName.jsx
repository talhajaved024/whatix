import {ContactHighlight} from "./LabelHighlights.jsx";
import {useContext,useEffect,useRef,useState} from "react";
import {AliasContext} from "../contact-aliases.js";
import {authorizedFetch,onAuthChange} from "../auth.js";
import {onInboxChange} from "../inbox.js";
import {memberId,phoneId} from "../group-members.js";

const cache = new Map();
onAuthChange(signedIn => { if (!signedIn) cache.clear(); });
// A contact's saved name differs per WhatsApp account.
onInboxChange(() => cache.clear());

function lookup(id) {
  const cached = cache.get(id);
  if (cached && cached.until > Date.now()) return cached.promise;
  const promise = authorizedFetch("/api/contacts/name?" + new URLSearchParams({contactId:id}))
    .then(async response => response.ok ? (await response.json()).name : null)
    .catch(() => null);
  cache.set(id,{promise,until:Date.now()+300000});
  return promise;
}

export default function ContactName({id,alternate,known,preferName=false,children}) {
  const primary = phoneId(id) || memberId(id);
  const secondary = phoneId(alternate) || memberId(alternate);
  const identity = primary + "|" + secondary;
  // The user's own name for this customer (contact-aliases.js) comes before
  // WhatsApp's, and needs no lookup.
  const aliases = useContext(AliasContext);
  const digits = value => /^(\d+)@c\.us$/.exec(value)?.[1];
  const alias = aliases?.get(digits(primary)) || aliases?.get(digits(secondary)) || "";
  const supplied = alias || (typeof known === "string" && known.trim() &&
    !/^\+?[\d\s().-]+(?:@(c\.us|lid|s\.whatsapp\.net))?$/.test(known.trim()) ? known.trim() : "");
  const [result,setResult] = useState(null);
  const element = useRef(null);
  useEffect(() => {
    if (supplied) return;
    const ids = [...new Set([primary,secondary])].filter(value => /^\d+@(c\.us|lid)$/.test(value));
    if (!ids.length) return;
    let active = true;
    async function load() {
      for (const value of ids) {
        const name = await lookup(value);
        if (!active) return;
        if (name) { setResult({identity,name}); return; }
      }
    }
    let observer;
    if (typeof IntersectionObserver === "undefined") load();
    else {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); }
      });
      observer.observe(element.current);
    }
    return () => { active = false; observer?.disconnect(); };
  },[primary,secondary,identity,supplied]);
  const name = supplied || (result?.identity === identity && result.name);
  return <ContactHighlight id={primary} alternate={secondary}><span ref={element}>{name && preferName ? name : <>{name && <>{name} · </>}{children}</>}</span></ContactHighlight>;
}
