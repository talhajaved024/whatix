import {WebSocket,WebSocketServer} from 'ws';
import {Router} from 'express';

const uiPath='/api/admin/waha-ui';
const workerPath='/api/admin/waha-worker';
const DIRECTORY_TTL_MS=5000;
export const validInboxName=name=>typeof name==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(name);

function publicSession(row){
  return {name:row.name,status:row.status,me:row.me && {id:row.me.id,pushName:row.me.pushName}};
}

export function mountNumberManagement(app,{protectedRoute,adminAccess,base,headers,defaultSession,onSessionDeleted}){
  const guard=[protectedRoute,adminAccess];
  const upstream=(path,options={})=>fetch(base+path,{headers:headers(),redirect:'error',signal:AbortSignal.timeout(20000),...options});
  // Every open tab's number picker asks for this list, so it is shared for a
  // few seconds and concurrent requests wait on one WAHA call. The pairing
  // dashboard asks fresh, and pairing actions or a session status event drop it.
  let known=null,knownAt=0,pending=null;
  async function directory({fresh=false}={}){
    if(!fresh && known && Date.now()-knownAt<DIRECTORY_TTL_MS)return known;
    if(!fresh && pending)return pending;
    const request=(async()=>{
      const response=await upstream('/api/sessions?all=true');
      if(!response.ok)throw Error('WAHA sessions unavailable');
      return (await response.json()).filter(row=>validInboxName(row.name)||row.name===defaultSession).map(publicSession);
    })();
    pending=request;
    try{const rows=await request;if(pending===request){known=rows;knownAt=Date.now();}return rows;}
    finally{if(pending===request)pending=null;}
  }
  directory.invalidate=()=>{known=null;pending=null;};
  app.get('/api/admin/whatsapp-numbers',...guard,async(req,res)=>{
    try{res.json({defaultSession,sessions:await directory()});}
    catch{res.status(502).json({error:'Could not load WhatsApp numbers'});}
  });

  // Keep the bundled dashboard on the Whatix origin. Its static Nuxt bundles
  // use absolute /dashboard/ paths, including for lazy-loaded pages.
  app.use(uiPath,...guard,async(req,res)=>{
    if(req.method!=='GET' || !/^\/(?:[\w.-]+\/)*[\w.-]*$/.test(req.path) || req.path.includes('..'))return res.sendStatus(404);
    const auth={};
    if(process.env.WAHA_DASHBOARD_PASSWORD){
      const login=(process.env.WAHA_DASHBOARD_USERNAME || 'admin')+':'+process.env.WAHA_DASHBOARD_PASSWORD;
      auth.Authorization='Basic '+Buffer.from(login).toString('base64');
    }else if(req.headers.authorization?.startsWith('Basic '))auth.Authorization=req.headers.authorization;
    try{
      const response=await upstream('/dashboard'+req.path,{headers:auth});
      if(response.status===401){
        res.set('WWW-Authenticate','Basic realm="WAHA dashboard"');
        return res.sendStatus(401);
      }
      if(!response.ok)return res.sendStatus(response.status);
      const type=response.headers.get('content-type')||'application/octet-stream';
      res.set('Content-Type',type);
      if(/html|javascript|css|json/i.test(type)){
        let body=(await response.text()).replaceAll('/dashboard/',uiPath+'/');
        if(type.includes('text/html')){
          // The dashboard reads its worker list before starting Vue. The key
          // here is a display placeholder. Express supplies the actual key.
          const setup='<script>localStorage.setItem("servers",JSON.stringify([{id:"whatix",name:"Whatix",connection:{url:location.origin+"'+workerPath+'",key:"whatix-dashboard"}}]))</script>';
          body=body.replace('<head>','<head>'+setup);
        }
        res.end(body);
      }else res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.status(502).send('Could not load the WAHA dashboard');}
  });

  const worker=Router();
  app.use(workerPath,...guard,worker);
  // WAHA's dashboard resolves absolute API paths against the worker origin.
  // Its marker selects the dashboard router; the Whatix login and role checks
  // still authorize every request.
  const direct=Router();
  direct.use(...guard,worker);
  app.use((req,res,next)=>req.get('X-Api-Key')==='whatix-dashboard' ? direct(req,res,next) : next());
  worker.get('/api/sessions',async(req,res)=>{
    try{res.json(await directory({fresh:true}));}catch{res.sendStatus(502);}
  });
  async function forward(req,res){
    try{
      const path=req.path.replace(/\/$/,'');
      let body;
      if(req.method==='POST' && path==='/api/sessions'){
        const name=req.body?.name;
        if(name!=null && name!=='' && !validInboxName(name))return res.status(400).json({message:'Use letters, numbers, hyphens or underscores for the session name.'});
        body=JSON.stringify({name:name||undefined,start:req.body?.start!==false});
      }
      let target=path;
      if(path==='/api/screenshot'){
        if(!validInboxName(req.query.session))return res.sendStatus(400);
        target+='?'+new URLSearchParams({session:req.query.session});
      }
      if(path.endsWith('/auth/request-code')){
        if(!/^\d{6,15}$/.test(String(req.body?.phoneNumber)))return res.sendStatus(400);
        body=JSON.stringify({phoneNumber:String(req.body.phoneNumber)});
      }
      if(req.method==='POST' && /\/auth\/passkey(?:\/confirm)?$/.test(path))body=JSON.stringify(req.body||{});
      const response=await upstream(target,{method:req.method,body,headers:{...headers(),'Content-Type':'application/json',Accept:req.headers.accept||'application/json'}});
      if(req.method!=='GET')directory.invalidate();   // a session was created, started or paired
      res.status(response.status);
      if(!response.ok)return res.json({message:'WAHA declined this request (HTTP '+response.status+').'});
      if(response.status===204)return res.end();
      const type=response.headers.get('content-type')||'application/json';
      if(type.includes('json') && path.startsWith('/api/sessions')){
        // WAHA answers some session calls (DELETE) with 200 and no body: pass that on
        // as it is, instead of failing to parse it after WAHA already did the work.
        const text=await response.text();
        if(!text.trim())return res.end();
        let row=null;try{row=JSON.parse(text);}catch{ /* not JSON: report no session details */ }
        return res.json(row?.name?publicSession(row):{});
      }
      res.set('Content-Type',type).end(Buffer.from(await response.arrayBuffer()));
    }catch{res.status(502).json({message:'Could not reach WAHA'});}
  }
  // The pairing UI probes these optional fields. Process configuration and
  // account photos are unnecessary for pairing a phone.
  worker.get('/api/server/environment',(_req,res)=>res.json({}));
  worker.get('/api/contacts/profile-picture',(_req,res)=>res.json({profilePictureURL:null}));
  worker.get(['/api/version','/api/server/version','/api/server/status'],forward);
  worker.get('/api/sessions/:name([A-Za-z0-9_-]+)',forward);
  worker.post('/api/sessions',forward);
  worker.post('/api/sessions/:name([A-Za-z0-9_-]+)/start',forward);
  // Managing a connected number from the dashboard: log its phone out (to pair
  // another), restart a stuck session, or stop it. The main number included:
  // logging it out is how it is paired to a new phone.
  worker.post('/api/sessions/:name([A-Za-z0-9_-]+)/:action(logout|restart|stop)',forward);
  // Deleting a number. The main number (WAHA_SESSION) carries the whole app
  // (sign-in coverage, Whatix AI, the unprefixed API), so it is refused here.
  worker.delete('/api/sessions/:name([A-Za-z0-9_-]+)',(req,res,next)=>{
    if(req.params.name===defaultSession)
      return res.status(403).json({message:'The main WhatsApp number ('+defaultSession+') cannot be deleted from Whatix. Pair it to a new phone instead, or change WAHA_SESSION first.'});
    // Forget the inbox once WAHA confirms, so a restart does not bring it back.
    res.on('finish',()=>{if(res.statusCode<300)onSessionDeleted?.(req.params.name);});
    next();
  },forward);
  worker.get('/api/:name([A-Za-z0-9_-]+)/auth/qr',forward);
  worker.get('/api/:name([A-Za-z0-9_-]+)/auth/passkey/challenge',forward);
  worker.get('/api/:name([A-Za-z0-9_-]+)/auth/passkey/confirmation',forward);
  worker.post('/api/:name([A-Za-z0-9_-]+)/auth/passkey',forward);
  worker.post('/api/:name([A-Za-z0-9_-]+)/auth/passkey/confirm',forward);
  worker.get('/api/screenshot',forward);
  worker.post('/api/:name([A-Za-z0-9_-]+)/auth/request-code',forward);
  worker.use((_req,res)=>res.status(403).json({message:'This dashboard is for connecting numbers.'}));
  return directory;
}

