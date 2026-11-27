// A person's initials on a soft tile. The colour comes from the name, so the
// same user looks the same in every table and dialog.
const tones=[['#d3f0de','#174d3d'],['#d7ebfb','#1b4e7a'],['#fbeec7','#7a5310'],['#f8dbe8','#82264f'],
 ['#e6dcfa','#56309a'],['#cdf3ee','#11605a'],['#fde0cc','#8a3a12']];
export default function Initials({name,size=34,className=''}){
 const text=String(name||'?').trim();
 let hash=0;for(const ch of text)hash=(hash*31+ch.codePointAt(0))>>>0;
 const [background,color]=tones[hash%tones.length];
 const letters=text.split(/[\s._@-]+/).filter(Boolean).slice(0,2).map(w=>[...w][0]).join('').toUpperCase()||'?';
 return <span className={'initials '+className} aria-hidden="true"
  style={{width:size,height:size,fontSize:Math.round(size*.4),background,color}}>{letters}</span>;
}
