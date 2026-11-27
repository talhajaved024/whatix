import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { isPublicAddress } from '../src/media-fetch.js';

// Regression tests for the 2026-11 security audit fixes (audit/02-SECURITY-AUDIT.md).
test('media links may only reach public addresses',()=>{
  for(const address of ['127.0.0.1','10.1.2.3','172.18.0.1','192.168.1.10','169.254.169.254','100.64.0.1','0.0.0.0','::1','fe80::1','fd00::1','::ffff:127.0.0.1'])
    assert.equal(isPublicAddress(address),false,address);
  for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(isPublicAddress(address),true,address);
  assert.equal(isPublicAddress('not-an-ip'),false);
});

test('send bodies, limits, refresh replay, password change and stream caps',{timeout:60000},async t=>{
  const forwarded=[];
  const http=createServer((req,res)=>{
    let raw='';req.on('data',chunk=>raw+=chunk);
    req.on('end',()=>{
      const url=new URL(req.url,'http://waha');
      if(url.pathname==='/api/sessions/hard-test')return res.end(JSON.stringify({name:'hard-test',status:'WORKING',me:{id:'15550003333@c.us'}}));
      if(/^\/api\/send(Text|Image|File|Video|Voice|Seen)$/.test(url.pathname)){
        const body=JSON.parse(raw||'{}');forwarded.push({path:url.pathname,body});
        res.setHeader('Content-Type','application/json');
        return res.end(JSON.stringify({id:'true_'+body.chatId+'_M'+forwarded.length,fromMe:true}));
      }
      if(url.pathname==='/api/hard-test/labels')return res.end('[]');
      res.writeHead(404);res.end('{}');
    });
  });
  const waha=new WebSocketServer({server:http});
  http.listen(0,'127.0.0.1');await once(http,'listening');
  t.after(()=>{waha.close();http.close();});
  const directory=await mkdtemp(join(tmpdir(),'wa-hardening-'));
  const password=randomUUID();
  const clock=`
    import {mock} from 'node:test';
    mock.timers.enable({apis:['Date'],now:Date.now()});
    process.on('message', ms => { mock.timers.tick(ms); process.send('advanced'); });
  `;
  const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(clock),'src/server.js'],{env:{...process.env,
    PORT:'0',NODE_ENV:'test',AWAY_REPLIES_ENABLED:'false',BUSY_REPLIES_ENABLED:'false',TRUST_PROXY:'1',
    ADMIN_USERNAME:'tester',ADMIN_PASSWORD:password,USER_WORKBOOK_PATH:join(directory,'users.xlsx'),WHATIX_DB_PATH:join(directory,'whatix.db'),
    APP_USERS_JSON:JSON.stringify(['alice','carol','Dave'].map(username=>({username,password}))),JWT_ACCESS_SECRET:randomUUID(),JWT_REFRESH_SECRET:randomUUID(),
    WAHA_API_KEY:'fixture',WAHA_URL:'http://127.0.0.1:'+http.address().port,WAHA_SESSION:'hard-test'},stdio:['ignore','pipe','inherit','ipc']});
  t.after(async()=>{
    if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
    await rm(directory,{recursive:true,force:true});
  });
  const [line]=await once(createInterface({input:child.stdout}),'line');
  const base='http://127.0.0.1:'+line.match(/listening on (\d+)/)[1]+'/api';
  const advance=async ms=>{const done=once(child,'message');child.send(ms);await done;};
  const cookie=response=>response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  let ip=0;
  const login=(username='tester',pass=password)=>fetch(base+'/auth/login',{method:'POST',
    headers:{'Content-Type':'application/json','X-Forwarded-For':'198.51.100.'+(++ip%250)},
    body:JSON.stringify({credentials:Buffer.from(JSON.stringify({username,password:pass})).toString('base64')})});
  const call=(Cookie,method,path,body,headers={})=>fetch(base+path,{method,headers:{Cookie,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});

  // API responses forbid scripts and framing.
  const health=await fetch(base+'/health');
  assert.match(health.headers.get('content-security-policy'),/default-src 'none'/);
  assert.match(health.headers.get('content-security-policy'),/frame-ancestors 'none'/);

  // Large bodies: small everywhere, and media routes read them only after sign-in.
  const big=JSON.stringify({credentials:'x',pad:'a'.repeat(2*1024*1024)});
  assert.equal((await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:big})).status,413);
  assert.equal((await fetch(base+'/sendImage',{method:'POST',headers:{'Content-Type':'application/json'},body:big})).status,401);

  const admin=cookie(await login());
  const users=(await (await call(admin,'GET','/admin/users')).json()).users;
  const id=name=>users.find(u=>u.username===name).id;

  // Usernames: no spaces and no capital letters when an account is added or renamed.
  for(const username of ['Has Space','trailing ',' leading','tab\tname','CapitalName','camelCase','ÄLPHA'])
    for(const [method,path] of [['POST','/admin/users'],['PATCH','/admin/users/'+id('carol')]]){
      const response=await call(admin,method,path,method==='POST'?{username,password,name:'X',phoneNumber:923001234567}:{username});
      assert.equal(response.status,400,method+' '+JSON.stringify(username));
      assert.match((await response.json()).error,/no spaces and no capital letters/);
    }
  assert.equal((await call(admin,'GET','/admin/username-availability?username=Upper')).status,400);
  // Registration: name, username, password and phone are all required.
  const full={username:'new.user_1',password,name:'New user',phoneNumber:923001234567};
  for(const [key,label] of [['name','name'],['username','username'],['password','password'],['phoneNumber','phone number']]){
    for(const empty of [undefined,null,'','   ']){
      const body={...full,[key]:empty};
      if(empty===undefined)delete body[key];
      const response=await call(admin,'POST','/admin/users',body);
      assert.equal(response.status,400,key+' '+JSON.stringify(empty));
      assert.match((await response.json()).error,new RegExp('Required: '+label));
    }
  }
  for(const phoneNumber of ['923001234567',123,0,-923001234567,1234567890123456])
    assert.equal((await call(admin,'POST','/admin/users',{...full,phoneNumber})).status,400,String(phoneNumber));
  const made=await call(admin,'POST','/admin/users',full);
  assert.equal(made.status,201);
  const madeId=(await made.json()).id;
  assert.equal((await call(admin,'PATCH','/admin/users/'+madeId,{username:'renamed-user'})).status,200);
  // Updates: name, username and phone cannot be cleared; the password stays optional.
  for(const body of [{name:''},{name:'  '},{username:''},{phoneNumber:null},{phoneNumber:''}])
    assert.equal((await call(admin,'PATCH','/admin/users/'+madeId,body)).status,400,JSON.stringify(body));
  assert.equal((await call(admin,'PATCH','/admin/users/'+madeId,{name:'Renamed'})).status,200);
  // An older account (capitals, no phone) still signs in; saving it requires adding a phone.
  assert.equal((await call(admin,'PATCH','/admin/users/'+id('Dave'),{name:'Dave Smith'})).status,400);
  assert.equal((await call(admin,'PATCH','/admin/users/'+id('Dave'),{name:'Dave Smith',phoneNumber:447700900456})).status,200);
  const phone={'X-Campaign-Phone':'15550003333'};
  assert.equal((await call(admin,'PUT','/campaign-grants/'+id('alice'),{labels:null},phone)).status,204);
  assert.equal((await call(admin,'POST','/campaign-contacts',{username:'alice',phoneNumber:923000000101},phone)).status,201);

  // Only the fields WAHA needs are forwarded; a large media body still works.
  const before=forwarded.length;
  const text=await call(admin,'POST','/sendText',{session:'hard-test',chatId:'923000000101@c.us',id:'923000000101@c.us',text:'hello',
    linkPreview:true,mentions:null,reply_to:null,extraField:'x',webhook:{url:'http://evil'}});
  assert.equal(text.status,200);
  assert.deepEqual(Object.keys(forwarded.at(-1).body).sort(),['chatId','linkPreview','mentions','reply_to','session','text']);
  const data=Buffer.alloc(3*1024*1024,7).toString('base64');
  assert.equal((await call(admin,'POST','/sendImage',{session:'hard-test',chatId:'923000000101@c.us',caption:'c',
    file:{mimetype:'image/jpeg',filename:'a.jpg',data}})).status,200);
  assert.equal(forwarded.at(-1).body.file.data.length,data.length);
  // A media link to an internal address is refused and never reaches WAHA.
  for(const url of ['http://127.0.0.1:3000/api/sessions','http://169.254.169.254/latest/meta-data/','http://[::1]/','http://10.0.0.5/x.jpg','file:///etc/passwd','http://localhost/x.jpg']){
    const sent=forwarded.length;
    const response=await call(admin,'POST','/sendImage',{session:'hard-test',chatId:'923000000101@c.us',file:{mimetype:'image/jpeg',filename:'x.jpg',url}});
    assert.equal(response.status,422,url);
    assert.equal(forwarded.length,sent,url);
  }
  const recipients=Array.from({length:12},(_,i)=>String(923000000200+i));
  assert.equal((await call(admin,'POST','/broadcasts',{id:randomUUID(),recipients,kind:'image',text:'',
    file:{mimetype:'image/jpeg',filename:'x.jpg',url:'http://127.0.0.1/x.jpg'}})).status,422);
  assert.equal(forwarded.length-before,2);

  // A regular user can quote only the chat they are writing to.
  const alice=cookie(await login('alice'));
  assert.equal((await call(alice,'POST','/sendText',{session:'hard-test',chatId:'923000000101@c.us',text:'hi',reply_to:'false_923451112233@c.us_ABC'})).status,403);
  assert.equal((await call(alice,'POST','/sendText',{session:'hard-test',chatId:'923000000101@c.us',text:'hi',reply_to:'false_923000000101@c.us_ABC'})).status,200);

  // Direct sends are paced per person.
  let limited=0;
  for(let i=0;i<125 && !limited;i++){
    const response=await call(alice,'POST','/sendText',{session:'hard-test',chatId:'923000000101@c.us',text:'n'+i});
    if(response.status===429)limited=i;
  }
  assert.ok(limited>=100 && limited<=120,'limited at '+limited);
  await advance(61000);
  assert.equal((await call(alice,'POST','/sendText',{session:'hard-test',chatId:'923000000101@c.us',text:'later'})).status,200);

  // Broadcasts: at most three unfinished jobs per person.
  const many=Array.from({length:40},(_,i)=>String(923000000300+i));
  for(let i=0;i<3;i++)assert.equal((await call(admin,'POST','/broadcasts',{id:randomUUID(),recipients:many,kind:'text',text:'b'+i})).status,202);
  assert.equal((await call(admin,'POST','/broadcasts',{id:randomUUID(),recipients:many,kind:'text',text:'b4'})).status,429);

  // Live streams: the ninth closes the oldest.
  const streams=[];
  for(let i=0;i<9;i++){
    const response=await fetch(base+'/incoming-text',{headers:{Cookie:alice}});
    const reader=response.body.getReader();await reader.read();streams.push(reader);
  }
  while(!(await streams[0].read()).done){/* the oldest stream is closed by the server */}
  for(const reader of streams.slice(1))await reader.cancel();

  // Refresh replay: inside the grace window the session continues; later, a
  // replayed token ends it, and the account can sign in again (no 409 lockout).
  const carolLogin=await login('carol');
  const first=cookie(carolLogin);
  const rotated=cookie(await call(first,'POST','/auth/refresh'));
  assert.equal((await call(first,'POST','/auth/refresh')).status,200);
  await advance(31000);
  assert.equal((await call(first,'POST','/auth/refresh')).status,401);
  assert.equal((await call(rotated,'GET','/auth/me')).status,401);
  const again=await login('carol');
  assert.equal(again.status,200);

  // Password change: current password required; the session ends; the new password works.
  const session=cookie(again);
  assert.equal((await call(session,'POST','/auth/password',{currentPassword:'wrong-password',newPassword:'BrandNew-pass-1'})).status,403);
  assert.equal((await call(session,'POST','/auth/password',{currentPassword:password,newPassword:'short'})).status,400);
  assert.equal((await call(session,'POST','/auth/password',{currentPassword:password,newPassword:'BrandNew-pass-1'})).status,204);
  assert.equal((await call(session,'GET','/auth/me')).status,401);
  assert.equal((await login('carol')).status,401);
  assert.equal((await login('carol','BrandNew-pass-1')).status,200);

  // Per-account throttle: failures spread over many addresses still stop.
  let blockedAt=0;
  for(let i=1;i<=32 && !blockedAt;i++)if((await login('alice','wrong-'+i)).status===429)blockedAt=i;
  assert.equal(blockedAt,31);
});
