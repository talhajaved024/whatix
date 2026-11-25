import { authorizedFetch } from "./auth.js";
// Expected Spring Boot endpoints. Fields marked ? are optional — an older backend still renders.
//   GET  /api/templates                 -> [{ name, language, category, status, body, header?, footer?, buttons? }]
//   GET  /api/campaigns                 -> [{ id, name, template, createdAt, status, scheduledAt?, stats }]
//   GET  /api/campaigns/{id}            -> one of the above (meta + stats in a single poll)
//   POST /api/campaigns (multipart)     -> { campaignId }
//        name, template, file, phoneColumn, variables (JSON {"1":"first_name"}), scheduledAt?, rate?
//   GET  /api/campaigns/{id}/failures   -> [{ phone, code, reason, at }]
//   POST /api/campaigns/{id}/pause      -> { status }   (also /resume and /cancel)
//   GET  /api/suppressions              -> ["923001234567", ...]  numbers that opted out
// status is one of SCHEDULED | RUNNING | PAUSED | COMPLETED | CANCELLED.
const MOCK = import.meta.env.VITE_USE_MOCK !== "false";

const templates = [
  { name: "order_update", language: "en", category: "Utility", status: "APPROVED", header: "Order {{2}}",
    body: "Hi {{1}}, your order {{2}} has shipped and should reach you by {{3}}.", footer: "Reply HELP to reach support" },
  { name: "winter_sale", language: "en", category: "Marketing", status: "APPROVED",
    body: "Hi {{1}}, our winter sale starts today — up to {{2}} off everything in store.",
    footer: "Reply STOP to opt out", buttons: ["Shop the sale", "Stop promotions"] },
  { name: "payment_received", language: "en", category: "Utility", status: "APPROVED",
    body: "Thanks {{1}} — we've received your payment of {{2}}.", footer: "This is an automated receipt" },
  { name: "appointment_reminder", language: "en", category: "Utility", status: "PENDING",
    body: "Hi {{1}}, a reminder of your visit on {{2}} at {{3}}." },
  { name: "feedback_request", language: "ur", category: "Marketing", status: "REJECTED",
    body: "{{1}}, how did we do? Tap below to rate your visit.", buttons: ["Rate us"] },
];

const suppressions = ["923009999001", "923009999002", "923331234567", "923451112233"];

const t0 = Date.now();
const db = [
  { id: 1, name: "Ramzan early access", template: "winter_sale", total: 8420, created: t0 - 2.6e8, status: "COMPLETED", rate: 3000, pausedMs: 0 },
  { id: 2, name: "Order updates — October batch", template: "order_update", total: 1284, created: t0 - 14000, status: "RUNNING", rate: 3000, pausedMs: 0 },
  { id: 3, name: "Karachi store reopening", template: "winter_sale", total: 5600, created: t0, status: "SCHEDULED", rate: 1200, pausedMs: 0, scheduledAt: new Date(t0 + 864e5).toISOString() },
];
let seq = db.length;

// Mock progress is wall-clock driven: rate messages per minute, minus any time spent paused.
const activeMs = (c) => Math.max(0, (c.stoppedAt ?? (c.status === "PAUSED" ? c.pausedAt : Date.now())) - c.created - c.pausedMs);
const doneFor = (c) => (c.status === "COMPLETED" ? c.total : Math.min(c.total, Math.floor((activeMs(c) / 60000) * c.rate)));

const tick = () => db.forEach((c) => {
  if (c.status === "SCHEDULED" && Date.parse(c.scheduledAt) <= Date.now()) { c.status = "RUNNING"; c.created = Date.now(); }
  if (c.status === "RUNNING" && doneFor(c) >= c.total) { c.status = "COMPLETED"; c.stoppedAt = Date.now(); }
});

