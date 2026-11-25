let listeners = [];
export const toast = (text, kind = "ok") => listeners.forEach((l) => l({ id: Math.random(), text, kind }));
export const onToast = (l) => { listeners.push(l); return () => { listeners = listeners.filter((x) => x !== l); }; };
