import { useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { rateFrom, useLoad, useSamples } from "../hooks.js";
import { DeliveryBar, Legend } from "../components/DeliveryBar.jsx";
import { Funnel, Pill, Sparkline, Tiles } from "../components/ui.jsx";
import { ago, download, dur, n, pct } from "../lib/format.js";
import { toCsv } from "../lib/csv.js";
import { toast } from "../lib/toast.js";

const LIVE = ["RUNNING", "PAUSED"];

export default function CampaignDetail({ id, back }) {
  const [c, error, reload] = useLoad(() => api.campaign(id), [id], 2500);
  const [busy, setBusy] = useState("");
  const stopDialog = useRef(null);
  const s = c?.stats;
  const done = s ? s.total - s.pending : null;
  const samples = useSamples(done);
  const perMin = rateFrom(samples);

  const points = useMemo(() => samples.slice(1).map((p, i) => {
    const mins = (p.t - samples[i].t) / 60000;
    return mins > 0 ? (p.v - samples[i].v) / mins : 0;
  }), [samples]);

  const act = async (verb, fn) => {
    setBusy(verb);
    try { await fn(id); toast(`Campaign ${verb === "cancel" ? "stopped" : verb + "d"}.`); await reload(); }
    catch (e) { toast(e.message, "bad"); }
    finally { setBusy(""); }
  };

  return (
    <>
      <header className="head">
        <div>
          <button className="crumb" onClick={back}>← Campaigns</button>
          <h2>{c?.name ?? `Campaign #${id}`}</h2>
          {c && <p className="hint">{c.template} · started {ago(c.createdAt)} {c.status && <Pill s={c.status} />}</p>}
        </div>
        {c && (
          <div className="actions">
            {c.status === "RUNNING" && <button className="btn ghost" disabled={busy} onClick={() => act("pause", api.pause)}>Pause</button>}
            {c.status === "PAUSED" && <button className="btn" disabled={busy} onClick={() => act("resume", api.resume)}>Resume</button>}
            {LIVE.includes(c.status) || c.status === "SCHEDULED"
              ? <>
                <button className="btn danger" disabled={busy} aria-haspopup="dialog" onClick={() => stopDialog.current.showModal()}>Stop</button>
                <dialog key={id} ref={stopDialog} className="stop-dialog" aria-labelledby="stop-title" aria-describedby="stop-warning">
                  <h3 id="stop-title">Stop this campaign?</h3>
                  <p id="stop-warning">Messages already queued with WhatsApp may still be delivered, and stopping cannot be undone.</p>
                  <div className="actions">
                    <button className="btn ghost" onClick={() => stopDialog.current.close()}>Cancel</button>
                    <button className="btn danger" onClick={() => {
                      stopDialog.current.close();
                      act("cancel", api.cancel);
                    }}>OK</button>
                  </div>
                </dialog>
              </> : null}
          </div>
        )}
      </header>

      {error && <p className="err">Couldn't load progress: {error}</p>}

      {s && (
        <>
          <section className="panel hero">
            <p className="big">{n(done)}<small> of {n(s.total)} messages processed</small></p>
            <DeliveryBar s={s} tall />
            <Legend s={s} />
          </section>

          <Tiles items={[
            { label: "Delivery rate", value: pct(s.delivered + s.read, s.total), sub: `${n(s.delivered + s.read)} confirmed on a handset` },
            { label: "Read rate", value: pct(s.read, s.total), sub: `${n(s.read)} opened the message` },
            { label: "Failure rate", value: pct(s.failed, s.total), tone: s.failed / s.total > 0.05 ? "bad" : null, sub: `${n(s.failed)} could not be delivered` },
            c.status === "RUNNING"
              ? { label: "Throughput", count: Math.round(perMin), unit: "/min", sub: s.pending ? `${dur((s.pending / Math.max(perMin, 1)) * 60000)} remaining` : "finishing up" }
              : { label: "Status", value: c.status === "SCHEDULED" ? "Queued" : c.status === "PAUSED" ? "Paused" : "Done", sub: s.pending ? `${n(s.pending)} still waiting` : "Nothing left in the queue" },
          ]} />

          <div className="two">
            <section className="panel">
              <h3>Where messages stand</h3>
              <Funnel s={s} />
            </section>
            <section className="panel">
              <h3>Sending pace</h3>
              {c.status === "RUNNING" || points.length > 1
                ? <Sparkline points={points} peak={Math.max(...points, 0)} />
                : <p className="hint">Pace is only measured while a campaign is sending.</p>}
            </section>
          </div>

          {s.failed > 0 && <Failures id={id} total={s.failed} />}
        </>
      )}
    </>
  );
}

function Failures({ id, total }) {
  const [list, error] = useLoad(() => api.failures(id), [id], 12000);
  const groups = useMemo(() => {
    const by = {};
    (list ?? []).forEach((f) => { (by[f.code] ??= { code: f.code, reason: f.reason, items: [] }).items.push(f); });
    return Object.values(by).sort((a, b) => b.items.length - a.items.length);
  }, [list]);

  return (
    <section className="panel">
      <header className="panel-head">
        <h3>Why {n(total)} messages failed</h3>
        {list?.length > 0 && (
          <button className="btn ghost" onClick={() => download(`campaign-${id}-failures.csv`,
            toCsv(["phone", "code", "reason", "at"], list.map((f) => [f.phone, f.code, f.reason, f.at])))}>
            Download CSV
          </button>
        )}
      </header>
      {error && <p className="err">Couldn't load failure detail: {error}</p>}
      {!list && !error && <p className="hint">Loading failure detail…</p>}
      {list?.length === 0 && <p className="hint">No per-recipient detail available yet.</p>}

      {groups.map((g) => (
        <details key={g.code} className="group">
          <summary>
            <span>{g.reason}</span>
            <div className="track"><i className="failed" style={{ width: `${(g.items.length / (list.length || 1)) * 100}%` }} /></div>
            <b>{n(g.items.length)}</b><em>{pct(g.items.length, list.length)}</em>
          </summary>
          <p className="hint">WhatsApp error code {g.code}. Showing the first {Math.min(12, g.items.length)} of {n(g.items.length)}.</p>
          <table>
            <thead><tr><th>Number</th><th>When</th></tr></thead>
            <tbody>{g.items.slice(0, 12).map((f, i) => (
              <tr key={i}><td>+{f.phone}</td><td>{new Date(f.at).toLocaleString()}</td></tr>
            ))}</tbody>
          </table>
        </details>
      ))}
      {list?.length === 500 && <p className="hint">Capped at 500 rows — download the CSV for the full list.</p>}
    </section>
  );
}
