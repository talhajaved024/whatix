export const n = (v) => (v ?? 0).toLocaleString();
export const pct = (part, whole) => (!whole ? "0%" : `${((part / whole) * 100).toFixed(part / whole >= 0.995 || !part ? 0 : 1)}%`);

export function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60000) return "just now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? "s" : ""} ago`;
  const d = Math.round(h / 24);
  return d < 14 ? `${d} day${d > 1 ? "s" : ""} ago` : new Date(iso).toLocaleDateString();
}

export function when(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  return h < 36 ? `in ${h} hour${h > 1 ? "s" : ""}` : new Date(iso).toLocaleString();
}

export function dur(ms) {
  if (!isFinite(ms) || ms <= 0) return "any moment";
  if (ms < 60000) return "under a minute";
  const m = Math.round(ms / 60000);
  if (m < 60) return `about ${m} minute${m > 1 ? "s" : ""}`;
  const h = Math.round(m / 60);
  return `about ${h} hour${h > 1 ? "s" : ""}`;
}

export function download(name, text, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
