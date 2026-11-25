import { useMemo, useState } from "react";
import { api } from "../api.js";
import { useLoad } from "../hooks.js";
import { DeliveryBar } from "../components/DeliveryBar.jsx";
import { Pill, Skeleton } from "../components/ui.jsx";
import { ago, n, pct, when } from "../lib/format.js";

const TABS = [["all", "All"], ["RUNNING", "Sending"], ["PAUSED", "Paused"], ["SCHEDULED", "Scheduled"], ["COMPLETED", "Finished"]];
const PAGE = 8;

export default function Campaigns({ open, start }) {
  const [list, error] = useLoad(api.campaigns, [], 4000);
  const [q, setQ] = useState(""), [tab, setTab] = useState("all"), [sort, setSort] = useState("new"), [shown, setShown] = useState(PAGE);

  const done = (c) => c.stats.total - c.stats.pending;
  const rows = useMemo(() => {
    let r = list ?? [];
    if (tab !== "all") r = r.filter((c) => c.status === tab);
    const t = q.trim().toLowerCase();
    if (t) r = r.filter((c) => c.name.toLowerCase().includes(t) || c.template.toLowerCase().includes(t));
    return [...r].sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name)
      : sort === "progress" ? done(b) / b.stats.total - done(a) / a.stats.total
      : Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [list, q, tab, sort]);

  const count = (k) => (k === "all" ? list?.length ?? 0 : list?.filter((c) => c.status === k).length ?? 0);

  return (
    <>
      <header className="head">
        <div><h2>Campaigns</h2>{list && <p className="hint">{n(list.reduce((a, c) => a + done(c), 0))} messages processed across {list.length} campaigns</p>}</div>
        <button className="btn" onClick={start}>New campaign</button>
      </header>

      {error && <p className="err">Couldn't load campaigns: {error}</p>}

      {list && list.length > 0 && (
        <div className="filters">
          <input className="search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search campaigns or templates" aria-label="Search campaigns" />
          <div className="tabs" role="group" aria-label="Filter by status">
            {TABS.filter(([k]) => k === "all" || count(k)).map(([k, label]) => (
              <button key={k} className={tab === k ? "on" : ""} aria-pressed={tab === k} onClick={() => setTab(k)}>{label}<em>{count(k)}</em></button>
            ))}
          </div>
          <label className="sort">Sort
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="new">Newest</option><option value="progress">Most complete</option><option value="name">Name</option>
            </select>
          </label>
        </div>
      )}

      {!list && !error && <Skeleton rows={4} />}

      {list?.length === 0 && (
        <div className="empty">
          <h3>No campaigns yet</h3>
          <p>Upload a contact list, map your template variables, and preview the exact message before anything sends.</p>
          <button className="btn" onClick={start}>Create your first campaign</button>
        </div>
      )}

      {list?.length > 0 && rows.length === 0 && <p className="hint">Nothing matches that filter.</p>}

      <ul className="rows">
        {rows.slice(0, shown).map((c) => (
          <li key={c.id}>
            <button onClick={() => open(c.id)}>
              <div className="who">
                <strong>{c.name}</strong>
                <span>{c.template} · {c.status === "SCHEDULED" ? `sends ${when(c.scheduledAt)}` : ago(c.createdAt)}</span>
              </div>
              <div className="prog">
                <DeliveryBar s={c.stats} />
                <em>{n(done(c))} of {n(c.stats.total)} · {pct(done(c), c.stats.total)}</em>
              </div>
              <Pill s={c.status} />
            </button>
          </li>
        ))}
      </ul>

      {rows.length > shown && <button className="btn ghost wide" onClick={() => setShown((s) => s + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</button>}
    </>
  );
}
