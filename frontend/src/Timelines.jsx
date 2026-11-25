import {useEffect,useRef} from 'react';
// Sign-in backdrop: glowing green strands that fan out from behind the centre of the card and branch like a tree
// of timelines. Every strand is a real string: a chain of nodes under tension, pinned at the root and the far end,
// so brushing it with the pointer plucks it, the wave runs along it and into its branches, and it rings down.
// `anchor` is a ref to the element the strands are tied behind (the card).
const TAU=Math.PI*2,SEG=26;
const TENSION=1500,HOME=26,DAMP=2.6;// wave speed along the string, pull back to rest, ring-down
const TOUCH_R=64,PLUCK=16,PART_R=30,PART=1400,MAX_PULL=70;
const GROW_MS=1700;
export default function Timelines({anchor}){
 const canvas=useRef(null);
 useEffect(()=>{
  const el=canvas.current,ctx=el.getContext('2d');if(!ctx)return;
  const still=matchMedia('(prefers-reduced-motion: reduce)');
  let w=0,h=0,ax=0,ay=0,reach=0,built=0,strands=[],pulses=[],fx=new Float32Array(0),fy=new Float32Array(0);
  let frame=0,last=0,born=0,pos=null,lastMove=null,vel={x:0,y:0},glow=0,want=0,glowGrad=null,coreGrad=null,heart=null;

  // One string, laid out from (x,y) along heading `a` with a slowly wandering curl. Coordinates are relative to the anchor.
  function strand(x,y,a,n,depth,parent,pk){
   const arr=()=>new Float32Array(n);
   const s={n,m:n,depth,parent,pk,rx:arr(),ry:arr(),nx:arr(),ny:arr(),ha:arr(),rd:arr(),dx:arr(),dy:arr(),vx:arr(),vy:arr(),px:arr(),py:arr(),
    phase:Math.random()*TAU,sway:.25+Math.random()*.35,energy:0};
   let curl=0;
   for(let i=0;i<n;i++){
    s.rx[i]=x;s.ry[i]=y;s.ha[i]=a;s.rd[i]=Math.hypot(x,y);s.nx[i]=-Math.sin(a);s.ny[i]=Math.cos(a);
    curl=Math.max(-.07,Math.min(.07,curl*.92+(Math.random()-.5)*.035));a+=curl;x+=Math.cos(a)*SEG;y+=Math.sin(a)*SEG;}
   strands.push(s);return s;
  }
  function build(){
   strands=[];
   const n=Math.ceil(reach/SEG)+2,count=w<640?11:16,turn=Math.random()*TAU;
   for(let i=0;i<count;i++){
    const trunk=strand(0,0,turn+(i+(Math.random()-.5)*.5)/count*TAU,n,0,null,0);
    const forks=1+(Math.random()<.6?1:0);
    for(let f=0;f<forks;f++){
     const k=4+Math.floor(Math.random()*n*.4),side=Math.random()<.5?-1:1;
     const b=strand(trunk.rx[k],trunk.ry[k],trunk.ha[k]+side*(.3+Math.random()*.45),n-k+4,1,trunk,k);
     if(b.n>12&&Math.random()<.5){const j=3+Math.floor(Math.random()*b.n*.4);strand(b.rx[j],b.ry[j],b.ha[j]-side*(.3+Math.random()*.4),b.n-j,2,b,j);}
    }
   }
   fx=new Float32Array(n+6);fy=new Float32Array(n+6);
   pulses=Array.from({length:w<640?6:10},()=>({s:strands[Math.floor(Math.random()*strands.length)],u:Math.random()*n*.6,v:6+Math.random()*9}));
  }
  function place(){
   const a=anchor?.current;ax=a?a.offsetLeft+a.offsetWidth/2:w/2;ay=a?a.offsetTop+a.offsetHeight/2:h/2;
   reach=Math.max(Math.hypot(ax,ay),Math.hypot(w-ax,ay),Math.hypot(ax,h-ay),Math.hypot(w-ax,h-ay))+60;
   const ramp=(rgb,stops)=>{const g=ctx.createRadialGradient(ax,ay,0,ax,ay,reach);for(const [at,a] of stops)g.addColorStop(at,`rgba(${rgb},${a})`);return g;};
   glowGrad=ramp('60,255,150',[[0,.04],[.1,.12],[.45,.08],[1,.035]]);
   coreGrad=ramp('165,255,205',[[0,.45],[.1,.95],[.5,.6],[1,.28]]);
   heart=ctx.createRadialGradient(ax,ay,0,ax,ay,200);heart.addColorStop(0,'rgba(80,255,170,.2)');heart.addColorStop(1,'rgba(80,255,170,0)');
  }
  function size(){
   const dpr=Math.min(2,devicePixelRatio||1);w=innerWidth;h=innerHeight;el.width=w*dpr;el.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
   place();if(reach>built){build();built=reach*1.15;}
   if(still.matches){pose(0,true);paint(0,1,true);}else kick();
  }
  const kick=()=>{if(!frame)frame=requestAnimationFrame(step);};

  // Pointer forces, then the string itself: each node is pulled toward the line between its neighbours.
  function simulate(dt){
   const speed=Math.hypot(vel.x,vel.y),drive=speed>15?PLUCK*Math.min(1.6,.5+speed/900)*dt:0;
   for(const s of strands){
    const {n,dx,dy,vx,vy,px,py}=s;
    if(pos)for(let i=1;i<n-1;i++){
     const ox=px[i]-pos.x,oy=py[i]-pos.y;if(ox>TOUCH_R||ox<-TOUCH_R||oy>TOUCH_R||oy<-TOUCH_R)continue;
     const d=Math.hypot(ox,oy);if(d>=TOUCH_R)continue;
     const f=(1-d/TOUCH_R)**2;vx[i]+=vel.x*f*drive;vy[i]+=vel.y*f*drive;// dragged along the pointer's path
     if(d<PART_R){const p=(1-d/PART_R)*PART*dt/(d+1);vx[i]+=ox*p;vy[i]+=oy*p;}// and bent around the fingertip
    }
    const hdt=dt/2;
    for(let sub=0;sub<2;sub++){
     for(let i=1;i<n-1;i++){
      vx[i]+=(TENSION*(dx[i-1]+dx[i+1]-2*dx[i])-HOME*dx[i]-DAMP*vx[i])*hdt;
      vy[i]+=(TENSION*(dy[i-1]+dy[i+1]-2*dy[i])-HOME*dy[i]-DAMP*vy[i])*hdt;}
     for(let i=1;i<n-1;i++){dx[i]+=vx[i]*hdt;dy[i]+=vy[i]*hdt;}
    }
    let peak=0;
    for(let i=1;i<n-1;i++){const len=Math.hypot(dx[i],dy[i]);if(len>MAX_PULL){dx[i]*=MAX_PULL/len;dy[i]*=MAX_PULL/len;}if(len>peak)peak=len;}
    s.energy=Math.min(1,peak/40);
   }
  }
  // Where every node is right now: rest + idle sway + pluck. A branch's root rides on its parent's node.
  function pose(t,calm){
   for(const s of strands){
    const {n,px,py}=s;
    if(s.parent){s.dx[0]=s.parent.px[s.pk]-ax-s.rx[0];s.dy[0]=s.parent.py[s.pk]-ay-s.ry[0];}
    for(let i=0;i<n;i++){
     const sw=i&&!calm?Math.sin(t*s.sway+s.phase+i*.2)*Math.min(1,i/10)*(6+s.depth*2):0;
     px[i]=ax+s.rx[i]+s.nx[i]*sw+s.dx[i];py[i]=ay+s.ry[i]+s.ny[i]*sw+s.dy[i];}
   }
  }
  function trace(xs,ys,m){
   ctx.beginPath();ctx.moveTo(xs[0],ys[0]);
   for(let i=1;i<m-1;i++)ctx.quadraticCurveTo(xs[i],ys[i],(xs[i]+xs[i+1])/2,(ys[i]+ys[i+1])/2);
   ctx.lineTo(xs[m-1],ys[m-1]);ctx.stroke();
  }
  function paint(t,grow,calm){
   ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;ctx.clearRect(0,0,w,h);
   ctx.globalCompositeOperation='lighter';ctx.lineCap='round';ctx.lineJoin='round';
   const limit=(1-(1-grow)**3)*built;// strands shoot out from behind the card on arrival
   ctx.globalAlpha=Math.min(1,grow*2);ctx.fillStyle=heart;ctx.fillRect(ax-200,ay-200,400,400);
   for(const s of strands){
    const {px,py}=s;let m=0;while(m<s.n&&s.rd[m]<=limit)m++;s.m=m;if(m<2)continue;
    ctx.globalAlpha=Math.min(1,(s.depth?.55:.8)+s.energy*.6);
    ctx.strokeStyle=glowGrad;ctx.lineWidth=(s.depth?7:10)+s.energy*6;trace(px,py,m);
    ctx.strokeStyle=coreGrad;
    const fibres=s.depth?2:3,spread=s.depth?3:4.5;
    for(let f=0;f<fibres;f++){// fibres twisting round the strand, tight at the root and looser further out
     for(let i=0;i<m;i++){
      const a=i?i-1:0,b=i<s.n-1?i+1:i,tx=px[b]-px[a],ty=py[b]-py[a],l=Math.hypot(tx,ty)||1;
      const o=(1+Math.min(1,i/14)*spread)*Math.sin(i*.5+s.phase+f*TAU/fibres+t*.9);
      fx[i]=px[i]-ty/l*o;fy[i]=py[i]+tx/l*o;}
     ctx.lineWidth=(f?.8:1.3)+s.energy*.7;trace(fx,fy,m);
    }
   }
   if(pos&&glow>.01){// strands brighten under the pointer
    const g=ctx.createRadialGradient(pos.x,pos.y,0,pos.x,pos.y,180);
    g.addColorStop(0,`rgba(215,255,232,${.85*glow})`);g.addColorStop(1,'rgba(90,255,170,0)');
    ctx.globalAlpha=1;ctx.strokeStyle=g;ctx.lineWidth=2.4;
    for(const s of strands)if(s.m>1)trace(s.px,s.py,s.m);
   }
   if(calm)return;
   for(const p of pulses){// sparks of light running outward
    const s=p.s,i=Math.floor(p.u);if(i>=s.m-1)continue;
    const k=p.u-i,x=s.px[i]+(s.px[i+1]-s.px[i])*k,y=s.py[i]+(s.py[i+1]-s.py[i])*k,fade=Math.max(0,1-p.u/s.n);
    ctx.globalAlpha=fade*.16;ctx.fillStyle='rgb(90,255,170)';ctx.beginPath();ctx.arc(x,y,6,0,TAU);ctx.fill();
    ctx.globalAlpha=fade*.9;ctx.fillStyle='rgb(220,255,235)';ctx.beginPath();ctx.arc(x,y,1.5,0,TAU);ctx.fill();
   }
  }
  function step(now){
   frame=0;if(still.matches){pose(0,true);paint(0,1,true);last=0;return;}
   const dt=Math.min(.034,last?(now-last)/1000:1/60),t=now/1000;last=now;if(!born)born=now;
   glow+=(want-glow)*.12;
   simulate(dt);vel.x*=.86;vel.y*=.86;
   for(const p of pulses){p.u+=p.v*dt;if(p.u>=p.s.n-1){p.s=strands[Math.floor(Math.random()*strands.length)];p.u=0;p.v=6+Math.random()*9;}}
   pose(t,false);paint(t,Math.min(1,(now-born)/GROW_MS),false);
   kick();
  }
  const move=e=>{
   const now=e.timeStamp;
   if(lastMove&&now>lastMove.t){const k=1000/Math.max(8,now-lastMove.t);// px/s, smoothed
    vel={x:vel.x*.5+(e.clientX-lastMove.x)*k*.5,y:vel.y*.5+(e.clientY-lastMove.y)*k*.5};}
   lastMove={x:e.clientX,y:e.clientY,t:now};pos={x:e.clientX,y:e.clientY};want=1;};
  const down=e=>{lastMove={x:e.clientX,y:e.clientY,t:e.timeStamp};};// a new touch must not read as a leap from the last one
  const leave=()=>{want=0;lastMove=null;pos=null;vel={x:0,y:0};};
  const up=e=>{if(e.pointerType!=='mouse')leave();};
  const settle=()=>{place();if(still.matches){pose(0,true);paint(0,1,true);}};
  const motion=()=>{last=0;size();};
  size();
  const watch=anchor?.current&&typeof ResizeObserver!=='undefined'?new ResizeObserver(settle):null;watch?.observe(anchor.current);
  addEventListener('pointermove',move,{passive:true});addEventListener('pointerdown',down,{passive:true});
  addEventListener('pointerup',up,{passive:true});addEventListener('pointercancel',leave);
  addEventListener('resize',size);addEventListener('blur',leave);
  document.documentElement.addEventListener('pointerleave',leave);still.addEventListener?.('change',motion);
  return ()=>{cancelAnimationFrame(frame);watch?.disconnect();
   removeEventListener('pointermove',move);removeEventListener('pointerdown',down);removeEventListener('pointerup',up);removeEventListener('pointercancel',leave);
   removeEventListener('resize',size);removeEventListener('blur',leave);
   document.documentElement.removeEventListener('pointerleave',leave);still.removeEventListener?.('change',motion);};
 },[anchor]);
 return <canvas ref={canvas} className="constellation" aria-hidden="true"/>;
}
