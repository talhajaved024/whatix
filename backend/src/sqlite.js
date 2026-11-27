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

// Schema version 2: campaigns. A grant lets one regular user work in one
// campaign number (a WAHA session paired to campaign_phone). Re-pairing the
// session to another phone leaves old grants inert rather than moving them.
export const campaignSchema=`
CREATE TABLE campaign_grants(ID INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT NOT NULL,
 campaign_phone TEXT NOT NULL CHECK(campaign_phone GLOB '[1-9]*' AND length(campaign_phone)<=15),
 user_id INTEGER NOT NULL REFERENCES users(ID) ON DELETE CASCADE,UNIQUE(session,campaign_phone,user_id));
CREATE INDEX campaign_grants_user ON campaign_grants(user_id);
CREATE TABLE campaign_grant_labels(grant_id INTEGER NOT NULL REFERENCES campaign_grants(ID) ON DELETE CASCADE,
 label_id TEXT NOT NULL,PRIMARY KEY(grant_id,label_id)) WITHOUT ROWID;
CREATE TABLE campaign_contacts(ID INTEGER PRIMARY KEY AUTOINCREMENT,
 grant_id INTEGER NOT NULL REFERENCES campaign_grants(ID) ON DELETE CASCADE,
 phone_number INTEGER NOT NULL CHECK(phone_number BETWEEN 1 AND 999999999999999),UNIQUE(grant_id,phone_number));
`;
// Schema version 3: who made each campaign assignment, and when (ISO time).
export const auditSchema=`
ALTER TABLE campaign_grants ADD COLUMN assigned_at TEXT;
ALTER TABLE campaign_grants ADD COLUMN assigned_by INTEGER REFERENCES users(ID) ON DELETE SET NULL;
ALTER TABLE campaign_contacts ADD COLUMN assigned_at TEXT;
ALTER TABLE campaign_contacts ADD COLUMN assigned_by INTEGER REFERENCES users(ID) ON DELETE SET NULL;
`;
// Schema version 4: indexes for paged grids (requirements by date received).
export const indexSchema=`
CREATE INDEX IF NOT EXISTS requirements_received ON "offline requirements"(DATE_RECIEVED,ID);
`;
// Schema version 5: a user sees every business label on a campaign number
// unless an admin limited them (labels_limited=1) to campaign_grant_labels.
// Grants that already listed labels stay limited to them.
export const labelScopeSchema=`
ALTER TABLE campaign_grants ADD COLUMN labels_limited INTEGER NOT NULL DEFAULT 0 CHECK(labels_limited IN (0,1));
UPDATE campaign_grants SET labels_limited=1 WHERE EXISTS(SELECT 1 FROM campaign_grant_labels l WHERE l.grant_id=campaign_grants.ID);
`;
// Schema version 6: which of our WhatsApp numbers received each offline
// requirement: the session (inbox) and its phone at the time. Rows without
// them (older ones, and the main-number AI intake) belong to the main number.
export const receivedBySchema=`
ALTER TABLE "offline requirements" ADD COLUMN RECEIVED_SESSION TEXT CHECK(RECEIVED_SESSION IS NULL OR (length(RECEIVED_SESSION) BETWEEN 1 AND 100 AND RECEIVED_SESSION NOT GLOB '*[^A-Za-z0-9_-]*'));
ALTER TABLE "offline requirements" ADD COLUMN RECEIVED_BY TEXT CHECK(RECEIVED_BY IS NULL OR (length(RECEIVED_BY) BETWEEN 7 AND 15 AND RECEIVED_BY GLOB '[1-9]*' AND RECEIVED_BY NOT GLOB '*[^0-9]*'));
CREATE INDEX IF NOT EXISTS requirements_received_session ON "offline requirements"(RECEIVED_SESSION);
`;
// Schema version 7: an account an admin created, or whose password an admin
// reset, must choose its own password at the next sign-in (the admin knows the
// one they typed). Existing accounts are not affected.
export const passwordChangeSchema=`
ALTER TABLE users ADD COLUMN MUST_CHANGE_PASSWORD INTEGER NOT NULL DEFAULT 0 CHECK(MUST_CHANGE_PASSWORD IN (0,1));
`;
export const SCHEMA_VERSION=7;

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
