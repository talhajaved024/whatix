import { useState } from "react";
import Icon from "./Icon.jsx";

export function attachmentGroups(items) {
  const groups = [];
  for (const item of items) {
    const previous = groups.at(-1);
    const album = !item.sender && !item.display && item.albumId;
    if (album && previous?.album === album) previous.items.push(item);
    else groups.push({album,items:[item]});
  }
  return groups;
}

export default function AttachmentAlbum({items,renderMessage,messageBody}) {
  const [selected,setSelected] = useState(null);
  const index = items.findIndex(item=>item.id===selected);
  const documents = items.every(item=>item.kind==="document");
  const label = items.length + (documents ? " documents" : " attachments");
  const failed = items.some(item=>item.results?.some(result=>!result.ok) || item.job?.unsuccessful || item.job?.status==="rejected");
  const active = items.some(item=>item.job && !["completed","rejected"].includes(item.job.status));
  const shown = items.slice(0,documents ? 3 : 4);
  return <section className="bubble attachment-album" aria-label={label}>
    <header><strong>{label}</strong>{index>=0 && <button type="button" onClick={()=>setSelected(null)}>Back to album</button>}</header>
    {index<0 ? <>
      <div className={documents?"album-files":"album-grid"}>
        {shown.map((item,i)=>{
          const more = i===shown.length-1 ? items.length-shown.length : 0;
          return <button type="button" key={item.id} aria-label={"Open "+(item.filename || item.kind)} onClick={()=>setSelected(item.id)}>
            {item.kind==="image" && item.src ? <img src={item.src} alt="" loading="lazy"/> :
             item.kind==="video" && item.src ? <><video src={item.src} muted playsInline preload="metadata"/><span className="album-play" aria-hidden="true">▶</span></> :
             <><Icon name={item.kind}/><span className="album-filename">{item.filename || item.kind}</span></>}
            {more>0 && <span className="album-more">+{more}</span>}
          </button>;
        })}
      </div>
      {items[0].text && <div className="body-text">{messageBody(items[0])}</div>}
      <div className="meta">{failed && <span>Delivery issue</span>}{active && <span>Broadcast in progress</span>}<time>{items.at(-1).time}</time></div>
    </> : <>
      <nav aria-label="Browse attachments"><button type="button" disabled={index===0} onClick={()=>setSelected(items[index-1].id)}>Previous</button>
        <span>{index+1} / {items.length}</span><button type="button" disabled={index===items.length-1} onClick={()=>setSelected(items[index+1].id)}>Next</button></nav>
      {renderMessage(items[index])}
    </>}
  </section>;
}
