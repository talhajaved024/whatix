// Placeholder rows shown while a list of chats or contacts is being fetched,
// so the space reads as "loading" rather than "empty". `label` is what a
// screen reader announces; the rows themselves are decoration.
// compact: the smaller rows of the Assign Contacts list.
export default function ListLoader({rows=6,label,compact=false}){
  return <div className={"list-loader"+(compact?" compact":"")} role="status" aria-busy="true">
    <span className="idle-sr">{label}</span>
    {Array.from({length:rows},(_,index)=><div className="list-loader-row" key={index} aria-hidden="true"><i/><span><b/><b/></span></div>)}
  </div>;
}
