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

test('session ownership, explicit idle renewal and automatic logout', {timeout:15000}, async t => {
  const photoURL='https://example.com/contact.jpg';
  const voiceFile={filename:'note.webm',mimetype:'audio/webm;codecs=opus',data:'AQID'};
  const voiceRequest={session:'photo-test',chatId:'1@c.us',file:voiceFile,convert:true};
  let revokeCalls=0;
  let declineRequests=0;
  const businessLabels=[{id:'1',name:'Existing'},{id:'3',name:'Other'}];
  let chatLabels=[{id:'1'}], labelWrites=0;
  let previousLabels, staleRead=false;
  let replyCount=0,drafts=0,releaseDraft;
  const held=new Promise(resolve=>{releaseDraft=resolve;});
  const http=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/chat'){
      let data='';for await(const chunk of req)data+=chunk;
      const input=JSON.parse(data);
      assert.equal(input.model,'qwen3:4b');
      const turn=JSON.parse(input.messages[1].content);
      if(input.format.required.includes('assessment'))return res.end(JSON.stringify({message:{content:'{"assessment":"requirement"}'}}));
      if(input.format.required.includes('decision'))return res.end(JSON.stringify({message:{content:'{"decision":"qualified"}'}}));
      if(input.format.required.includes('name')){
        const name=turn.message==='Ali Khan'?'Ali Khan':'';
        return res.end(JSON.stringify({message:{content:JSON.stringify({intent:name?'details':'request',evidence:name?'':turn.message,name,query:name?'':'Customer requests website development.'})}}));
      }
      drafts++;
      // Name questions and save confirmations are fixed text, so the first model
      // draft is the repeat-request reply to the 'second' message.
      if(drafts===1){http.emit('drafting');await held;}
      const reply=turn.action.includes('already on file')?'Your request is already on file.':turn.action.includes('representative')?'Your request has been recorded. A representative will contact you.':'May I have your name for the website enquiry?';
      return res.end(JSON.stringify({message:{content:JSON.stringify({reply:(turn.introduceCompany?'Welcome to Brand Matrix, a digital marketing company. ':'')+reply})}}));
    }
    if(url.pathname==='/api/sendText'){
      let data='';for await(const chunk of req)data+=chunk;
      const input=JSON.parse(data);
      assert.equal(input.chatId,'100@lid');
      assert.equal(input.session,'photo-test');
      assert.match(input.text,/^(Welcome to Brand Matrix, your digital marketing partner! Thank you for the details\. May I have your full name|Thank you, Ali Khan\. We have received your requirement|Ali Khan, your request is already on file)[\s\S]*\n\n\*this message is Auto Generated\*$/);
      replyCount++;http.emit('replied');
      return res.end('{}');
    }
    if(['/api/photo-test/lids/77','/api/photo-test/lids/100'].includes(url.pathname)){
      res.setHeader('Content-Type','application/json');
      return res.end(JSON.stringify({pn:'15551234567@c.us'}));
    }
    if(url.pathname==='/api/photo-test/calls/reject'){
      assert.equal(req.method,'POST');
      assert.equal(req.headers['x-api-key'],'fixture');
      let data='';for await(const chunk of req)data+=chunk;
      assert.deepEqual(JSON.parse(data),{id:'ring',from:'77@lid'});
      res.writeHead(++declineRequests===1?503:200);
      return res.end();
    }
    if(url.pathname==='/api/sessions/photo-test/me')return res.end(JSON.stringify({id:'15551234567:3@s.whatsapp.net'}));
    if(url.pathname==='/api/photo-test/lids/pn/15551234567')return res.end(JSON.stringify({lid:'100@lid'}));
    if(url.pathname==='/api/contacts'){
      assert.equal(url.searchParams.get('session'),'photo-test');
      assert.equal(req.headers['x-api-key'],'fixture');
      const contactId=url.searchParams.get('contactId');
      const name=contactId==='1@c.us'?'Saved contact':'+1 555 123 4567';
      return res.end(JSON.stringify({name,pushname:'Profile name'}));
    }
    if(url.pathname==='/api/contacts/check-exists'){
      assert.equal(url.searchParams.get('session'),'photo-test');
      assert.equal(req.headers['x-api-key'],'fixture');
      const exists=url.searchParams.get('phone')==='123456789';
      res.setHeader('Content-Type','application/json');
      return res.end(JSON.stringify({numberExists:exists,chatId:exists?'987654321@lid':null}));
    }
    if(url.pathname.startsWith('/api/photo-test/labels')){
      assert.equal(req.headers['x-api-key'],'fixture');
      res.setHeader('Content-Type','application/json');
      if(url.pathname==='/api/photo-test/labels'){
        if(req.method==='GET')return res.end(JSON.stringify(businessLabels));
        let data='';for await(const chunk of req)data+=chunk;
        assert.deepEqual(JSON.parse(data),{name:'Customers',color:4});
        const label={id:'2',name:'Customers',color:4,type:5};
        businessLabels.push(label);return res.end(JSON.stringify(label));
      }
      assert.equal(decodeURIComponent(url.pathname),'/api/photo-test/labels/chats/987654321@lid');
      if(req.method==='GET'){
        const snapshot=staleRead?previousLabels:chatLabels;
        staleRead=false;
        return res.end(JSON.stringify(snapshot));
      }
      assert.equal(req.method,'PUT');
      let data='';for await(const chunk of req)data+=chunk;
      previousLabels=chatLabels;staleRead=true;
      chatLabels=JSON.parse(data).labels;labelWrites++;
      return res.end('{}');
    }
    if(req.method==='DELETE'){
      assert.equal(url.pathname,'/api/photo-test/chats/1%40c.us/messages/sent-note');
      assert.equal(req.headers['x-api-key'],'fixture');
      res.writeHead(++revokeCalls===1?422:204);
      return res.end();
    }
    if(url.pathname==='/api/sendVoice'){
      let body='';
      for await(const part of req)body+=part;
      assert.deepEqual(JSON.parse(body),voiceRequest);
      assert.equal(req.headers['x-api-key'],'fixture');
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end('{"id":"sent-note"}');
    }
    if(url.pathname==='/api/files/note.ogg'){
      assert.equal(req.headers.range,'bytes=0-2');
      res.writeHead(206,{'Content-Type':'application/ogg','Content-Range':'bytes 0-2/10'});
      return res.end('Ogg');
    }
    assert.equal(url.pathname,'/api/contacts/profile-picture');
    assert.equal(url.searchParams.get('session'),'photo-test');
    assert.equal(req.headers['x-api-key'],'fixture');
    const id=url.searchParams.get('contactId');
    res.writeHead(id==='3@c.us'?503:200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({profilePictureURL:id==='1@c.us'?photoURL:null}));
  });
  const waha = new WebSocketServer({server:http});
  http.listen(0,'127.0.0.1');
  await once(http,'listening');
  t.after(()=>http.close());
  t.after(() => waha.close());
  const directory=await mkdtemp(join(tmpdir(),"wa-users-"));
  const password = randomUUID();
  const clock = `
    import {mock} from 'node:test';
    mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
    process.on('message', ms => { mock.timers.tick(ms); process.send('advanced'); });
  `;
  const awaySocket=once(waha,'connection');
  const child = spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(clock),'src/server.js'],{env:{
    ...process.env, PORT:'0', NODE_ENV:'test', ADMIN_USERNAME:'tester', ADMIN_PASSWORD:password,
    USER_WORKBOOK_PATH:join(directory,'users.xlsx'),WHATIX_DB_PATH:join(directory,'whatix.db'),
    OLLAMA_BASE_URL:'http://127.0.0.1:'+http.address().port,OLLAMA_MODEL:'qwen3:4b',AWAY_REPLIES_ENABLED:'true',BUSY_REPLIES_ENABLED:'false',
    APP_USERS_JSON:JSON.stringify(['alice','bob'].map(username=>({username,password}))),
    JWT_ACCESS_SECRET:randomUUID(), JWT_REFRESH_SECRET:randomUUID(), WAHA_API_KEY:'fixture',
    WAHA_URL:'http://127.0.0.1:'+waha.address().port,WAHA_SESSION:'photo-test'
  },stdio:['ignore','pipe','inherit','ipc']});
  t.after(async()=>{
    if(child.exitCode===null && child.signalCode===null){
      const exited=once(child,'exit');child.kill();await exited;
    }
    await rm(directory,{recursive:true,force:true});
  });
  const lines = createInterface({input:child.stdout});
  const [line] = await once(lines,'line');
  const base = 'http://127.0.0.1:'+line.match(/listening on (\d+)/)[1]+'/api';
  const cookie = response => response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const login = (pass=password,username='tester') => fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({credentials:Buffer.from(JSON.stringify({username,password:pass})).toString('base64')})});
  const post = (path,Cookie='') => fetch(base+'/auth/'+path,{method:'POST',headers:{Cookie}});
  const me = Cookie => fetch(base+'/auth/me',{headers:{Cookie}});
  async function advance(ms){
    const advanced=once(child,'message');
    child.send(ms);
    await advanced;
  }
  const activity = (Cookie,keepSession=false) => fetch(base+'/auth/activity',{
    method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify({keepSession})
  });

  const [away]=await awaySocket;
  const incoming=(id,extra={})=>away.send(JSON.stringify({session:'photo-test',event:'message',payload:{
    from:'100@lid',fromMe:false,body:'Mujhe website banwani hai.',timestamp:Math.floor(Date.now()/1000),id,...extra}}));
  const replied=once(http,'replied');
  incoming('first');incoming('first');incoming('group',{from:'100@g.us'});incoming('echo',{fromMe:true});
  await replied;
  const confirmation=once(http,'replied');incoming('name',{body:'Ali Khan'});await confirmation;
  const grid=(Cookie='',query='')=>fetch(base+'/admin/offline-requirements'+query,{headers:{Cookie}});
  assert.equal((await grid()).status,401);
  // A regular user pauses the AI only for chats assigned to them: assign this
  // customer's number to alice, then let alice be the only one signed in.
  const setup=cookie(await login());
  const assignment=await fetch(base+'/admin/assigned-numbers',{method:'POST',headers:{Cookie:setup,'Content-Type':'application/json'},
    body:JSON.stringify({phoneNumber:15551234567,username:'alice'})});
  assert.equal(assignment.status,201);
  const assignmentId=(await assignment.json()).id;
  assert.equal((await post('logout',setup)).status,200);
  const onlyRegular=cookie(await login(password,'alice'));
  assert.equal((await grid(onlyRegular)).status,403);
  incoming('regular-only');
  const processed=once(away,'pong');away.ping();await processed;
  assert.equal((await post('logout',onlyRegular)).status,200);
  const cleanup=cookie(await login());
  assert.equal((await fetch(base+'/admin/assigned-numbers/'+assignmentId,{method:'DELETE',headers:{Cookie:cleanup}})).status,204);
  assert.equal((await post('logout',cleanup)).status,200);
  const drafting=once(http,'drafting');incoming('second');await drafting;
  const attempts = await Promise.all([login(),login()]);
  releaseDraft();
  incoming('while-online');
  assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  const first = cookie(attempts.find(r=>r.ok));
  const report=await (await grid(first)).json();
  assert.equal(report.requirements.length,1);
  const entry=report.requirements[0];
  assert.deepEqual(entry,{id:1,name:'Ali Khan',phone:15551234567,query:'Customer requests website development.',dateReceived:entry.dateReceived,assignedUsers:[]});
  assert.ok(report.from<=entry.dateReceived && entry.dateReceived<=report.to);
  assert.equal((await grid(first,'?from=2025-02-30')).status,400);
  assert.deepEqual((await (await grid(first,'?from=2000-01-01&to=2000-01-31')).json()).requirements,[]);
  const aliceLogin=await login(password,'alice');
  assert.equal((await aliceLogin.clone().json()).role,'user');
  const alice=cookie(aliceLogin);
  const deleteLabel=(Cookie,scope)=>fetch(base+'/business-labels/2',{method:'DELETE',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify({scope,expectedChats:[]})});
  assert.equal((await deleteLabel('','label')).status,401);
  for(const scope of ['label','history','chats'])assert.equal((await deleteLabel(alice,scope)).status,403);
  const removeChat=(Cookie,id)=>fetch(base+'/chats/'+encodeURIComponent(id)+'/from-my-list',{method:'DELETE',headers:{Cookie}});
  const personalList=async Cookie=>(await (await fetch(base+'/business-labels/history-changes',{headers:{Cookie}})).json()).personalChats;
  assert.equal((await removeChat('','100@lid')).status,401);
  assert.equal((await removeChat(alice,'100@lid')).status,403);
  assert.equal((await removeChat(first,'100@g.us')).status,400);
  assert.equal((await removeChat(first,'100@lid')).status,200);
  assert.deepEqual(Object.keys(await personalList(first)),['100@lid']);
  assert.deepEqual(await personalList(alice),{});
  const labelPost=(suffix,body,Cookie=alice)=>fetch(base+'/business-labels'+suffix,{method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await labelPost('',{name:'Customers',color:4},'')).status,401);
  assert.equal((await labelPost('',{name:'Customers',color:4},alice)).status,403);
  assert.equal((await labelPost('',{name:' ',color:20},first)).status,400);
  const createdLabel=await labelPost('',{name:' Customers ',color:4},first);
  assert.equal(createdLabel.status,201);
  assert.equal((await createdLabel.json()).id,'2');
  assert.equal((await labelPost('/2/contacts',{contactId:'abc'})).status,400);
  const member={contactId:'+123 456 789'};
  assert.equal((await labelPost('/2/contacts',{contactId:'+111111111'})).status,422);
  // The child uses a virtual clock for idle expiry and WAHA confirmation delays.
  const tick=setInterval(()=>child.send(250),40);
  let additions;
  try{additions=await Promise.all([labelPost('/2/contacts',member),labelPost('/3/contacts',{contactId:'987654321@lid'})]);}
  finally{clearInterval(tick);}
  for(const addition of additions){
    const result=await addition.json();
    assert.equal(result.status,'added');
    assert.equal(result.chatId,'987654321@lid');
  }
  assert.deepEqual(chatLabels.map(label=>label.id).sort(),['1','2','3']);
  assert.equal((await (await labelPost('/2/contacts',member)).json()).status,'already_added');
  assert.equal(labelWrites,2);
  assert.equal((await labelPost('/missing/contacts',member)).status,404);
  const sendVoice=(payload,Cookie)=>fetch(base+'/sendVoice',{method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  assert.equal((await sendVoice(voiceRequest,'')).status,401);
  assert.equal((await sendVoice({...voiceRequest,session:'other'},alice)).status,400);
  assert.deepEqual(await (await sendVoice(voiceRequest,alice)).json(),{id:'sent-note'});
  const deletion=(Cookie,id,scope)=>fetch(base+'/messages/'+encodeURIComponent(id),{method:'DELETE',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify({scope})});
  const states=async Cookie=>(await (await fetch(base+'/messages/deletion-state',{method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify({ids:['sent-note']})})).json()).messages[0];
  assert.equal((await deletion('','sent-note','everyone')).status,401);
  assert.equal((await deletion(first,'sent-note','everyone')).status,404);
  assert.equal((await deletion(alice,'received-note','me')).status,404);
  assert.equal((await deletion(alice,'sent-note','me')).status,200);
  assert.equal((await states(alice)).hidden,true);
  assert.equal((await states(first)).hidden,false);
  assert.equal(revokeCalls,0);
  assert.equal((await deletion(alice,'sent-note','everyone')).status,409);
  assert.equal((await states(alice)).revocationRequested,false);
  const repeats=await Promise.all([deletion(alice,'sent-note','everyone'),deletion(alice,'sent-note','everyone')]);
  assert.ok(repeats.every(r=>r.status===200));
  assert.equal(revokeCalls,2);
  assert.deepEqual(await states(first),{id:'sent-note',mine:false,hidden:false,revocationRequested:true});
  const audio=await fetch(base+'/files/note.ogg',{headers:{Cookie:alice,Range:'bytes=0-2'}});
  assert.equal(audio.status,206);
  assert.equal(audio.headers.get('Content-Type'),'audio/ogg');
  assert.equal(audio.headers.get('Content-Disposition'),'inline');
  assert.equal(await audio.text(),'Ogg');
  const photo=(id,Cookie=alice)=>fetch(base+'/contacts/profile-picture?'+new URLSearchParams({contactId:id,session:'ignored'}),{headers:{Cookie}});
  const contactName=(id,Cookie)=>fetch(base+'/contacts/name?'+new URLSearchParams({contactId:id}),{headers:{Cookie}});
  const identity=await fetch(base+'/session-identity',{headers:{Cookie:first}});
  assert.deepEqual(await identity.json(),{session:'photo-test',number:'+15551234567',lid:'100@lid'});
  assert.deepEqual(await (await contactName('1@c.us',first)).json(),{name:'Saved contact'});
  assert.deepEqual(await (await contactName('77@lid',first)).json(),{name:'Profile name'});
  assert.equal((await contactName('1@c.us',alice)).status,403);
  assert.equal((await photo('1','')).status,401);
  assert.equal((await photo('1@g.us')).status,400);
  assert.deepEqual(await (await photo('+1')).json(),{profilePictureURL:photoURL});
  assert.deepEqual(await (await photo('1@s.whatsapp.net')).json(),{profilePictureURL:photoURL});
  assert.deepEqual(await (await photo('2@lid')).json(),{profilePictureURL:null});
  assert.equal((await photo('3')).status,502);
  const bob=cookie(await login(password,'bob'));
  const list=Cookie=>fetch(base+'/admin/active-users',{headers:{Cookie}});
  const revoke=(Cookie,id)=>fetch(base+'/admin/sessions/'+id+'/end',{method:'POST',headers:{Cookie}});
  assert.equal((await list('')).status,401);
  assert.equal((await list(alice)).status,403);
  assert.equal((await (await me(first)).json()).role,'super_user');
  assert.equal((await login(password,'alice')).status,409);
  const register=(Cookie,username)=>fetch(base+'/admin/users',{method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify({username,password,name:'Test Operator',phoneNumber:923001234567,isAdmin:true})});
  assert.equal((await register('', 'new-user')).status,401);
  assert.equal((await register(alice,'new-user')).status,403);
  assert.equal((await register(first,'tester')).status,409);
  const availability=(username,Cookie)=>fetch(base+'/admin/username-availability?'+new URLSearchParams({username}),{headers:{Cookie}});
  assert.equal((await availability('alice','')).status,401);
  assert.equal((await availability('alice',alice)).status,403);
  assert.equal((await availability(' ',first)).status,400);
  assert.deepEqual(await (await availability('alice',first)).json(),{available:false});
  assert.deepEqual(await (await availability('new-user',first)).json(),{available:true});
  const registrations=await Promise.all([register(first,'new-user'),register(first,'new-user')]);
  assert.deepEqual(registrations.map(r=>r.status).sort(),[201,409]);
  assert.deepEqual(await (await availability('new-user',first)).json(),{available:false});
  assert.deepEqual(await registrations.find(r=>r.status===409).json(),{error:'Username already in use'});
  const created=await registrations.find(r=>r.ok).json();
  assert.equal(created.role,'admin');
  assert.equal(created.id,4);
  assert.equal(created.banLogin,false);
  assert.equal(created.isAdmin,true);
  assert.equal(created.phoneNumber,923001234567);
  assert.ok(Date.parse(created.dateCreated));
  const added=await login(password,'new-user');
  assert.equal(added.status,200);
  assert.equal((await register(cookie(added),'forbidden')).status,403);
  const directoryList=async()=> (await (await fetch(base+'/admin/users',{headers:{Cookie:first}})).json()).users;
  const adminCookie=cookie(added);
  assert.equal((await labelPost('',{name:'Customers',color:4},adminCookie)).status,201);
  assert.equal((await (await me(adminCookie)).json()).role,'admin');
  assert.deepEqual(await personalList(adminCookie),{});
  assert.equal((await removeChat(adminCookie,'123@c.us')).status,200);
  assert.deepEqual(Object.keys(await personalList(adminCookie)),['123@c.us']);
  assert.deepEqual(Object.keys(await personalList(first)),['100@lid']);
  const adminHeaders={Cookie:adminCookie,'Content-Type':'application/json'};
  const options=Cookie=>fetch(base+'/admin/offline-requirements/assignees',{headers:{Cookie}});
  const replaceAssignees=(Cookie,userIds,expectedUserIds)=>fetch(base+'/admin/offline-requirements/1/assignees',{
    method:'PATCH',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify({userIds,expectedUserIds})});
  assert.equal((await options(alice)).status,403);
  const {users:choices}=await (await options(adminCookie)).json();
  assert.deepEqual(choices.map(u=>u.username).sort(),['alice','bob']);
  const selected=choices.map(u=>u.id);
  const bobId=choices.find(u=>u.username==='bob').id;
  assert.equal((await replaceAssignees(alice,selected,[])).status,403);
  assert.equal((await replaceAssignees(first,[created.id],[])).status,422);
  const savedAssignments=await replaceAssignees(adminCookie,selected,[]);
  assert.deepEqual((await savedAssignments.json()).requirement.assignedUsers,choices);
  const numbers=async Cookie=>(await (await fetch(base+'/assigned-numbers',{headers:{Cookie}})).json()).assignments.map(a=>a.phoneNumber);
  assert.deepEqual(await numbers(alice),[entry.phone]);
  assert.deepEqual(await numbers(bob),[entry.phone]);
  assert.equal((await replaceAssignees(first,[],[])).status,409);
  assert.equal((await replaceAssignees(first,[bobId],selected)).status,200);
  assert.deepEqual(await numbers(alice),[]);
  assert.deepEqual(await numbers(bob),[entry.phone]);
  assert.equal((await replaceAssignees(first,[],[bobId])).status,200);
  assert.deepEqual(await numbers(bob),[]);
  assert.equal((await fetch(base+'/admin/users',{headers:adminHeaders})).status,200);
  const regular=await fetch(base+'/admin/users',{method:'POST',headers:adminHeaders,body:JSON.stringify({username:'operator',password})});
  assert.equal(regular.status,201);
  const regularId=(await regular.json()).id;
  const path=base+'/admin/users/'+regularId;
  assert.equal((await fetch(path,{headers:adminHeaders})).status,200);
  assert.equal((await fetch(path,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({isAdmin:true})})).status,403);
  const patchAsAdmin=(url,changes)=>fetch(url,{method:'PATCH',headers:adminHeaders,body:JSON.stringify(changes)});
  assert.equal((await patchAsAdmin(path,{username:'changed',name:'Rejected'})).status,403);
  const edited=await patchAsAdmin(path,{name:'Edited operator',phoneNumber:123});
  assert.equal(edited.status,200);
  assert.equal((await edited.json()).name,'Edited operator');
  const manage=(url,banLogin)=>fetch(url,{method:'POST',headers:adminHeaders,body:JSON.stringify({banLogin})});
  const peer=await (await register(first,'peer-admin')).json();
  assert.equal((await login(password,'peer-admin')).status,200);
  const operator=await login(password,'operator');
  const rows=(await (await fetch(base+'/admin/users',{headers:adminHeaders})).json()).users;
  for(const id of [peer.id,created.id,rows.find(row=>row.isSuperUser).id]){
    const target=rows.find(row=>row.id===id);
    const protectedPath=base+'/admin/users/'+id;
    assert.equal((await patchAsAdmin(protectedPath,{name:'Denied'})).status,403);
    assert.equal((await fetch(protectedPath,{method:'DELETE',headers:adminHeaders})).status,403);
    assert.equal((await manage(base+'/admin/users/'+id+'/ban',true)).status,403);
    for(const ban of [true,false])assert.equal((await manage(base+'/admin/sessions/'+target.sessionId+'/end',ban)).status,403);
  }
  const operatorSession=rows.find(row=>row.id===regularId).sessionId;
  assert.equal((await manage(base+'/admin/sessions/'+operatorSession+'/end',false)).status,204);
  assert.equal((await me(cookie(operator))).status,401);
  assert.equal((await login(password,'operator')).status,200);
  const nextSession=(await (await fetch(path,{headers:adminHeaders})).json()).sessionId;
  assert.equal((await manage(base+'/admin/sessions/'+nextSession+'/end',true)).status,204);
  assert.equal((await login(password,'operator')).status,403);
  assert.equal((await manage(path+'/ban',false)).status,204);
  assert.equal((await login(password,'operator')).status,200);
  assert.equal((await manage(path+'/ban',true)).status,204);
  assert.equal((await fetch(base+'/admin/users/'+peer.id,{method:'DELETE',headers:{Cookie:first}})).status,204);
  assert.equal((await fetch(path,{method:'DELETE',headers:adminHeaders})).status,204);
  const records=await directoryList();
  assert.equal(records.length,4);
  const item=records.find(u=>u.id===created.id);
  assert.ok(item.userIp);
  assert.ok(item.sessionId);
  assert.equal(JSON.stringify(records).toLowerCase().includes('password'),false);
  const setBan=(path,banLogin,Cookie=first)=>fetch(base+path,{method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify({banLogin})});
  const bannedPath='/admin/users/'+item.id+'/ban';
  assert.equal((await setBan(bannedPath,true,alice)).status,403);
  assert.equal((await setBan('/admin/sessions/'+item.sessionId+'/end',true)).status,204);
  assert.equal((await me(cookie(added))).status,401);
  assert.equal((await post('refresh',cookie(added))).status,401);
  assert.equal((await login(password,'new-user')).status,403);
  assert.equal((await directoryList()).find(u=>u.id===created.id).banLogin,true);
  assert.equal((await setBan(bannedPath,false)).status,204);
  const unbanned=await login(password,'new-user');
  assert.equal(unbanned.status,200);
  const profileRequest=(method,id,changes,Cookie=first)=>fetch(base+'/admin/users/'+id,{
    method,headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify(changes)
  });
  const idToEdit=created.id;
  for(const method of ['GET','PATCH','DELETE']){
    assert.equal((await profileRequest(method,idToEdit,undefined,alice)).status,403);
    assert.equal((await profileRequest(method,idToEdit,undefined,'')).status,401);
  }
  const adminId=records.find(u=>u.isSuperUser).id;
  assert.equal((await profileRequest('DELETE',adminId)).status,403);
  assert.equal((await profileRequest('PATCH',adminId,{name:'Other'})).status,403);
  assert.equal((await profileRequest('PATCH',idToEdit,{id:9})).status,400);
  const duplicateRename=await profileRequest('PATCH',idToEdit,{username:'alice'});
  assert.equal(duplicateRename.status,409);
  assert.deepEqual(await duplicateRename.json(),{error:'Username already in use'});
  assert.equal((await profileRequest('PATCH',idToEdit,{username:created.username})).status,200);
  const changed=await (await profileRequest('PATCH',idToEdit,{name:'Edited',phoneNumber:null})).json();
  assert.equal(changed.name,'Edited');
  assert.equal(changed.phoneNumber,null);
  assert.ok(changed.sessionId);
  assert.deepEqual(await (await profileRequest('GET',idToEdit)).json(),changed);
  assert.equal((await profileRequest('PATCH',idToEdit,{username:'renamed'})).status,200);
  assert.equal((await me(cookie(unbanned))).status,401);
  const renamed=await login(password,'renamed');
  assert.equal(renamed.status,200);
  const replacement=randomUUID();
  assert.equal((await profileRequest('PATCH',idToEdit,{password:replacement})).status,200);
  assert.equal((await post('refresh',cookie(renamed))).status,401);
  assert.equal((await login(password,'renamed')).status,401);
  const last=await login(replacement,'renamed');
  assert.equal(last.status,200);
  assert.equal((await profileRequest('DELETE',idToEdit)).status,204);
  assert.equal((await me(cookie(last))).status,401);
  assert.equal((await post('refresh',cookie(last))).status,401);
  assert.equal((await profileRequest('GET',idToEdit)).status,404);
  assert.equal((await profileRequest('DELETE',idToEdit)).status,404);
  assert.equal((await login(replacement,'renamed')).status,401);
  const later=await register(first,'later');
  assert.ok((await later.json()).id>idToEdit);
  const users=(await (await list(first)).json()).users;
  assert.deepEqual(users.map(row=>row.username).sort(),['alice','bob']);
  const id=users.find(row=>row.username==='alice').sessionId;
  assert.equal((await revoke(bob,id)).status,403);
  const socket=once(waha,'connection');
  const aliceStream=await fetch(base+'/incoming-text',{headers:{Cookie:alice}});
  const [ws,upgrade]=await socket;
  const subscriptions=new URL(upgrade.url,'http://localhost').searchParams.getAll('events');
  for(const event of ['call.received','call.accepted','call.rejected'])assert.ok(subscriptions.includes(event));
  ws.send(JSON.stringify({event:'message',session:'photo-test',payload:{id:'note',from:'1@lid',_data:{type:'ptt'},media:{url:'/api/files/note.ogg'}}}));
  const readerVoice=aliceStream.body.getReader();
  let received='';
  while(!received.includes('"kind":"voice"'))received+=new TextDecoder().decode((await readerVoice.read()).value);
  assert.match(received,/"src":"\/api\/files\/note.ogg"/);
  const adminStream=await fetch(base+'/incoming-text',{headers:{Cookie:first}});
  const adminReader=adminStream.body.getReader();
  const decline=(id,Cookie=first)=>fetch(base+'/calls/decline',{method:'POST',headers:{Cookie,'Content-Type':'application/json'},body:JSON.stringify({id})});
  const callEvent=(event,id,from,session='photo-test')=>ws.send(JSON.stringify({event,session,payload:{id,from}}));
  const waitFor=async fragment=>{
    while(!received.includes(fragment))received+=new TextDecoder().decode((await adminReader.read()).value);
  };
  callEvent('call.received','wrong','123@c.us','other');
  callEvent('call.received','answered','123@c.us');
  callEvent('call.accepted','answered','123@c.us');
  callEvent('call.received','ring','77@lid');
  await waitFor('"phoneNumber":"+15551234567"');
  assert.ok(received.includes('event: call.received\ndata: {"id":"answered","phoneNumber":"+123"'));
  assert.ok(received.includes('event: call.ended\ndata: {"id":"answered"}'));
  assert.ok(received.includes('"id":"ring","phoneNumber":null'));
  assert.ok(!received.includes('"id":"wrong"'));
  assert.equal((await decline('ring','')).status,401);
  assert.equal((await decline('ring',alice)).status,403);
  const laterAdmin=cookie(await login(password,'later'));
  const replay=await fetch(base+'/incoming-text',{headers:{Cookie:laterAdmin}});
  const replayReader=replay.body.getReader();
  let replayed='';
  while(!replayed.includes('"id":"ring"'))replayed+=new TextDecoder().decode((await replayReader.read()).value);
  await replayReader.cancel();
  await post('logout',laterAdmin);
  assert.equal((await decline(null)).status,400);
  assert.equal((await decline('answered')).status,409);
  assert.equal((await decline('ring')).status,502);
  assert.equal((await decline('ring')).status,202);
  ws.send(JSON.stringify({event:'call.rejected',session:'photo-test',payload:{id:'ring',_data:{api:true}}}));
  callEvent('call.received','barrier','123@c.us');
  await waitFor('"id":"barrier"');
  assert.ok(!received.includes('event: call.ended\ndata: {"id":"ring"}'));
  assert.equal((await decline('ring')).status,202);
  callEvent('call.rejected','ring','77@lid');
  await waitFor('event: call.ended\ndata: {"id":"ring"}');
  assert.equal((await decline('ring')).status,409);
  assert.equal(declineRequests,3);
  await adminReader.cancel();
  readerVoice.releaseLock();
  assert.equal((await revoke(first,id)).status,204);
  let ending='';
  for await(const part of aliceStream.body)ending+=Buffer.from(part).toString();
  assert.match(ending,/event: session-ended\ndata: {"reason":"admin_revoked"}/);
  assert.doesNotMatch(ending,/event: call\./);
  assert.equal((await post('refresh',alice)).status,401);
  assert.equal((await me(alice)).status,401);
  assert.equal((await me(bob)).status,200);
  assert.equal((await login(password,'alice')).status,200);
  assert.equal((await revoke(first,id)).status,404);
  assert.equal((await (await list(first)).json()).users.length,2);
  assert.equal((await login('wrong')).status,401);
  assert.equal((await me(first)).status,200);
  await post('logout'); // A different browser has no session cookies.
  assert.equal((await login()).status,409);
  const rotated = await post('refresh',first);
  assert.equal(rotated.status,200);
  const current = cookie(rotated);
  assert.equal((await post('refresh',first)).status,401);
  assert.equal((await login()).status,409);
  const refreshOnly = current.split('; ').find(c=>c.startsWith('wa_refresh='));
  assert.equal((await (await me(refreshOnly)).json()).refreshable,true);
  const stream = await fetch(base+'/incoming-text',{headers:{Cookie:current}});
  const reader = stream.body.getReader();
  await reader.read();
  assert.equal((await post('logout',current)).status,200);
  while (!(await reader.read()).done) { /* drain queued events before EOF */ }
  assert.equal((await me(first)).status,401);
  assert.equal((await post('refresh',current)).status,401);
  const next = await login();
  assert.equal(next.status,200);
  await post('logout',first);
  const owner=cookie(next);
  const initial=await next.json();
  assert.equal(initial.idleWarningAt-initial.serverNow,300000);
  assert.equal(initial.idleExpiresAt-initial.idleWarningAt,120000);
  await advance(60000);
  assert.equal((await activity(first,true)).status,401);
  const active=await (await activity(owner)).json();
  assert.equal(active.idleExpiresAt-initial.idleExpiresAt,60000);
  await advance(300000);
  const refreshed=await post('refresh',owner);
  const renewed=cookie(refreshed);
  assert.equal((await refreshed.json()).idleExpiresAt,active.idleExpiresAt);
  assert.equal((await (await me(renewed)).json()).idleWarningAt,active.idleWarningAt);
  const warning=await activity(renewed);
  assert.equal(warning.status,409);
  assert.equal((await warning.json()).idleExpiresAt,active.idleExpiresAt);
  await advance(119999);
  const confirmed=await activity(renewed,true);
  assert.equal(confirmed.status,200);
  const extended=await confirmed.json();
  assert.equal(extended.idleWarningAt-extended.serverNow,300000);
  const live=await fetch(base+'/incoming-text',{headers:{Cookie:renewed}});
  const events=live.body.getReader();
  await events.read();
  await advance(420000);
  while (!(await events.read()).done) { /* server closes without a client logout */ }
  assert.equal((await activity(renewed,true)).status,401);
  assert.equal((await post('refresh',renewed)).status,401);
  assert.equal((await me(renewed)).status,401);
  const afterExpiry=once(http,'replied');
  incoming('after-idle-expiry',{timestamp:Math.ceil(extended.idleExpiresAt/1000)});
  await afterExpiry;
  for(let i=0;i<10;i++)await login('wrong','alice');
  assert.equal((await login(password,'alice')).status,429);
  assert.equal((await login()).status,200);
  for(let i=0;i<10;i++)await login('wrong');
  assert.equal((await login()).status,429);
  assert.equal(drafts,2);
  assert.equal(replyCount,3);
});
