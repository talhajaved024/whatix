import {testDatabase} from './test-database.js';
import {replyMarkers} from '../src/sqlite.js';
import {requirementStore,requirementRange} from '../src/offline-requirements.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {awayResponder} from '../src/away-replies.js';

test('greetings, unsupported extractions and withdrawals never start or complete intake',async t=>{
  const db=await testDatabase(t);
  const markers=replyMarkers(db);
  const period={since:Date.now()-1000};
  const turns=[],replies=[],records=[];
  const model={
    async extract(c){
      if(c.message==='marketing for my shop')return {intent:'request',evidence:c.message,name:'',query:'Marketing for a shop'};
      return {intent:'request',name:'',query:'A fabricated requirement',evidence:'words never sent'};
    },
    async reply(turn){turns.push(turn);return 'Thank you.';}
  };
  const handle=awayResponder({session:'test',markers,offlinePeriod:()=>period,model,phoneFor:async()=>null,requirements:{lookup:async()=>null,add:r=>records.push(r)},send:async(_,r)=>replies.push(r)});
  for(const [id,message] of ['Hi','nothing','hmm','marketing for my shop','no thanks','hello'].entries()){
    await handle({event:'message',session:'test',payload:{from:'123@lid',fromMe:false,id:String(id),body:message,timestamp:Math.floor(Date.now()/1000)}});
  }
  assert.equal(replies.length,6);
  // A grounded request with no name yet gets the fixed name question.
  assert.match(replies[3],/May I have your full name/);
  assert.equal(turns.length,5);
  assert.equal(turns[1].requirement,undefined);
  assert.equal(turns[2].requirement,'');
  assert.equal(turns[3].requirement,undefined);
  assert.equal(turns[4].requirement,'');
  assert.equal(records.length,0);
});

test('website intake asks for the name first, saves once and closes with a name and requirement preview',async t=>{
  const db=await testDatabase(t);
  const markers=replyMarkers(db);
  const requirements=requirementStore(db);
  const period={since:Date.now()-1000},turns=[],replies=[];
  const model={
    async extract({message}){
      if(message==='I want a website built')return {intent:'request',name:'',query:'Requests website development.',evidence:message};
      return {intent:'conversation',name:'',query:'',evidence:''};
    },
    async reply(turn){
      turns.push(turn);
      if(turn.action.includes('representative'))return 'We received your website request and would be happy to assist.';
      return 'Thank you.';
    }
  };
  const handle=awayResponder({session:'test',markers,offlinePeriod:()=>period,model,requirements,
    phoneFor:async id=>Number(id.split('@')[0]),send:async(_,reply)=>replies.push(reply)});
  for(const [chat,steps] of [['123',['I have a requirement','My name is Ali Khan','I want a website built']],['456',['Hi','I want a website built','Talha']]]){
    for(const [id,body] of [...steps,'I want a website built'].entries()){
      await handle({event:'message',session:'test',payload:{from:chat+'@c.us',fromMe:false,id:String(id),body,timestamp:Math.floor(Date.now()/1000)}});
    }
  }
  assert.match(replies[0],/^Welcome to Brand Matrix.*May I have your full name/);
  assert.match(replies[1],/^Thank you, Ali Khan\. Please tell us about your requirement/);
  assert.match(replies[2],/Ali Khan.*received/);
  assert.ok(replies[2].includes('*Name:* Ali Khan\n*Requirement:* Requests website development.'));
  assert.match(replies[5],/May I have your full name/);
  assert.match(replies[6],/Talha.*received/);
  assert.ok(replies[6].includes('*Name:* Talha\n'));
  // Repeats of a saved project and the greeting still go to the model.
  assert.equal(turns.length,3);
  assert.equal(turns[0].customerName,'Ali Khan');
  const rows=await requirements.list(requirementRange({}));
  assert.deepEqual(rows.map(r=>[r.name,r.phone,r.query]),[['Talha',456,'Requests website development.'],['Ali Khan',123,'Requests website development.']]);
});

