import sqlite3 from 'sqlite3';
import {mkdir,open} from 'node:fs/promises';
import {dirname} from 'node:path';

export async function connectDatabase(path){
  if(path!==':memory:'){
    await mkdir(dirname(path),{recursive:true});
    const handle=await open(path,'a',0o600);
    await handle.close();
  }
  const db=await new Promise((resolve,reject)=>{
    const conn=new sqlite3.Database(path,err=>err?reject(err):resolve(conn));
  });
  db.configure('busyTimeout',15000);
  const sql={
    exec:text=>new Promise((resolve,reject)=>db.exec(text,err=>err?reject(err):resolve())),
    run:(text,params=[])=>new Promise((resolve,reject)=>db.run(text,params,function(err){
      if(err)reject(err);else resolve({id:this.lastID,changes:this.changes});
    })),
    get:(text,params=[])=>new Promise((resolve,reject)=>db.get(text,params,(err,row)=>err?reject(err):resolve(row))),
    all:(text,params=[])=>new Promise((resolve,reject)=>db.all(text,params,(err,rows)=>err?reject(err):resolve(rows)))
  };
  await sql.exec('PRAGMA foreign_keys=ON');
  let pending=Promise.resolve();
  function use(fn){
    const next=pending.then(()=>fn(sql));
    pending=next.catch(()=>{});
    return next;
  }
  return {use,transaction:fn=>use(async s=>{
    await s.exec('BEGIN IMMEDIATE');
    try{const result=await fn(s);await s.exec('COMMIT');return result;}
    catch(err){await s.exec('ROLLBACK');throw err;}
  }),close:()=>use(()=>new Promise((resolve,reject)=>db.close(err=>err?reject(err):resolve())))};
}

export const schema=`
CREATE TABLE users(ID INTEGER PRIMARY KEY AUTOINCREMENT, NAME TEXT NOT NULL, USER_NAME TEXT NOT NULL UNIQUE,
 PASSWORD TEXT NOT NULL, BAN_LOGIN INTEGER NOT NULL CHECK(BAN_LOGIN IN (0,1)), DATE_CREATED TEXT, USER_IP TEXT,
 PHONE_NUMBER INTEGER, IS_ADMIN INTEGER NOT NULL CHECK(IS_ADMIN IN (0,1)));
CREATE TABLE assigned_numbers(ID INTEGER PRIMARY KEY AUTOINCREMENT,phone_number INTEGER NOT NULL,
 user_name TEXT NOT NULL REFERENCES users(USER_NAME) ON UPDATE CASCADE ON DELETE CASCADE, UNIQUE(phone_number,user_name));
CREATE TABLE "offline requirements"(ID INTEGER PRIMARY KEY AUTOINCREMENT, NAME TEXT NOT NULL, PHONE INTEGER NOT NULL,
 QUERY TEXT NOT NULL, DATE_RECIEVED TEXT NOT NULL, assigned_user TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(assigned_user)));
CREATE TABLE intake_context(ID INTEGER PRIMARY KEY REFERENCES "offline requirements"(ID) ON DELETE CASCADE,
 sender_keys TEXT NOT NULL,customer_context TEXT NOT NULL,version INTEGER NOT NULL,original_chat_phone INTEGER);
CREATE TABLE app_records(namespace TEXT NOT NULL,record_key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace,record_key));
CREATE TABLE away_replies(day TEXT NOT NULL,event_hash TEXT NOT NULL,PRIMARY KEY(day,event_hash));
`;

export function records(db,namespace){
  return {
    get:key=>db.use(async s=>(await s.get('SELECT value FROM app_records WHERE namespace=? AND record_key=?',[namespace,key]))?.value),
    put:(key,value)=>db.use(s=>s.run('INSERT INTO app_records VALUES(?,?,?) ON CONFLICT(namespace,record_key) DO UPDATE SET value=excluded.value',[namespace,key,value])),
    drop:key=>db.use(s=>s.run('DELETE FROM app_records WHERE namespace=? AND record_key=?',[namespace,key])),
    keys:()=>db.use(async s=>(await s.all('SELECT record_key FROM app_records WHERE namespace=?',[namespace])).map(r=>r.record_key))
  };
}
export function replyMarkers(db){
  return {
    claim:(day,hash)=>db.use(async s=>(await s.run('INSERT OR IGNORE INTO away_replies VALUES(?,?)',[day,hash])).changes===1),
    prune:before=>db.use(s=>s.run('DELETE FROM away_replies WHERE day<?',[before]))
  };
}
