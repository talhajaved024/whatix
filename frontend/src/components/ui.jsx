import { useEffect, useState } from "react";
import { n, pct } from "../lib/format.js";
import { onToast } from "../lib/toast.js";
import { useCountUp } from "../hooks.js";

export const STATUS = {
  SCHEDULED: "Scheduled", RUNNING: "Sending", PAUSED: "Paused", COMPLETED: "Finished", CANCELLED: "Stopped",
  APPROVED: "Approved", PENDING: "In review", REJECTED: "Rejected",
};
export const Pill = ({ s }) => <b className={"pill " + s.toLowerCase()}>{STATUS[s] ?? s}</b>;

export const Skeleton = ({ rows = 3 }) => (
  <ul className="rows" aria-hidden="true">{Array.from({ length: rows }, (_, i) => <li key={i} className="skel" />)}</ul>
);

export function Tiles({ items }) {
  return (
    <dl className="tiles">
      {items.map((t) => (
        <div key={t.label} className={t.tone ? "t-" + t.tone : ""}>
          <dt>{t.label}</dt>
          <dd>{t.count != null ? <Count v={t.count} /> : t.value}{t.unit && <small>{t.unit}</small>}</dd>
          {t.sub && <p>{t.sub}</p>}
        </div>
      ))}
    </dl>
  );
}
const Count = ({ v }) => <>{n(useCountUp(v))}</>;

// Cumulative funnel: each stage is a subset of the one above it, so bars nest by definition.
export function Funnel({ s }) {
  const stages = [
    ["Reached a handset", s.sent + s.delivered + s.read, "sent"],
    ["Delivered", s.delivered + s.read, "delivered"],
    ["Read", s.read, "read"],
  ];
  return (
    <div className="funnel">
      {stages.map(([label, v, cls]) => (
        <div key={label}>
          <span>{label}</span>
          <div className="track"><i className={cls} style={{ width: s.total ? `${(v / s.total) * 100}%` : 0 }} /></div>
          <b>{n(v)}</b><em>{pct(v, s.total)}</em>
        </div>
      ))}
    </div>
  );
}

// Throughput over the poll window. Values come from useSamples, so no backend series is needed.
export function Sparkline({ points, peak }) {
  if (points.length < 2) return <p className="hint">Measuring throughput…</p>;
  const w = 600, h = 64, pad = 8, max = Math.max(...points, 1);
  const x = (i) => pad + (i * (w - pad * 2)) / Math.max(1, points.length - 1);
  const y = (v) => h - pad - (v / max) * (h - pad * 2.5);
  const line = points.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return (
    <figure className="spark">
      <figcaption>Throughput<b>{n(peak)} / min at peak</b></figcaption>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`Throughput trend, peak ${n(peak)} per minute`}>
        <polygon className="fill" points={`${pad},${h - pad} ${line} ${x(points.length - 1)},${h - pad}`} />
        <polyline className="line" points={line} vectorEffect="non-scaling-stroke" />
        <circle className="tip" cx={x(points.length - 1)} cy={y(points.at(-1))} r="4" vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  );
}

export function Steps({ steps, at, go }) {
  return (
    <ol className="steps">
      {steps.map((label, i) => (
        <li key={label} className={i === at ? "on" : i < at ? "done" : ""}>
          <button disabled={i > at} onClick={() => go(i)} aria-current={i === at ? "step" : undefined}>
            <i>{i < at ? "✓" : i + 1}</i>{label}
          </button>
        </li>
      ))}
    </ol>
  );
}

export function Toasts() {
  const [list, setList] = useState([]);
  useEffect(() => onToast((t) => {
    setList((l) => [...l, t]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), 4500);
  }), []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => <p key={t.id} className={t.kind}>{t.text}</p>)}
    </div>
  );
}

export function ThemeToggle({ mode, set }) {
  return (
    <div className="theme" role="group" aria-label="Colour theme">
      {[["system", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(([k, label]) => (
        <button key={k} className={mode === k ? "on" : ""} aria-pressed={mode === k} onClick={() => set(k)}>{label}</button>
      ))}
    </div>
  );
}