test('Ollama greetings omit unknown name fields and use a supplied name',async t=>{
  const {intakeModel}=await import('../src/away-replies.js');
  let draft='Hi [Customer Name], how can I help you with your project or service today?';
  t.mock.method(globalThis,'fetch',async()=>Response.json({message:{content:JSON.stringify({reply:draft})}}));
  const model=intakeModel('http://localhost','test-model');
  assert.equal(await model.reply({latestMessage:'Hi',customerName:''}),'Hi, how can I help you with your project or service today?');
  assert.equal(await model.reply({customerName:'Talha'}),'Hi Talha, how can I help you with your project or service today?');
  draft='Thank you, [Client Name].';
  await assert.rejects(model.reply({customerName:''}),/unfinished reply/);
});

test('returns salaam for common spellings and still processes a following request',async t=>{
  const db=await testDatabase(t);
  const markers=replyMarkers(db);
  const period={since:Date.now()-1000},messages=[],replies=[];
  const model={
    async extract({message}){messages.push(message);return {intent:'request',evidence:message,query:'Website development',name:''};},
    async reply(turn){return turn.requirement?'May I have your name for the website enquiry?':'Hi! Welcome to Brand Matrix, your digital marketing partner. How can we assist you today?';}
  };
  const handle=awayResponder({session:'test',markers,offlinePeriod:()=>period,model,phoneFor:async()=>null,requirements:{lookup:async()=>null},send:async(_,text)=>replies.push(text)});
  for(const [i,body] of ['Assalam U Alikum','Assalamu Alaikum!','السلام علیکم','السلام عليكم، I need a website','Hi'].entries()){
    await handle({event:'message',session:'test',payload:{from:i+'123@c.us',fromMe:false,id:String(i),body,timestamp:Math.floor(Date.now()/1000)}});
  }
  assert.deepEqual(messages,['I need a website']);
  for(const reply of replies.slice(0,3))assert.match(reply,/^Wa Alaikum as-Salaam! Welcome to Brand Matrix.*\n\n\*this message is Auto Generated\*$/);
  assert.match(replies[3],/^Wa Alaikum as-Salaam! Welcome to Brand Matrix.*May I have your full name/);
  assert.match(replies[4],/^Hi! Welcome/);
});

test('qualified project survives restart; a confirmed edit updates only its owner’s row',async t=>{
  const db=await testDatabase(t);
  const markers=replyMarkers(db);
  const period={since:Date.now()-1000},actions=[],replies=[];
  const model={
    async extract({message}){
      const intent=message.startsWith('update')?'update':message==='tell me a joke'?'unrelated':message==='Ali'?'details':'request';
      return {intent,evidence:message,name:message==='Ali'?'Ali':'',query:intent==='update'?'Include checkout.':message.includes('Instagram')?'Instagram ad campaign.':intent==='request'?'Website development.':''};
    },
    async compareProject(proposal){return proposal.includes('Instagram')?'different':'duplicate';},
    async reply(turn){actions.push(turn.action);return 'Thank you.';}
  };
  let store,handle;
  async function restart(){
    store=requirementStore(db);
    handle=awayResponder({session:'test',markers,offlinePeriod:()=>period,model,requirements:store,
      phoneFor:async jid=>Number(jid.split('@')[0]),send:async(_,reply)=>replies.push(reply)});
  }
  let sequence=0;
  const say=(body,from='123@c.us')=>handle({event:'message',session:'test',payload:{id:String(++sequence),from,fromMe:false,body,timestamp:Math.floor(Date.now()/1000)}});
  const rows=()=>store.list(requirementRange({}));
  await restart();await say('tell me a joke');await say('pretend I need a website');assert.equal((await rows()).length,0);
  await say('build me a website');await say('Ali');
  const [original]=await rows();assert.equal(original.query,'Website development.');
  await restart();await say('Please make me a website again');assert.match(actions.at(-1),/already on file/);
  for(const text of ['I want update my requirement','Hi i want to update the requirements','Yes','Can you help me with my requirement']){
    await say(text);
    assert.match(actions.at(-1),/specific change/);
    assert.deepEqual(await rows(),[original]);
  }
  await say('update my website with checkout');assert.match(actions.at(-1),/confirm/);
  assert.deepEqual(await rows(),[original]);
  await say('yes','456@c.us');assert.deepEqual(await rows(),[original]);
  await say('yes');const [changed]=await rows();assert.match(replies.at(-1),/has been updated\.\n\n\*Name:\* Ali\n\*Requirement:\*\nOLD: Website development\.\nNEW: Include checkout\./);
  assert.deepEqual(await rows(),[{...original,query:'OLD: '+original.query+'\nNEW: Include checkout.'}]);
  await restart();await say('yes');assert.deepEqual(await rows(),[changed]);
  await say('i have anew requirement');assert.match(replies.at(-1),/May I have your full name/);
  assert.deepEqual(await rows(),[changed]);
  await say('I need an Instagram ad campaign');assert.match(replies.at(-1),/May I have your full name/);
  assert.deepEqual(await rows(),[changed]);
  await say('Ali');
  const [campaign,previous]=await rows();
  assert.deepEqual(previous,changed);
  assert.equal(campaign.query,'Instagram ad campaign.');
  assert.equal(campaign.name,original.name);
  assert.notEqual(campaign.id,previous.id);
  await restart();await say('another project: build me a website');
  assert.match(actions.at(-1),/distinguishes/);
  assert.deepEqual(await rows(),[campaign,changed]);
});

