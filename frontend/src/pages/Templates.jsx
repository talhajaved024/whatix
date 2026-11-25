import { useState } from "react";
import { api } from "../api.js";
import { useLoad } from "../hooks.js";
import { PhonePreview, slotsIn } from "../components/PhonePreview.jsx";
import { Pill, Skeleton } from "../components/ui.jsx";

const ORDER = { APPROVED: 0, PENDING: 1, REJECTED: 2 };

export default function Templates() {
  const [list, error] = useLoad(api.templates);
  const [open, setOpen] = useState(null);
  const sorted = [...(list ?? [])].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const shown = sorted.find((t) => t.name === open);

  return (
    <>
      <header className="head">
        <div><h2>Templates</h2>
          <p className="hint">Templates are written and approved in Meta's WhatsApp Manager. Only approved ones can start a campaign.</p>
        </div>
      </header>

      {error && <p className="err">Couldn't load templates: {error}</p>}
      {!list && !error && <Skeleton rows={3} />}

      <div className={shown ? "two wide-left" : ""}>
        <ul className="rows simple">
          {sorted.map((t) => {
            const slots = slotsIn(t);
            return (
              <li key={t.name}>
                <button className={open === t.name ? "lit" : ""} onClick={() => setOpen(open === t.name ? null : t.name)}>
                  <div className="who">
                    <strong>{t.name}</strong>
                    <span>{t.category} · {t.language} · {slots.length ? `${slots.length} variable${slots.length > 1 ? "s" : ""}` : "no variables"}</span>
                    <p className="preview">{t.body}</p>
                    <div className="chips">
                      {t.header && <span>Header</span>}
                      {t.footer && <span>Footer</span>}
                      {t.buttons?.map((b) => <span key={b}>⌁ {b}</span>)}
                    </div>
                  </div>
                  <Pill s={t.status} />
                </button>
              </li>
            );
          })}
        </ul>
        {shown && <PhonePreview template={shown} get={() => ""} count={0} index={0} step={() => {}} />}
      </div>
    </>
  );
}
