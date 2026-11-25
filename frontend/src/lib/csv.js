// RFC-4180-ish parser: handles quoted fields, escaped quotes, CRLF and a leading BOM.
export function parseCsv(text) {
  const raw = text || "";
  const src = raw.codePointAt(0) === 65279 ? raw.slice(1) : raw; // strip BOM
  const rows = []; let row = [], cell = "", quoted = false;
  const endRow = () => { row.push(cell); cell = ""; if (row.some((v) => v.trim())) rows.push(row); row = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (src[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && src[i + 1] === "\n") i++; endRow(); }
    else cell += c;
  }
  endRow();
  return rows.map((r) => r.map((v) => v.trim()));
}

export function readCsv(text) {
  const all = parseCsv(text);
  return { head: all[0] ?? [], rows: all.slice(1) };
}

// Canonical form, and the dedupe key: every non-digit goes, so "+", spaces, dashes of any
// width, dots and slashes all collapse to the same number. A leading 00 is the international
// access prefix. A leading single 0 is a national-format number — it only resolves to one
// international number once a country code is supplied, so we never guess one.
export const digits = (v) => (v || "").replace(/\D/g, "");
export const clean = (v, cc = "") => {
  let d = digits(v);
  if (d.startsWith("00")) d = d.slice(2);
  if (cc && d.length > 1 && d.startsWith("0")) d = cc + d.slice(1);
  return d;
};
export const isLocal = (v) => /^0[1-9]/.test(digits(v));
export const validPhone = (v) => /^\d{8,15}$/.test(v);

// Guess the phone column by header name first, then by which column actually parses as numbers.
export function guessPhoneCol(head, rows) {
  const byName = head.findIndex((h) => /phone|mobile|msisdn|whatsapp|number|cell|contact/i.test(h));
  if (byName >= 0) return byName;
  const sample = rows.slice(0, 25);
  let best = -1, bestHits = 0;
  head.forEach((_, i) => {
    const hits = sample.filter((r) => validPhone(clean(r[i]))).length;
    if (hits > bestHits) { best = i; bestHits = hits; }
  });
  return bestHits >= Math.max(1, sample.length / 2) ? best : -1;
}

// Guess a column for each {{n}} by matching common names in order.
const HINTS = [/first.?name|^name$|customer/i, /order|invoice|amount|id$/i, /date|time|day/i];
export function guessVars(slots, head) {
  const out = {};
  slots.forEach((slot, i) => {
    const hint = HINTS[i];
    const col = hint ? head.findIndex((h) => hint.test(h)) : -1;
    out[slot] = col >= 0 ? String(col) : "";
  });
  return out;
}

export const quote = (v) => (/[",\n\r]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const toCsv = (head, rows) => [head, ...rows].map((r) => r.map(quote).join(",")).join("\r\n");