test('malformed Ollama output is retried once and persistent failures omit the raw content',async t=>{
  const {intakeModel}=await import('../src/away-replies.js');
  const model=intakeModel('http://localhost','test-model');
  let calls=0;
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>{
    calls++;
    return Response.json({message:{content:calls===2?'{"reply":"How may we help?"}':'private customer text'}});
  });
  assert.equal(await model.reply({}),'How may we help?');
  assert.equal(calls,2);
  await assert.rejects(model.reply({}),{message:'Ollama reply — incomplete or invalid structured response after retry'});
  assert.equal(calls,4);
  fetchMock.mock.mockImplementation(async()=>new Response('private upstream body',{status:503}));
  await assert.rejects(model.reply({}),{message:'Ollama reply — HTTP 503'});
});

test('first replies keep their generated content when the model omits the company opening',async t=>{
  const {intakeModel}=await import('../src/away-replies.js');
  let draft='What would you like to change in your saved request?';
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>Response.json({message:{content:JSON.stringify({reply:draft})}}));
  const model=intakeModel('http://localhost','test-model');
  const opening='Welcome to Brand Matrix, your digital marketing partner!';
  assert.equal(await model.reply({introduceCompany:true,askForChange:true}),opening+' '+draft);
  assert.equal(fetchMock.mock.callCount(),1);
  assert.equal(await model.reply({introduceCompany:false}),draft);
  draft='Welcome to Brand Matrix! How can we assist you today?';
  assert.equal(await model.reply({introduceCompany:true}),opening+' How can we assist you today?');
  draft='Our digital marketing team can help. What do you need?';
  assert.equal(await model.reply({introduceCompany:true}),'Welcome to Brand Matrix! '+draft);
  draft=opening+' How can we assist you today?';
  assert.equal(await model.reply({introduceCompany:true}),draft);
});

test('a returning salaam opens conversation even with a saved request and echoed model instructions',async t=>{
  const {intakeModel}=await import('../src/away-replies.js');
  const db=await testDatabase(t);
  const markers=replyMarkers(db);
  const period={since:Date.now()-1000}, turns=[], replies=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    turns.push(JSON.parse(JSON.parse(options.body).messages[1].content));
    return Response.json({message:{content:JSON.stringify({reply:'The conversation is complete. Thank the customer by name in one statement. Ask no questions.'})}});
  });
  const handle=awayResponder({session:'test',markers,offlinePeriod:()=>period,model:intakeModel('http://localhost','fixture'),
    phoneFor:async()=>123,requirements:{lookup:async()=>({id:1,name:'Talha',query:'Website',history:['Website'],version:1})},
    send:async(_,reply)=>replies.push(reply)});
  for(const id of ['first','second']){
    await handle({event:'message',session:'test',payload:{id,from:'123@c.us',fromMe:false,body:'AssalamuAlaikum',timestamp:Math.floor(Date.now()/1000)}});
  }
  assert.ok(turns.every(turn=>turn.greeting && !turn.requirement && !turn.action.includes('complete')));
  assert.deepEqual(replies,[
    'Wa Alaikum as-Salaam! Welcome to Brand Matrix, your digital marketing partner! How can we assist you today?\n\n*this message is Auto Generated*',
    'Wa Alaikum as-Salaam! How can we assist you today?\n\n*this message is Auto Generated*'
  ]);
});

