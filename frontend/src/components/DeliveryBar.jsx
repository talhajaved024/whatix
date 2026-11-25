import { useState } from "react";
import { n, pct } from "../lib/format.js";

// Fixed order: the sequential ramp (sent -> delivered -> read), then the neutral, then the status colour.
export const SEG = [["read", "Read"], ["delivered", "Delivered"], ["sent", "Sent"], ["pending", "Waiting"], ["failed", "Failed"]];

export function DeliveryBar({ s, tall }) {
  const [tip, setTip] = useState({ key: "", x: 0, visible: false });
  const parts = SEG.filter(([k]) => s[k] > 0);
  const active = parts.find(([key]) => key === tip.key);
  const summary = parts.map(([k, label]) => `${label} ${pct(s[k], s.total)}`).join(", ");
  return (
    <div className={"delivery-chart" + (tall ? " tall" : "")} onPointerLeave={() => setTip(t => ({ ...t, visible: false }))}>
    <div className="bar" role="img" aria-label={`Delivery breakdown: ${summary || "nothing sent yet"}`}>
      {parts.map(([k, label]) => (
        <i key={k} className={k} style={{ width: `${(s[k] / s.total) * 100}%` }} onPointerEnter={e => {
          if (e.pointerType === "touch") return;
          const bar = e.currentTarget.parentElement.getBoundingClientRect();
          setTip({ key: k, x: e.clientX - bar.left, visible: true });
        }} />
      ))}
    </div>
    <span aria-hidden="true" className={"bar-tip" + (active && tip.visible ? " visible" : "")} style={{ "--tip-x": `${tip.x}px` }}>
      {active && <><b>{active[1]}</b> {n(s[tip.key])} · {pct(s[tip.key], s.total)}</>}
    </span>
    </div>
  );
}

// Doubles as the table view, which is what licenses the low-contrast ramp steps.
export const Legend = ({ s }) => (
  <dl className="legend">
    {SEG.map(([k, label]) => (
      <div key={k}>
        <dt><i className={"dot " + k} />{label}</dt>
        <dd>{n(s[k])}<small>{pct(s[k], s.total)}</small></dd>
      </div>
    ))}
  </dl>
);
