// Chooses how much visual effect this machine gets. "lite" (see the data-perf rules in styles.css) drops the
// frosted-glass blur, the drifting background and the cursor constellation, which are what make the app feel
// slow on old laptops; the layout and every feature stay the same.
// A machine is lite when it reports 4 or fewer CPU threads or 4 GB or less memory, or when frames are measured
// running slowly. The measured result is remembered per browser so the next load starts light straight away.
// Override for one browser with ?perf=lite or ?perf=full in the address; ?perf=auto goes back to detection.
const KEY='whatix-perf',root=document.documentElement;
const read=()=>{try{return localStorage.getItem(KEY)||'';}catch{return '';}};
const save=value=>{try{localStorage.setItem(KEY,value);}catch{}};
const apply=tier=>{if(tier==='lite')root.dataset.perf='lite';else delete root.dataset.perf;};
export const isLite=()=>root.dataset.perf==='lite';

// Median gap between frames once the page has settled; above 30 ms (under ~33 fps) the effects are too heavy.
function probe(){
 const gaps=[];let last=0;
 const tick=now=>{
  if(document.hidden){last=0;gaps.length=0;}else{if(last)gaps.push(now-last);last=now;}
  if(gaps.length<120)return requestAnimationFrame(tick);
  gaps.sort((a,b)=>a-b);
  if(gaps[60]>30){apply('lite');save('lite');}
 };
 setTimeout(()=>requestAnimationFrame(tick),2500);
}

const asked=new URLSearchParams(location.search).get('perf');
if(asked==='lite'||asked==='full')save('forced-'+asked);else if(asked==='auto')save('');
const stored=read();
const weak=(navigator.hardwareConcurrency||8)<=4||(navigator.deviceMemory||8)<=4;
if(stored.startsWith('forced-'))apply(stored.slice(7));
else if(stored==='lite'||weak)apply('lite');
else probe();