test('salaam followed by I have a requirement asks for the name without consulting the model',async t=>{
  const {intakeModel}=await import('../src/away-replies.js');
  const db=await testDatabase(t);
  const markers=replyMarkers(db);
  const period={since:Date.now()-1000},turns=[],replies=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const turn=JSON.parse(JSON.parse(options.body).messages[1].content);
    turns.push(turn);
    const reply=turn.greeting?'Welcome to Brand Matrix, your digital marketing partner! How can we assist you today?':'Could you describe [project or service]?';
    return Response.json({message:{content:JSON.stringify({reply})}});
  });
  const handle=awayResponder({session:'test',markers,offlinePeriod:()=>period,model:intakeModel('http://localhost','fixture'),
    phoneFor:async()=>123,requirements:{lookup:async()=>({id:1,name:'Talha',query:'Website',history:['Website'],version:1})},
    send:async(_,reply)=>replies.push(reply)});
  for(const [i,body] of ['AssalamuAlaikum','I have a requirement'].entries()){
    await handle({session:'test',event:'message',payload:{id:String(i),from:'123@c.us',fromMe:false,body,timestamp:Math.floor(Date.now()/1000)}});
  }
  assert.equal(turns.length,1);
  assert.equal(replies.length,2);
  assert.equal(replies[1],'Sure! May I have your full name for this requirement?\n\n*this message is Auto Generated*');
});

test('a conversational opener from a returning customer gets an answer, even if Qwen copies it twice',async t=>{
  const {intakeModel}=await import('../src/away-replies.js');
  const db=await testDatabase(t);
  const markers=replyMarkers(db);
  const period={since:Date.now()-1000},replies=[],input='I need to ask you for something';
  const drafts=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const {messages,format}=JSON.parse(options.body);
    let output;
    if(format.required.includes('intent'))output={intent:'conversation',name:'',query:'',evidence:''};
    else{
      const latest=messages.at(-1);
      assert.equal(latest.role,'user');
      if(latest.content===input){
        drafts.push(messages);
        output={reply:'“I NEED to ask you for something!”'};
      }else output={reply:'Welcome to Brand Matrix, your digital marketing partner. How can we help?'};
    }
    return Response.json({message:{content:JSON.stringify(output)}});
  });
  const handle=awayResponder({session:'test',markers,offlinePeriod:()=>period,model:intakeModel('http://localhost','fixture'),
    phoneFor:async()=>123,requirements:{lookup:async()=>({id:1,name:'Talha',query:'Website',history:['Website'],version:1})},
    send:async(_,reply)=>replies.push(reply)});
  for(const [i,body] of ['Hi there',input].entries())await handle({event:'message',session:'test',payload:{id:String(i),from:'123@c.us',fromMe:false,body,timestamp:Math.floor(Date.now()/1000)}});
  assert.equal(drafts.length,2);
  assert.equal(drafts[0].at(-2).role,'assistant');
  assert.match(drafts[0].at(-2).content,/How can we help/);
  assert.equal(replies[1],'Of course. What would you like to ask?\n\n*this message is Auto Generated*');
});

