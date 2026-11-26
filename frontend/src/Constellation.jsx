import {useEffect,useRef} from 'react';
import {isLite} from './perf.js';
// The background dot grid, drawn on canvas so dots can react to the cursor like grass in wind: the pointer's
// velocity pushes nearby dots along its path, springs pull them home with a soft wobble, and the constellation
// lines bend with them. The resting grid is cached; only disturbed dots are simulated, and the frame loop stops
// once everything settles. `masked` reproduces the sign-in screen's centred fade of the grid.
const GRID=16,OFFSET=8,STEP=2,RADIUS=170,LINK=GRID*STEP*1.5,REACH=95;
const WIND_R=130,WIND=.32,PUSH=900,SPRING=55,DAMP=7.5,MAX=16,DOT=.13;
export default function Constellation({masked=false}){
 const canvas=useRef(null);
 useEffect(()=>{
  const el=canvas.current,ctx=el.getContext('2d');if(!ctx)return;
  const still=matchMedia('(prefers-reduced-motion: reduce)');
  const cache=document.createElement('canvas'),cctx=cache.getContext('2d');
  const moving=new Map();// grid index → {dx,dy,vx,vy}
  let w=0,h=0,dpr=1,cols=0,rows=0,frame=0,last=0,target=null,pos=null,glow=0,want=0,vel={x:0,y:0},lastMove=null;
  const alphaAt=(x,y)=>{if(!masked)return 1;const r=Math.hypot((x-w/2)/(w/2*Math.SQRT2),(y-h/2)/(h/2*Math.SQRT2));return r<.3?1:r>.8?0:(.8-r)/.5;};
  function size(){
   dpr=Math.min(2,devicePixelRatio||1);w=innerWidth;h=innerHeight;cols=Math.ceil(w/GRID)+1;rows=Math.ceil(h/GRID)+1;
   for(const c of [el,cache]){c.width=w*dpr;c.height=h*dpr;}
   ctx.setTransform(dpr,0,0,dpr,0,0);cctx.setTransform(dpr,0,0,dpr,0,0);cctx.clearRect(0,0,w,h);
   for(let gx=0;gx<cols;gx++)for(let gy=0;gy<rows;gy++){const x=gx*GRID+OFFSET,y=gy*GRID+OFFSET,a=alphaAt(x,y)*DOT;
    if(a>.004){cctx.fillStyle=`rgba(168,233,189,${a})`;cctx.beginPath();cctx.arc(x,y,1,0,Math.PI*2);cctx.fill();}}
   moving.clear();paint();
  }
  const kick=()=>{if(!frame)frame=requestAnimationFrame(step);};
  const at=i=>{const gx=i%cols,gy=(i-gx)/cols,m=moving.get(i);return {x:gx*GRID+OFFSET+(m?m.dx:0),y:gy*GRID+OFFSET+(m?m.dy:0)};};
  function step(now){
   frame=0;const dt=Math.min(.05,last?(now-last)/1000:1/60);last=now;
   if(target){const k=still.matches?1:.2;pos=pos?{x:pos.x+(target.x-pos.x)*k,y:pos.y+(target.y-pos.y)*k}:{...target};}
   glow+=(want-glow)*(still.matches?1:.12);if(Math.abs(want-glow)<.005)glow=want;
   if(!still.matches&&pos){
    const speed=Math.hypot(vel.x,vel.y);
    if(speed>20){// wind: along the cursor's path, strongest under it, plus a gentle outward gust
     const g0=Math.max(0,Math.floor((pos.x-WIND_R-OFFSET)/GRID)),g1=Math.min(cols-1,Math.ceil((pos.x+WIND_R-OFFSET)/GRID));
     const h0=Math.max(0,Math.floor((pos.y-WIND_R-OFFSET)/GRID)),h1=Math.min(rows-1,Math.ceil((pos.y+WIND_R-OFFSET)/GRID));
     for(let gx=g0;gx<=g1;gx++)for(let gy=h0;gy<=h1;gy++){
      const x=gx*GRID+OFFSET,y=gy*GRID+OFFSET,d=Math.hypot(x-pos.x,y-pos.y);if(d>=WIND_R)continue;
      const f=(1-d/WIND_R)**2,i=gx+gy*cols,m=moving.get(i)||{dx:0,dy:0,vx:0,vy:0},out=Math.min(1,speed/1200)*PUSH*f*dt/(d+8);
      m.vx+=vel.x*f*WIND*dt*10+(x-pos.x)*out;m.vy+=vel.y*f*WIND*dt*10+(y-pos.y)*out;moving.set(i,m);}
    }
    vel.x*=.86;vel.y*=.86;
    for(const [i,m] of moving){// damped spring home
     m.vx+=(-SPRING*m.dx-DAMP*m.vx)*dt;m.vy+=(-SPRING*m.dy-DAMP*m.vy)*dt;m.dx+=m.vx*dt;m.dy+=m.vy*dt;
     const len=Math.hypot(m.dx,m.dy);if(len>MAX){m.dx*=MAX/len;m.dy*=MAX/len;}
     if(len<.05&&Math.hypot(m.vx,m.vy)<.5)moving.delete(i);}
   }else moving.clear();
   paint();
   const settling=target&&pos&&(Math.abs(target.x-pos.x)>.3||Math.abs(target.y-pos.y)>.3);
   if(moving.size||settling||glow!==want||Math.hypot(vel.x,vel.y)>20)kick();else last=0;
  }
  function paint(){
   ctx.clearRect(0,0,w,h);ctx.drawImage(cache,0,0,w,h);
   for(const [i,m] of moving){// lift displaced dots off the cached grid and redraw them where the wind put them
    const gx=i%cols,gy=(i-gx)/cols,x=gx*GRID+OFFSET,y=gy*GRID+OFFSET,a=alphaAt(x,y);
    ctx.clearRect(x-1.6,y-1.6,3.2,3.2);
    const lift=Math.min(1,Math.hypot(m.dx,m.dy)/MAX);
    ctx.fillStyle=`rgba(168,233,189,${a*(DOT+lift*.35)})`;ctx.beginPath();ctx.arc(x+m.dx,y+m.dy,1+lift*.6,0,Math.PI*2);ctx.fill();}
   if(!pos||glow<.01)return;
   const pts=[],s=GRID*STEP;
   for(let gx=Math.max(0,Math.ceil((pos.x-RADIUS-OFFSET)/s)*STEP);gx<cols&&gx*GRID+OFFSET<=pos.x+RADIUS;gx+=STEP)
    for(let gy=Math.max(0,Math.ceil((pos.y-RADIUS-OFFSET)/s)*STEP);gy<rows&&gy*GRID+OFFSET<=pos.y+RADIUS;gy+=STEP){
     const p=at(gx+gy*cols),d=Math.hypot(p.x-pos.x,p.y-pos.y);if(d<RADIUS)pts.push({...p,d,a:(1-d/RADIUS)**1.6*glow*alphaAt(p.x,p.y)});}
   ctx.lineCap='round';ctx.lineWidth=.8;
   for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++){
    const p=pts[i],q=pts[j];if(Math.hypot(p.x-q.x,p.y-q.y)>LINK)continue;
    ctx.strokeStyle=`rgba(168,233,189,${Math.min(p.a,q.a)*.55})`;ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();}
   ctx.lineWidth=1;
   for(const p of pts){
    if(p.d<REACH){ctx.strokeStyle=`rgba(168,233,189,${p.a*.7})`;ctx.beginPath();ctx.moveTo(pos.x,pos.y);ctx.lineTo(p.x,p.y);ctx.stroke();}
    ctx.fillStyle=`rgba(200,245,215,${Math.min(1,p.a*1.3)})`;ctx.beginPath();ctx.arc(p.x,p.y,1+p.a*1.6,0,Math.PI*2);ctx.fill();}
  }
  const move=e=>{if(e.pointerType==='touch'||isLite())return;// lite machines skip the canvas work entirely
   const now=e.timeStamp;if(lastMove&&now>lastMove.t){const k=1000/Math.max(8,now-lastMove.t);// px/s, smoothed
    vel={x:vel.x*.5+(e.clientX-lastMove.x)*k*.5,y:vel.y*.5+(e.clientY-lastMove.y)*k*.5};}
   lastMove={x:e.clientX,y:e.clientY,t:now};target={x:e.clientX,y:e.clientY};want=1;kick();};
  const leave=()=>{want=0;lastMove=null;kick();};
  size();
  addEventListener('pointermove',move,{passive:true});addEventListener('resize',size);
  document.documentElement.addEventListener('pointerleave',leave);addEventListener('blur',leave);
  return ()=>{cancelAnimationFrame(frame);removeEventListener('pointermove',move);removeEventListener('resize',size);
   document.documentElement.removeEventListener('pointerleave',leave);removeEventListener('blur',leave);};
 },[masked]);
 return <canvas ref={canvas} className="constellation" aria-hidden="true"/>;
}