const statsFor = (c) => {
  if (!c) throw new Error("That campaign no longer exists.");
  if (c.status === "SCHEDULED") return { total: c.total, pending: c.total, sent: 0, delivered: 0, read: 0, failed: 0 };
  const done = doneFor(c), failed = Math.floor(done * 0.034), ok = done - failed;
  const read = Math.round(ok * 0.42), delivered = Math.round(ok * 0.44);
  return { total: c.total, pending: c.total - done, sent: ok - read - delivered, delivered, read, failed };
};
const view = (c) => ({ id: c.id, name: c.name, template: c.template, status: c.status,
  createdAt: new Date(c.created).toISOString(), scheduledAt: c.scheduledAt, rate: c.rate, stats: statsFor(c) });

const REASONS = [
  { code: 131026, reason: "Not a WhatsApp user", weight: 34 },
  { code: 131050, reason: "Opted out of marketing messages", weight: 24 },
  { code: 131047, reason: "Outside the 24-hour customer care window", weight: 18 },
  { code: 131008, reason: "Invalid phone number format", weight: 14 },
  { code: 131049, reason: "Held back by Meta for quality reasons", weight: 10 },
];
const pool = REASONS.flatMap((r) => Array(r.weight).fill(r));
const seeded = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const failuresFor = (c) => {
  const count = Math.min(500, statsFor(c).failed), rnd = seeded(c.id * 7919), span = Math.max(1, activeMs(c));
  return Array.from({ length: count }, () => {
    const r = pool[Math.floor(rnd() * pool.length)];
    return { phone: "923" + String(Math.floor(rnd() * 1e9)).padStart(9, "0"), code: r.code, reason: r.reason,
      at: new Date(c.created + Math.floor(rnd() * span)).toISOString() };
  });
};

const find = (id) => db.find((c) => c.id === Number(id));
const wait = (v) => new Promise((r) => setTimeout(() => r(v), 260));
// fn() can throw (unknown id), and useLoad only catches rejections — never a sync throw.
const mock = (fn) => { tick(); try { return wait(fn()); } catch (e) { return Promise.reject(e); } };

async function http(url, opts) {
  const r = await authorizedFetch(url, opts);
  if (!r.ok) throw new Error((await r.text()) || `Request failed (${r.status})`);
  return r.json();
}
const post = (url) => http(url, { method: "POST" });

export const api = {
  templates: () => (MOCK ? wait(templates) : http("/api/templates")),
  suppressions: () => (MOCK ? wait(suppressions) : http("/api/suppressions")),
  campaigns: () => (MOCK ? mock(() => db.map(view).reverse()) : http("/api/campaigns")),
  campaign: (id) => (MOCK ? mock(() => view(find(id))) : http(`/api/campaigns/${id}`)),
  failures: (id) => (MOCK ? mock(() => failuresFor(find(id))) : http(`/api/campaigns/${id}/failures`)),

  pause: (id) => (MOCK ? mock(() => { const c = find(id); c.status = "PAUSED"; c.pausedAt = Date.now(); return { status: c.status }; })
    : post(`/api/campaigns/${id}/pause`)),
  resume: (id) => (MOCK ? mock(() => { const c = find(id); c.pausedMs += Date.now() - c.pausedAt; c.status = "RUNNING"; return { status: c.status }; })
    : post(`/api/campaigns/${id}/resume`)),
  cancel: (id) => (MOCK ? mock(() => { const c = find(id); c.status = "CANCELLED"; c.stoppedAt = Date.now(); return { status: c.status }; })
    : post(`/api/campaigns/${id}/cancel`)),

  create: ({ name, template, file, total, phoneColumn, variables, scheduledAt, rate }) => {
    if (!MOCK) {
      const f = new FormData();
      f.append("name", name); f.append("template", template); f.append("file", file);
      f.append("phoneColumn", phoneColumn); f.append("variables", JSON.stringify(variables));
      if (scheduledAt) f.append("scheduledAt", scheduledAt);
      if (rate) f.append("rate", String(rate));
      return http("/api/campaigns", { method: "POST", body: f });
    }
    const id = ++seq;
    db.push({ id, name, template, total, rate: rate || 3000, pausedMs: 0, created: Date.now(),
      status: scheduledAt ? "SCHEDULED" : "RUNNING", scheduledAt });
    return wait({ campaignId: id });
  },
};