test('decline, Oky and What do not initiate edits; a confirmed callback edit preserves chat ownership',async t=>{
  const {createHash}=await import('node:crypto');
  const db=await testDatabase(t);
  const markers=replyMarkers(db);
  const store=requirementStore(db);
  const from='15550100001@c.us',session='test',period={since:Date.now()-1000};
  const keys=[createHash('sha256').update(JSON.stringify([session,from])).digest('hex')];
  await store.add({name:'Talha',phone:15550100001,keys,query:'Website',history:[],dateReceived:'2026-11-21'});
  await store.setAssignees(1,[7],[],new Map([[7,true]]));
  const turns=[];
  const handle=awayResponder({session,markers,requirements:store,phoneFor:async()=>15550100001,offlinePeriod:()=>period,model:{
    extract:async()=>{throw Error('Unexpected classification');}, reply:async turn=>{turns.push(turn);return 'Understood.';}
  },send:async()=>{}});
  let id=0;
  const say=body=>handle({event:'message',session,payload:{id:String(++id),body,from,fromMe:false,timestamp:Math.floor(Date.now()/1000)}});
  for(const message of ['Hello','I have a requirement','I have a requirement','Nothing','Oky','What?','Update the phone number 15550100002'])await say(message);
  // Name questions and the post-withdrawal "What?" use fixed wording.
  assert.equal(turns.length,3);
  assert.equal(turns[1].withdrawn,true);
  assert.equal(turns[2].phoneProposal,15550100002);
  assert.equal((await store.lookup(keys)).phone,15550100001);
  await say('Yes');
  assert.equal((await store.lookup(keys)).phone,15550100002);
  assert.equal((await store.list(requirementRange({from:'2026-11-21',to:'2026-11-21'})))[0].query,'Website');
  assert.deepEqual(await store.numbersFor(7,'main',true),[15550100001]);   // intake rows belong to the main number
});

test('plural new requirements invite details and a qualified ERP enquiry is saved once',async t=>{
  const {intakeModel}=await import('../src/away-replies.js');
  const db=await testDatabase(t);
  const markers=replyMarkers(db);
  const requirements=requirementStore(db);
  const replies=[],period={since:Date.now()-1000};
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const {messages,format}=JSON.parse(options.body);
    const turn=JSON.parse(messages[1].content);
    let output;
    if(format.required.length===1 && format.required[0]==='name')output={name:turn.answer};
    else if(format.required.includes('intent')){
      assert.ok(['I want an erp system built.','Ali Khan'].includes(turn.message));
      output=turn.message==='Ali Khan'?{intent:'details',name:'Ali Khan',query:'',evidence:''}:
        {intent:'new_project',name:'',query:'ERP system development',evidence:turn.message};
    }else if(format.required.includes('decision'))output={decision:'qualified'};
    else if(format.required.includes('assessment'))output={assessment:'requirement'};
    else if(turn.askForProject)output={reply:turn.customerMessage};
    else if(turn.requirement && !turn.customerName)output={reply:"I'm from Brand Matrix, a digital marketing company. May I have your name for the ERP enquiry?"};
    else if(turn.customerName)output={reply:'Thank you, Ali Khan. We received your ERP request and a representative will follow up.'};
    else output={reply:'Welcome to Brand Matrix, your digital marketing partner. How can we help?'};
    return Response.json({message:{content:JSON.stringify(output)}});
  });
  const handle=awayResponder({session:'test',markers,offlinePeriod:()=>period,requirements,
    model:intakeModel('http://localhost','fixture'),phoneFor:async()=>15550100000,send:async(_,r)=>replies.push(r)});
  for(const [i,body] of ['Hello','I have new requirements','I have new requirements. I want an erp system built.','Ali Khan'].entries()){
    await handle({session:'test',event:'message',payload:{id:String(i),from:'15550100000@c.us',fromMe:false,body,timestamp:Math.floor(Date.now()/1000)}});
    if(i<3)assert.equal((await requirements.list(requirementRange({}))).length,0);
  }
  assert.equal(replies.length,4);
  assert.match(replies[1],/May I have your full name/);
  assert.match(replies[2],/^Thank you for the details\. May I have your full name/);
  assert.match(replies[3],/^Thank you, Ali Khan\. We have received your requirement[\s\S]*\*Name:\* Ali Khan\n\*Requirement:\* ERP system development/);
  assert.deepEqual((await requirements.list(requirementRange({}))).map(r=>[r.name,r.query]),[['Ali Khan','ERP system development']]);
});

