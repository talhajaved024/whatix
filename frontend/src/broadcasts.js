import { authorizedFetch, currentUser } from "./auth.js";

export function broadcastActive(job) {
  return job && !["completed", "completed_with_errors", "rejected"].includes(job.status);
}

// Each mounted account owns its timers and requests. A pending body survives reload
// until the first confirmed snapshot, so recovery can replay precisely the same POST.
export function broadcastTracker(owner, update) {
  const tasks = new Map();
  const lifetime = new AbortController();

  async function track(initial, submit = false) {
    if (!broadcastActive(initial.job) || tasks.has(initial.id) || lifetime.signal.aborted) return;
    let item = initial;
    const task = {};
    tasks.set(item.id, task);
    const active = () => !lifetime.signal.aborted && currentUser()?.username === owner;
    async function poll() {
      if (!active()) return;
      try {
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(60000)]);
        let response;
        if (!submit) {
          response = await authorizedFetch("/api/broadcasts/" + item.id, {signal, cache:"no-store"});
        }
        if (active() && item.pendingBody && (submit || response?.status === 404)) {
          submit = false;
          response = await authorizedFetch("/api/broadcasts", {
            method:"POST", headers:{"Content-Type":"application/json"}, body:item.pendingBody, signal
          });
          if ([400, 403, 409, 413, 422].includes(response.status)) {
            const body = await response.json().catch(() => null);
            item = {...item, pendingBody:undefined, job:{...item.job, status:"rejected",
              error:body?.error || "Broadcast submission failed (HTTP " + response.status + ")."}};
          }
        }
        if (!active()) return;
        if (broadcastActive(item.job)) {
          if (!response?.ok) throw new Error();
          const {id, results, ...job} = await response.json();
          if (id !== item.id || !Array.isArray(results)) throw new Error();
          item = {...item, pendingBody:undefined, job, results:results.map(result => ({
            ...result, number:result.number.replace(/@(c\.us|s\.whatsapp\.net)$/, "")
          }))};
        }
        if (active()) update(item, true);
      } catch {
        if (!active()) return;
        item = {...item, reconnecting:true};
        update(item, false);
      }
      item = {...item, reconnecting:false};
      if (active() && broadcastActive(item.job)) task.timer = setTimeout(poll, 3000);
      else tasks.delete(item.id);
      return item.job.status;
    }
    return poll();
  }
  return {track, hasActiveJobs:() => tasks.size > 0, close() {
    lifetime.abort();
    for (const task of tasks.values()) clearTimeout(task.timer);
    tasks.clear();
  }};
}
