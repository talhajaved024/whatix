import { useLayoutEffect, useRef, useState } from "react";
import { parsePhoneNumberFromString, validatePhoneNumberLength } from "libphonenumber-js/max";

function parseNumber(text) {
  const digits = text.trim().replace(/[ ()-]/g, "").replace(/^\+/, "");
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
  const phone = parsePhoneNumberFromString("+" + digits);
  return phone?.isValid() && phone.number === "+" + digits ? phone : null;
}

function completeWhileTyping(phone) {
  if (phone.country === "PK" && phone.getType() === "MOBILE") return true;
  // Variable-length numbering plans need an explicit separator at shorter valid lengths.
  for (let longer = phone.number + "0"; longer.length <= 16; longer += "0") {
    if (!validatePhoneNumberLength(longer)) return false;
  }
  return true;
}

export default function NewChatDialog({onDone,onClose}) {
  const dialog = useRef(null);
  const input = useRef(null);
  const closing = useRef(false);
  const [numbers,setNumbers] = useState([]);
  const [draft,setDraft] = useState("");
  const [error,setError] = useState("");
  useLayoutEffect(() => {
    const el = dialog.current;
    el.showModal();
    input.current.focus();
    return () => el.close();
  }, []);

  async function finish(action) {
    if (closing.current) return;
    closing.current = true;
    const el = dialog.current;
    const appearance = getComputedStyle(el);
    el.style.setProperty("--power-off-start", appearance.transform);
    el.style.setProperty("--power-off-opacity", appearance.opacity);
    el.querySelector("form").inert = true;
    el.dataset.closing = "";
    const collapse = el.getAnimations().find(animation => animation.animationName === "new-chat-power-off");
    if (collapse) await collapse.finished.catch(() => {});
    if (el.open) action();
  }

  function dismiss() {
    finish(onClose);
  }

  function change(value) {
    const added = [];
    let pending = "";
    for (const char of value) {
      if (/[,;\n]/.test(char)) {
        const phone = parseNumber(pending);
        if (pending.trim() && !phone) {
          setDraft(value);
          setError("Check the number before the separator, including its country code.");
          return;
        }
        if (phone) added.push(phone.number);
        pending = "";
      } else {
        pending += char;
        const phone = /\d/.test(char) && parseNumber(pending);
        if (phone && completeWhileTyping(phone)) {
          added.push(phone.number);
          pending = "";
        }
      }
    }
    setNumbers(previous => [...new Set([...previous,...added])]);
    setDraft(pending);
    setError("");
  }

  function submit(event) {
    event.preventDefault();
    const last = parseNumber(draft);
    if ((draft.trim() && !last) || (!numbers.length && !last)) {
      setError("Enter a valid phone number with its country code.");
      input.current.focus();
      return;
    }
    const recipients = [...new Set([...numbers,...(last ? [last.number] : [])])].map(n => n.slice(1));
    finish(() => onDone(recipients));
  }

  return <dialog className="new-chat-dialog" ref={dialog} aria-labelledby="new-chat-title"
    onCancel={event=>{event.preventDefault();dismiss();}}>
    <form onSubmit={submit}>
      <header><h2 id="new-chat-title">New chat</h2><button type="button" aria-label="Close new chat" onClick={dismiss}>×</button></header>
      <label htmlFor="new-chat-numbers">Phone numbers</label>
      <p id="new-chat-hint">Include the country code. Keep typing to add another number, or separate numbers with a comma.</p>
      <div className="number-field" onClick={()=>input.current.focus()}>
        {numbers.map((number,index)=><span className="number-entry" key={number}>
          <span className="number-tag">{number}<button type="button" aria-label={"Remove "+number}
            onClick={()=>{setNumbers(numbers.filter(n=>n!==number));setError("");}}>×</button></span>
          {(index<numbers.length-1 || draft.trim()) && <span aria-hidden="true">,</span>}
        </span>)}
        <textarea id="new-chat-numbers" ref={input} inputMode="tel" rows="1" autoComplete="off"
          aria-describedby={"new-chat-hint"+(error?" new-chat-error":"")} aria-invalid={Boolean(error)}
          placeholder={numbers.length?"Next number":"+92 332 4479729"} value={draft}
          onChange={event=>change(event.target.value)} onKeyDown={event=>{
            if (event.key==="Enter") { event.preventDefault();event.currentTarget.form.requestSubmit(); }
            if (event.key==="Backspace" && !draft && numbers.length) {
              event.preventDefault();setDraft(numbers.at(-1));setNumbers(numbers.slice(0,-1));setError("");
            }
          }}/>
      </div>
      {error && <p className="error" role="alert" id="new-chat-error">{error}</p>}
      <footer><button type="button" onClick={dismiss}>Cancel</button><button className="new-chat-done" type="submit">Done</button></footer>
    </form>
  </dialog>;
}
