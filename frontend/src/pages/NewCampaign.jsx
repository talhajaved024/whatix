import { useMemo, useState } from "react";
import { api } from "../api.js";
import { useLoad } from "../hooks.js";
import { PhonePreview, slotsIn } from "../components/PhonePreview.jsx";
import { Steps } from "../components/ui.jsx";
import { clean, guessPhoneCol, guessVars, isLocal, readCsv, toCsv, validPhone } from "../lib/csv.js";
import { download, n, pct } from "../lib/format.js";
import { toast } from "../lib/toast.js";

const STEPS = ["Contacts", "Message", "Delivery", "Review"];
const RATES = [[600, "Gentle — 10 per second"], [1800, "Steady — 30 per second"], [3000, "Fast — 50 per second"], [6000, "Maximum — 100 per second"]];
// Only offered to resolve local 0… numbers — never applied unless the sender picks one.
const CODES = [["", "Leave them as they are"], ["92", "Pakistan +92"], ["91", "India +91"], ["971", "UAE +971"],
  ["880", "Bangladesh +880"], ["966", "Saudi Arabia +966"], ["44", "United Kingdom +44"], ["1", "USA / Canada +1"]];
const localIso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export default function NewCampaign({ done }) {
  const [templates] = useLoad(api.templates);
  const [blocked] = useLoad(api.suppressions);
  const [step, setStep] = useState(0);

  const [file, setFile] = useState(null), [csv, setCsv] = useState(null), [phoneCol, setPhoneCol] = useState(-1), [cc, setCc] = useState("");
  const [tpl, setTpl] = useState(""), [vars, setVars] = useState({}), [at, setAt] = useState(0);
  const [mode, setMode] = useState("now"), [sendAt, setSendAt] = useState(localIso(new Date(Date.now() + 36e5))), [rate, setRate] = useState(3000);
  const [name, setName] = useState(""), [ok, setOk] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");

  const approved = templates?.filter((t) => t.status === "APPROVED") ?? [];
  const chosen = approved.find((t) => t.name === tpl);
  const slots = slotsIn(chosen);
  const suppressed = useMemo(() => new Set(blocked ?? []), [blocked]);

  // One pass over the file. A number that appears more than once sends once: the first row
  // wins and later rows are reported against the line that already claimed the number.
  const audit = useMemo(() => {
    if (!csv || phoneCol < 0) return null;
    const seen = new Map(), good = [], bad = [];
    let local = 0;
    csv.rows.forEach((r, i) => {
      const raw = r[phoneCol] ?? "", key = clean(raw, cc);
      if (!cc && isLocal(raw)) local++;
      const why = !raw.trim() ? "Empty"
        : !validPhone(key) ? "Not a valid number"
        : suppressed.has(key) ? "Previously opted out"
        : seen.has(key) ? "Duplicate" : "";
      if (why) bad.push({ line: i + 2, raw, why, note: why === "Duplicate" ? `already sending on line ${seen.get(key)}` : "" });
      else { seen.set(key, i + 2); good.push({ i, key }); }
    });
    const tally = bad.reduce((a, b) => ({ ...a, [b.why]: (a[b.why] ?? 0) + 1 }), {});
    return { rows: csv.rows.length, good, bad, tally, local, dupes: tally.Duplicate ?? 0 };
  }, [csv, phoneCol, suppressed, cc]);

  // What the backend actually receives: deduped rows, phone column rewritten to the canonical
  // number. Without this the server re-parses the original upload and messages duplicates anyway.
  const upload = useMemo(() => {
    if (!csv || !audit?.good.length || !file) return null;
    const rows = audit.good.map(({ i, key }) => csv.rows[i].map((v, c) => (c === phoneCol ? key : v)));
    return new File([toCsv(csv.head, rows)], `${file.name.replace(/\.csv$/i, "")}-ready.csv`, { type: "text/csv" });
  }, [csv, audit, file, phoneCol]);

  const pick = async (f) => {
    setFile(f); setError(""); setCsv(null); setPhoneCol(-1);
    if (!f) return;
    try {
      const parsed = readCsv(await f.text());
      if (!parsed.rows.length) return setError("That file has a header row but no contacts.");
      setCsv(parsed); setPhoneCol(guessPhoneCol(parsed.head, parsed.rows));
    } catch { setError("That file couldn't be read as CSV."); }
  };

  const choose = (nm) => {
    setTpl(nm);
    const t = approved.find((x) => x.name === nm);
    setVars(csv ? guessVars(slotsIn(t), csv.head) : {});
  };

  const row = audit?.good.length ? csv.rows[audit.good[at % audit.good.length].i] : null;
  const get = (slot) => { const c = vars[slot]; return c === "" || c == null ? "" : row?.[Number(c)] ?? ""; };
  const mapped = slots.every((s) => vars[s] !== "" && vars[s] != null);

  const canLeave = [
    audit?.good.length > 0,
    Boolean(chosen) && mapped,
    mode === "now" || Date.parse(sendAt) > Date.now(),
    name.trim() && ok,
  ];

  const send = async () => {
    setBusy(true); setError("");
    try {
      const r = await api.create({
        name: name.trim(), template: tpl, file: upload, total: audit.good.length, phoneColumn: csv.head[phoneCol],
        variables: Object.fromEntries(slots.map((s) => [s, csv.head[Number(vars[s])]])),
        scheduledAt: mode === "later" ? new Date(sendAt).toISOString() : null, rate,
      });
      toast(mode === "later" ? "Campaign scheduled." : `Sending to ${n(audit.good.length)} contacts.`);
      done(r.campaignId);
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <>
      <header className="head"><h2>New campaign</h2></header>
      <Steps steps={STEPS} at={step} go={setStep} />

      {step === 0 && (
        <section className="panel form">
          <label>Contact list (CSV)
            <input type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files[0])} />
            <span className="hint">Any CSV with a column of phone numbers in international format, such as 923001234567. Other columns become template variables.</span>
          </label>
          {error && <p className="err">{error}</p>}

          {csv && (
            <label>Which column holds the phone number?
              <select value={phoneCol} onChange={(e) => setPhoneCol(Number(e.target.value))}>
                <option value={-1}>Choose a column</option>
                {csv.head.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
              </select>
              {phoneCol >= 0 && <span className="hint">Detected automatically — change it if that's the wrong column.</span>}
            </label>
          )}

          {audit && (
            <>
              <dl className="tiles small">
                <div><dt>Rows in file</dt><dd>{n(audit.rows)}</dd></div>
                <div className="t-good"><dt>Unique contacts</dt><dd>{n(audit.good.length)}<small>{pct(audit.good.length, audit.rows)}</small></dd></div>
                <div><dt>Repeats merged</dt><dd>{n(audit.dupes)}</dd></div>
                <div className={audit.bad.length - audit.dupes ? "t-bad" : ""}><dt>Unusable</dt><dd>{n(audit.bad.length - audit.dupes)}</dd></div>
              </dl>
              <p className="hint">A number that appears more than once is messaged once, however it's written — <code>+92 300 1234567</code>, <code>0092-300-1234567</code> and <code>923001234567</code> all count as the same contact.</p>

              {audit.local > 0 && (
                <label className="note-label">
                  <span className="note">{n(audit.local)} rows use a local <code>0…</code> format. Those can't be matched against international numbers until you say which country they belong to.</span>
                  <select value={cc} onChange={(e) => setCc(e.target.value)}>
                    {CODES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </label>
              )}

              {audit.bad.length > 0 && (
                <details className="group">
                  <summary className="plain"><span>{n(audit.bad.length)} rows won't be sent</span><b>{pct(audit.bad.length, audit.rows)}</b></summary>
                  <ul className="why">{Object.entries(audit.tally).map(([why, count]) => (
                    <li key={why}>{why === "Duplicate" ? "Repeated number — merged into one send" : why}<b>{n(count)}</b></li>
                  ))}</ul>
                  <table>
                    <thead><tr><th>Line</th><th>Value</th><th>Reason</th></tr></thead>
                    <tbody>{audit.bad.slice(0, 10).map((b) => (
                      <tr key={b.line}><td>{b.line}</td><td>{b.raw || <em>empty</em>}</td><td>{b.why}{b.note && <em> — {b.note}</em>}</td></tr>
                    ))}</tbody>
                  </table>
                  <button className="btn ghost" onClick={() => download("excluded-rows.csv",
                    toCsv(["line", "value", "reason", "detail"], audit.bad.map((b) => [b.line, b.raw, b.why, b.note])))}>
                    Download all excluded rows
                  </button>
                </details>
              )}
            </>
          )}
        </section>
      )}

      {step === 1 && (
        <div className="two wide-left">
          <section className="panel form">
            <label>Template
              <select value={tpl} onChange={(e) => choose(e.target.value)}>
                <option value="">Choose an approved template</option>
                {approved.map((t) => <option key={t.name} value={t.name}>{t.name} · {t.category}</option>)}
              </select>
            </label>

            {chosen?.category === "Marketing" && (
              <p className="note">This is a marketing template. Only send it to people who opted in, and keep an opt-out route in the message.</p>
            )}

            {chosen && slots.length === 0 && <p className="hint">This template has no variables — everyone receives the same text.</p>}

            {chosen && slots.map((slot) => (
              <label key={slot}>Variable {`{{${slot}}}`}
                <select value={vars[slot] ?? ""} onChange={(e) => setVars((v) => ({ ...v, [slot]: e.target.value }))}>
                  <option value="">Choose a column</option>
                  {csv.head.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </label>
            ))}
            {chosen && !mapped && <p className="hint">Map every variable, or recipients will see raw placeholders.</p>}
          </section>

          <PhonePreview template={chosen} get={get} phone={row?.[phoneCol]} count={audit?.good.length ?? 0}
            index={audit?.good.length ? at % audit.good.length : 0}
            step={(d) => setAt((v) => (v + d + audit.good.length) % audit.good.length)} />
        </div>
      )}

      {step === 2 && (
        <section className="panel form">
          <fieldset className="choice">
            <legend>When should this go out?</legend>
            <label className="check"><input type="radio" name="when" checked={mode === "now"} onChange={() => setMode("now")} />Start sending immediately</label>
            <label className="check"><input type="radio" name="when" checked={mode === "later"} onChange={() => setMode("later")} />Schedule for later</label>
          </fieldset>
          {mode === "later" && (
            <label>Send at
              <input type="datetime-local" value={sendAt} min={localIso(new Date())} onChange={(e) => setSendAt(e.target.value)} />
              {Date.parse(sendAt) <= Date.now() && <span className="err">Pick a time in the future.</span>}
            </label>
          )}
          <label>Sending speed
            <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
              {RATES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <span className="hint">Slower is safer. Bursts of marketing traffic can lower your WhatsApp quality rating, which reduces how many messages Meta lets you send per day.</span>
          </label>
          {audit && <p className="hint">At this speed, {n(audit.good.length)} messages take roughly {Math.max(1, Math.round(audit.good.length / rate))} minute(s) to queue.</p>}
        </section>
      )}

      {step === 3 && (
        <div className="two wide-left">
          <section className="panel form">
            <label>Campaign name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Winter sale — Karachi customers" /></label>
            <dl className="summary">
              <div><dt>Recipients</dt><dd>{n(audit?.good.length ?? 0)}<small>
                {audit?.dupes > 0 && `${n(audit.dupes)} repeated number${audit.dupes > 1 ? "s" : ""} merged`}
                {audit?.dupes > 0 && audit.bad.length - audit.dupes > 0 && " · "}
                {audit && audit.bad.length - audit.dupes > 0 && `${n(audit.bad.length - audit.dupes)} unusable`}
              </small></dd></div>
              <div><dt>Template</dt><dd>{tpl || "—"}<small>{chosen?.category} · {chosen?.language}</small></dd></div>
              <div><dt>Starts</dt><dd>{mode === "now" ? "Immediately" : new Date(sendAt).toLocaleString()}</dd></div>
              <div><dt>Speed</dt><dd>{RATES.find(([v]) => v === rate)?.[1]}</dd></div>
              <div><dt>Source file</dt><dd>{file?.name ?? "—"}</dd></div>
            </dl>
            <label className="check">
              <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
              Everyone on this list agreed to receive WhatsApp messages from us, and we honour opt-outs.
            </label>
            {error && <p className="err">{error}</p>}
            <button className="btn big-btn" disabled={!canLeave[3] || busy} onClick={send}>
              {busy ? "Starting…" : mode === "later" ? `Schedule for ${n(audit?.good.length ?? 0)} contacts` : `Send to ${n(audit?.good.length ?? 0)} contacts`}
            </button>
          </section>
          <PhonePreview template={chosen} get={get} phone={row?.[phoneCol]} count={audit?.good.length ?? 0}
            index={audit?.good.length ? at % audit.good.length : 0}
            step={(d) => setAt((v) => (v + d + audit.good.length) % audit.good.length)} />
        </div>
      )}

      <nav className="wizard-nav">
        {step > 0 && <button className="btn ghost" onClick={() => setStep(step - 1)}>Back</button>}
        {step < 3 && <button className="btn" disabled={!canLeave[step]} onClick={() => setStep(step + 1)}>Continue</button>}
      </nav>
    </>
  );
}
