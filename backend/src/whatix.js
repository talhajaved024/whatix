import {readFile,readdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {hkdfSync} from 'node:crypto';
import ExcelJS from 'exceljs';
import {connectDatabase,schema} from './sqlite.js';
import {hashPassword,passwordCipher,verifierPattern} from './accounts.js';

async function optional(action){
  try{return await action();}catch(err){if(err.code==='ENOENT')return null;throw err;}
}
async function workbook(path){
  const bytes=await optional(()=>readFile(path));
  if(!bytes)return null;
  const book=new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  return book;
}
function rows(sheet,headers){
  if(!sheet||headers.some((name,i)=>sheet.getRow(1).getCell(i+1).value!==name))
    throw Error('Invalid legacy columns in '+(sheet?.name || 'missing worksheet'));
  return sheet.getSheetValues().slice(2).filter(Boolean).map(row=>row.slice(1));
}
async function sequence(s,book,sheet,table){
  const last=book.getWorksheet(sheet)?.getCell('B1').value;
  if(!Number.isSafeInteger(last)||last<0)throw Error('Invalid legacy ID sequence for '+table);
  const info=await s.get('SELECT seq FROM sqlite_sequence WHERE name=?',[table]);
  if(!info)await s.run('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)',[table,last]);
  else if(last>info.seq)await s.run('UPDATE sqlite_sequence SET seq=? WHERE name=?',[last,table]);
}
async function importAccounts(s,options,cipher){
  const {usersPath,admin,bootstrapPassword,legacyJson}=options;
  const book=await workbook(usersPath),sheet=book?.getWorksheet('Users');
  if(!book || sheet?.getCell('A1').value==='username'){
    if(!bootstrapPassword)throw Error('ADMIN_PASSWORD required to initialize the super user');
    const initial=[[admin,await hashPassword(bootstrapPassword)]];
    if(book)initial.push(...rows(sheet,['username','passwordHash']));
    else for(const user of JSON.parse(legacyJson||'[]'))initial.push([user.username,await hashPassword(user.password)]);
    for(const [i,[name,hash]] of initial.entries()){
      if(!verifierPattern.test(hash))throw Error('Invalid legacy password verifier');
      await s.run('INSERT INTO users VALUES(?,?,?,?,0,NULL,NULL,NULL,?)',[i+1,name,name,cipher.seal(hash,i+1,name),+(i===0)]);
    }
    return;
  }
  const old=passwordCipher(await readFile(usersPath+'.key'));
  for(const [id,name,user,password,ban,date,ip,phone,isAdmin] of rows(sheet,
    ['ID','NAME','USER_NAME','PASSWORD','BAN_LOGIN','DATE_CREATED','USER_IP','PHONE_NUMBER','IS_ADMIN'])){
    const encrypted=cipher.seal(old.open(password,id,user),id,user);
    await s.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)',[id,name,user,encrypted,+ban,date?new Date(date).toISOString():null,ip,phone,+isAdmin]);
  }
  await sequence(s,book,'AccountSequence','users');
}
async function importWorkbooks(s,options,cipher){
  await importAccounts(s,options,cipher);
  const assignments=await workbook(options.assignedPath);
  if(assignments){
    for(const [id,phone,user] of rows(assignments.getWorksheet('AssignedNumbers'),['ID','phone_number','user_name']))
      await s.run('INSERT INTO assigned_numbers VALUES(?,?,?)',[id,phone,user]);
    await sequence(s,assignments,'AssignmentSequence','assigned_numbers');
  }
  const requirements=await workbook(join(dirname(options.usersPath),'offline requirements.xlsx'));
  if(!requirements)return;
  const sheet=requirements.getWorksheet('Requirements');
  if(sheet?.getCell('F1').value && sheet.getCell('F1').value!=='assigned_user')throw Error('Invalid requirement assignment header');
  for(const [id,name,phone,query,date,assigned] of rows(sheet,['ID','NAME','PHONE','QUERY','DATE_RECIEVED'])){
    const ids=JSON.parse(assigned||'[]');
    if(!Array.isArray(ids)||!ids.every(n=>Number.isSafeInteger(n)&&n>0))throw Error('Invalid requirement assignees');
    await s.run('INSERT INTO "offline requirements" VALUES(?,?,?,?,?,?)',[id,name,phone,query,new Date(date).toISOString().slice(0,10),JSON.stringify(ids)]);
  }
  const context=requirements.getWorksheet('IntakeContext');
  if(context)for(const [id,keys,history,version,phone] of rows(context,['ID','SENDER_KEYS','CUSTOMER_CONTEXT','VERSION'])){
    if(!Array.isArray(JSON.parse(keys))||!Array.isArray(JSON.parse(history)))throw Error('Invalid intake context');
    await s.run('INSERT INTO intake_context VALUES(?,?,?,?,?)',[id,keys,history,version,phone]);
  }
}
async function importRecords(s,dir){
  const list=async path=>await optional(()=>readdir(path)) || [];
  async function copy(namespace,key,path){
    const value=await readFile(path,'utf8');
    JSON.parse(value);
    await s.run('INSERT INTO app_records VALUES(?,?,?)',[namespace,key,value]);
  }
  for(const name of await list(dir)){
    const label=/^label-changes-([a-f0-9]{64})\.json$/.exec(name);
    const chat=/^personal-chats-([a-f0-9]{64})-(\d+)\.json$/.exec(name);
    if(label)await copy('labels:'+label[1],'state',join(dir,name));
    if(chat)await copy('personal:'+chat[1],chat[2],join(dir,name));
  }
  const sent=join(dir,'sent-messages');
  for(const name of await list(sent))if(/^[a-f0-9]{64}\.json$/.test(name))await copy('sent',name.slice(0,-5),join(sent,name));
  const markers=join(dir,'away-replies');
  for(const day of await list(markers))if(/^\d{4}-\d{2}-\d{2}$/.test(day)){
    for(const hash of await list(join(markers,day)))if(/^[a-f0-9]{64}$/.test(hash))
      await s.run('INSERT INTO away_replies VALUES(?,?)',[day,hash]);
  }
  const queue=join(dir,'broadcasts');
  for(const session of await list(queue))if(/^[a-f0-9]{64}$/.test(session)){
    for(const name of await list(join(queue,session)))if(/\.(json|payload)$/.test(name))
      await copy('broadcasts:'+session,name,join(queue,session,name));
  }
}
export async function openWhatix(options){
  const db=await connectDatabase(options.path);
  try{
    const cipher=passwordCipher(Buffer.from(hkdfSync('sha256',options.secret,'whatix','account verifiers v1',32)));
    await db.transaction(async s=>{
      const {user_version:version}=await s.get('PRAGMA user_version');
      if(version===0){
        await s.exec(schema);
        await importWorkbooks(s,options,cipher);
        await importRecords(s,dirname(options.usersPath));
        await s.exec('PRAGMA user_version=1');
      }else if(version!==1)throw Error('Unsupported Whatix database schema');
      const account=await s.get('SELECT ID,USER_NAME,PASSWORD FROM users WHERE USER_NAME=? AND IS_ADMIN=1',[options.admin]);
      if(!account)throw Error('Configured super user missing from Whatix database');
      cipher.open(account.PASSWORD,account.ID,account.USER_NAME);
    });
    return {db,cipher};
  }catch(err){await db.close();throw err;}
}
