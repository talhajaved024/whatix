import { useEffect, useRef, useState } from "react";

export const calm = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function useLoad(fn, deps = [], every = 0) {
  const [data, setData] = useState(null), [error, setError] = useState("");
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => {
    let live = true;
    const run = () => ref.current()
      .then((d) => { if (live) { setData(d); setError(""); } })
      .catch((e) => live && setError(e.message));
    run();
    const t = every && setInterval(run, every);
    return () => { live = false; t && clearInterval(t); };
  }, [...deps, every]);
  return [data, error, () => ref.current().then(setData).catch((e) => setError(e.message))];
}

// Keeps a rolling window of samples so we can derive throughput without a backend.
export function useSamples(value, cap = 30) {
  const [samples, setSamples] = useState([]);
  useEffect(() => {
    if (value == null) return;
    setSamples((prev) => (prev.at(-1)?.v === value && prev.length ? prev : [...prev, { t: Date.now(), v: value }].slice(-cap)));
  }, [value, cap]);
  return samples;
}

export function rateFrom(samples) {
  if (samples.length < 2) return 0;
  const a = samples[0], b = samples.at(-1), mins = (b.t - a.t) / 60000;
  return mins > 0 ? Math.max(0, (b.v - a.v) / mins) : 0;
}

export function useCountUp(target, ms = 650) {
  const [v, setV] = useState(target ?? 0);
  const from = useRef(target ?? 0);
  useEffect(() => {
    if (target == null) return;
    if (calm()) { from.current = target; setV(target); return; }
    const start = performance.now(), a = from.current, delta = target - a;
    if (!delta) return;
    let raf;
    const step = (now) => {
      const p = Math.min(1, (now - start) / ms), eased = 1 - (1 - p) ** 3;
      from.current = a + delta * eased;
      setV(Math.round(from.current));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export function useHashRoute() {
  const read = () => location.hash.replace(/^#/, "") || "/campaigns";
  const [path, setPath] = useState(read);
  useEffect(() => {
    const on = () => setPath(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [path, (p) => { location.hash = p; }];
}

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export function useTheme() {
  const [mode, setMode] = useState(() => store.get("theme", "system"));
  useEffect(() => {
    const el = document.documentElement;
    mode === "system" ? el.removeAttribute("data-theme") : el.setAttribute("data-theme", mode);
    store.set("theme", mode);
  }, [mode]);
  return [mode, setMode];
}