export function dashboardUpgrade(base,headers){
  const server=new WebSocketServer({noServer:true,maxPayload:4096});
  return (req,socket,head,{authenticate,parseCookies,allowedOrigin,reject})=>{
    if(req.url.split('?')[0]!==workerPath+'/ws')return false;
    if(!allowedOrigin(req.headers.origin)){reject(socket,403,'Forbidden');return true;}
    const auth=authenticate({cookies:parseCookies(req.headers.cookie)});
    if(!auth || auth.user.role==='user'){reject(socket,403,'Forbidden');return true;}
    server.handleUpgrade(req,socket,head,client=>{
      const url=new URL('/ws',base.replace(/^http/,'ws'));
      url.searchParams.set('session','*');
      url.searchParams.set('events','session.status');
      const upstream=new WebSocket(url,{headers:headers()});
      const close=()=>{client.close();upstream.terminate();};
      const unregister=auth.register(close);
      upstream.on('message',raw=>{
        try{
          const {event,session,payload,me}=JSON.parse(raw);
          if(event==='session.status' && client.readyState===WebSocket.OPEN)
            client.send(JSON.stringify({event,session,me:publicSession({me}).me,payload:{status:payload.status}}));
        }catch{}
      });
      upstream.on('error',()=>client.close());
      upstream.on('close',()=>client.close());
      client.on('error',close);
      client.on('close',()=>{unregister();upstream.terminate();});
    });
    return true;
  };
}
