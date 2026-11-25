export default function BroadcastProgress({item}) {
  const {job} = item;
  if (job.status === "completed") return null;
  if (job.status === "rejected") return <p className="broadcast-progress" role="alert">{job.error}</p>;
  if (job.status === "completed_with_errors") return <details className="broadcast-progress">
    <summary>{job.sent} sent · {job.unsuccessful} need review</summary>
    {item.results.filter(r => !r.ok).map(r => <p key={r.number}>{r.number} · {r.error}</p>)}
  </details>;
  const {processed, total, sent, unsuccessful} = job;
  return <div className="broadcast-progress">
    <progress aria-label="Broadcast progress" value={processed} max={total}/>
    <div role="status">
      {item.reconnecting && <div>Reconnecting…</div>}
      {job.status === "submitting" ? "Submitting…" : job.status === "queued" ? "Queued" :
        <>{processed} of {total} processed · {sent} sent · {unsuccessful} unsuccessful</>}
      {job.status === "waiting" && <div>Next batch at <time dateTime={new Date(job.nextBatchAt).toISOString()}>
        {new Date(job.nextBatchAt).toLocaleString()}</time></div>}
    </div>
  </div>;
}