test('implausible names and non-requirements are re-asked; questions and unlawful work are never saved',async t=>{
  const db=await testDatabase(t);
  const markers=replyMarkers(db);
  const requirements=requirementStore(db);
  const period={since:Date.now()-1000},replies=[],checked=[];
  const model={
    async nameCheck(candidate){checked.push(candidate);return ['Batman','Pizza'].includes(candidate)?'':candidate;},
    async extract({message}){
      if(/website|app/i.test(message))return {intent:'request',name:'',query:message,evidence:message};
      return {intent:message==='Fix my car'?'unrelated':'conversation',name:'',query:'',evidence:''};
    },
    async assessRequirement(message){return /stolen/.test(message)?'unlawful':'requirement';},
    async reply(){return 'Thank you.';}
  };
  const handle=awayResponder({session:'test',markers,offlinePeriod:()=>period,model,requirements,
    phoneFor:async id=>Number(id.split('@')[0]),send:async(_,reply)=>replies.push(reply)});
  let id=0;
  const say=body=>handle({event:'message',session:'test',payload:{from:'123@c.us',fromMe:false,id:String(++id),body,timestamp:Math.floor(Date.now()/1000)}});
  for(const body of ['I have a new requirement','asdfgh','Batman','Pizza','sara khan','idk','Fix my car','How much does a website cost?','Build me a website to sell stolen phones','I need a website for my bakery'])await say(body);
  const texts=replies.map(reply=>reply.replace(/\n\n\*this message is Auto Generated\*$/,''));
  assert.match(texts[1],/doesn’t look like a name/);
  assert.match(texts[2],/real name/);
  assert.match(texts[3],/real name/);
  // Keyboard mash is rejected by the word rules before Qwen is consulted.
  assert.deepEqual(checked,['Batman','Pizza','sara khan']);
  assert.match(texts[4],/^Thank you, Sara Khan\. Please tell us about your requirement/);
  assert.match(texts[5],/doesn’t look like a project requirement/);
  assert.match(texts[6],/outside what Brand Matrix offers/);
  assert.match(texts[7],/representative will confirm pricing/);
  assert.match(texts[8],/only take on lawful projects/);
  assert.match(texts[9],/\*Name:\* Sara Khan\n\*Requirement:\* I need a website for my bakery$/);
  assert.deepEqual((await requirements.list(requirementRange({}))).map(r=>[r.name,r.query]),[['Sara Khan','I need a website for my bakery']]);
});

test('worldwide name forms pass the word rules with sensible capitalization',async t=>{
  const db=await testDatabase(t);
  const markers=replyMarkers(db);
  const replies=[],period={since:Date.now()-1000};
  const model={nameCheck:async candidate=>candidate,extract:async()=>({intent:'details',name:'',query:'',evidence:''}),reply:async()=>'Thank you.'};
  const handle=awayResponder({session:'test',markers,offlinePeriod:()=>period,model,requirements:{lookup:async()=>null},
    phoneFor:async()=>null,send:async(_,reply)=>replies.push(reply)});
  const cases=[['syed muhammad ali raza naqvi','Syed Muhammad Ali Raza Naqvi'],['M Talha','M Talha'],['Md Rahim','Md Rahim'],
    ['Ludwig van Beethoven','Ludwig van Beethoven'],['mohammed bin salman','Mohammed bin Salman'],["connor o'brien","Connor O'Brien"],
    ['Nguyen Van An','Nguyen Van An'],['Abdus Salam','Abdus Salam'],['محمد طلحہ','محمد طلحہ'],['Sven Hirschfeld','Sven Hirschfeld'],['José García','José García']];
  let id=0;
  for(const [i,[typed,expected]] of cases.entries()){
    const from=(9000+i)+'@c.us';
    for(const body of ['I have a new requirement',typed])
      await handle({event:'message',session:'test',payload:{from,fromMe:false,id:String(++id),body,timestamp:Math.floor(Date.now()/1000)}});
    assert.ok(replies.at(-1).startsWith('Thank you, '+expected+'. Please tell us'),typed+' -> '+replies.at(-1));
  }
});

