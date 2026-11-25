// Renders the chosen template the way WhatsApp will, with {{n}} replaced by real CSV values.
// Merged values are marked so it's obvious at a glance which words come from the contact list.
export const slotsIn = (t) => {
  if (!t) return [];
  const found = `${t.header ?? ""} ${t.body ?? ""} ${t.footer ?? ""}`.match(/\{\{(\d+)\}\}/g) ?? [];
  return [...new Set(found.map((m) => m.replace(/\D/g, "")))].sort((a, b) => a - b);
};

const merge = (text, get) =>
  (text || "").split(/(\{\{\d+\}\})/g).map((part, i) => {
    const slot = part.match(/^\{\{(\d+)\}\}$/)?.[1];
    if (!slot) return part;
    const v = get(slot);
    return <mark key={i} className={v ? "" : "gap"}>{v || `{{${slot}}}`}</mark>;
  });

export function PhonePreview({ template, get, phone, count, index, step }) {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <figure className="phone">
      <figcaption>
        {count > 0 ? (
          <>
            {count > 1 && <button type="button" className="nudge" onClick={() => step(-1)} aria-label="Previous recipient">‹</button>}
            <span>Recipient {(index + 1).toLocaleString()} of {count.toLocaleString()}{phone && <em>{phone}</em>}</span>
            {count > 1 && <button type="button" className="nudge" onClick={() => step(1)} aria-label="Next recipient">›</button>}
          </>
        ) : <span>Preview</span>}
      </figcaption>
      <div className="chat">
        {!template ? <p className="hint">Choose a template to see the message.</p> : (
          <div className="bubble">
            {template.header && <strong className="bhead">{merge(template.header, get)}</strong>}
            <p className="bbody">{merge(template.body, get)}</p>
            {template.footer && <p className="bfoot">{merge(template.footer, get)}</p>}
            <span className="meta">{time}<svg viewBox="0 0 18 12" aria-label="Read" role="img"><path d="M1 7l3 3 6-7M7.5 10l.7.7 6-7" /></svg></span>
            {template.buttons?.length > 0 && (
              <div className="btns">{template.buttons.map((b) => <span key={b}>{b}</span>)}</div>
            )}
          </div>
        )}
      </div>
    </figure>
  );
}