test('an ambiguous name is confirmed: a positive reply saves it, No asks for a re-write',async t=>{
  const db=await testDatabase(t);
  const markers=replyMarkers(db);
  const replies=[],period={since:Date.now()-1000};
  const model={
    nameCheck:async candidate=>['Sunny','Sky'].includes(candidate)?{verdict:'unsure',name:candidate}:{verdict:'name',name:candidate},
    extract:async()=>({intent:'details',name:'',query:'',evidence:''}),reply:async()=>'Thank you.'
  };
  const handle=awayResponder({session:'test',markers,offlinePeriod:()=>period,model,requirements:{lookup:async()=>null},
    phoneFor:async()=>null,send:async(_,reply)=>replies.push(reply.replace(/\n\n\*this message is Auto Generated\*$/,''))});
  let id=0;
  const flow=async(from,steps)=>{for(const body of ['I have a new requirement',...steps])
    await handle({event:'message',session:'test',payload:{from,fromMe:false,id:String(++id),body,timestamp:Math.floor(Date.now()/1000)}});};
  await flow('1@c.us',['Sunny','bilkul']);
  assert.equal(replies[1],'Just to confirm, is *Sunny* your correct name? Please reply Yes to confirm, or type your name again.');
  assert.match(replies[2],/^Thank you, Sunny\. Please tell us about your requirement/);
  // "No" is not a withdrawal here; a second ambiguous answer is confirmed again in other words.
  await flow('2@c.us',['Sky','No','Sky','What?','yes']);
  assert.equal(replies[5],'No problem. Could you kindly re-write your full name so we can record it correctly?');
  assert.match(replies[6],/^Thank you\. To make sure we record it correctly, is your name \*Sky\*\?/);
  assert.match(replies[7],/^I was asking whether \*Sky\* is your correct name/);
  assert.match(replies[8],/^Thank you, Sky\. Please tell us about your requirement/);
  await flow('3@c.us',['Sky','no','Talha Javed']);
  assert.match(replies.at(-1),/^Thank you, Talha Javed\. Please tell us/);
});

test('nonsense and failed drafts always get a polite fixed reply; questions never get invented facts',async t=>{
  const db=await testDatabase(t);
  const markers=replyMarkers(db);
  const replies=[],period={since:Date.now()-1000};
  t.mock.method(console,'warn',()=>{});
  const model={
    extract:async({message})=>({intent:/cannot|banana/.test(message)?'nonsense':/\?$/.test(message)?'question':'conversation',name:'',query:'',evidence:''}),
    // Every draft fails, as when Qwen keeps copying the customer.
    reply:async()=>{throw Error('Ollama returned unfinished reply text');}
  };
  const handle=awayResponder({session:'test',markers,offlinePeriod:()=>period,model,requirements:{lookup:async()=>null},
    phoneFor:async()=>null,send:async(_,reply)=>replies.push(reply.replace(/\n\n\*this message is Auto Generated\*$/,''))});
  let id=0;
  for(const body of ['you cannot','banana sky','Do you work on weekends?','Do you build mobile apps?','What services do you offer?','hmm right'])
    await handle({event:'message',session:'test',payload:{from:'5@c.us',fromMe:false,id:String(++id),body,timestamp:Math.floor(Date.now()/1000)}});
  assert.equal(replies.length,6);
  assert.match(replies[0],/Sorry, I didn’t quite understand that\. Could you please be a little more specific/);
  assert.match(replies[1],/I still couldn’t quite follow/);
  assert.match(replies[2],/A representative will get back to you with the details/);
  assert.match(replies[3],/^Yes, Brand Matrix can help with that/);
  assert.match(replies[4],/^Brand Matrix offers software development/);
  // A failed draft for an ordinary remark falls back to the same polite wording.
  assert.match(replies[5],/didn’t quite understand that/);
});
