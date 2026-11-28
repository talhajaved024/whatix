import {Router} from 'express';
import {campaignPhone} from './session-phones.js';
import {badPage,pageMeta,pageRequest,searchTerm} from './paging.js';
import {isBusinessLabel} from './business-labels.js';
export {campaignPhone};

// Campaign assignments: which regular users work in which campaign number,
// the labels they see there, and the customers assigned to them in it.
// Tables: campaign_grants, campaign_grant_labels, campaign_contacts (sqlite.js).
const fail=(status,message)=>Object.assign(Error(message),{status});
const validPhone=value=>Number.isSafeInteger(value) && value>0 && value<=999999999999999;
const unique=error=>/UNIQUE constraint failed/.test(error?.message);
const now=()=>new Date().toISOString();
const contactSelect=`SELECT c.ID AS id,c.phone_number AS phoneNumber,u.USER_NAME AS username,
 c.assigned_at AS assignedAt,a.USER_NAME AS assignedBy
 FROM campaign_contacts c JOIN campaign_grants g ON g.ID=c.grant_id JOIN users u ON u.ID=g.user_id
 LEFT JOIN users a ON a.ID=c.assigned_by`;

export function campaignStore(db){
  // Bumped on every write so callers can cache reads within this process.
  let version=0;
  const changed=result=>{version++;return result;};
  const grantId=async(s,name,phone,userId)=>(await s.get('SELECT ID FROM campaign_grants WHERE session=? AND campaign_phone=? AND user_id=?',[name,phone,userId]))?.ID;
  async function regularGrant(s,name,phone,username){
    const row=await s.get(`SELECT g.ID FROM campaign_grants g JOIN users u ON u.ID=g.user_id
      WHERE g.session=? AND g.campaign_phone=? AND u.USER_NAME=? AND u.IS_ADMIN=0`,[name,phone,username]);
    if(!row)throw fail(422,'Assign this campaign to the user first');
    return row.ID;
  }
  return {
    version:()=>version,
    // One user's grant in one campaign, or null.
    get:(name,phone,userId)=>db.use(async s=>{
      const id=await grantId(s,name,phone,userId);
      if(!id)return null;
      const {labels_limited:limited}=await s.get('SELECT labels_limited FROM campaign_grants WHERE ID=?',[id]);
      const labels=limited?(await s.all('SELECT label_id FROM campaign_grant_labels WHERE grant_id=? ORDER BY label_id',[id])).map(r=>r.label_id):null;
      const contacts=await s.all('SELECT ID AS id,phone_number AS phoneNumber FROM campaign_contacts WHERE grant_id=? ORDER BY ID',[id]);
      return {name,phone,userId,labels,contacts};
    }),
    // Every user granted this campaign, with their labels (null: every label),
    // customer count and who assigned it.
    grants:(name,phone)=>db.use(async s=>{
      const rows=await s.all(`SELECT g.user_id AS userId,g.labels_limited AS limited,l.label_id AS label,g.assigned_at AS assignedAt,a.USER_NAME AS assignedBy,
        (SELECT COUNT(*) FROM campaign_contacts c WHERE c.grant_id=g.ID) AS customers
        FROM campaign_grants g LEFT JOIN campaign_grant_labels l ON l.grant_id=g.ID LEFT JOIN users a ON a.ID=g.assigned_by
        WHERE g.session=? AND g.campaign_phone=? ORDER BY g.user_id,l.label_id`,[name,phone]);
      const grants=new Map();
      for(const row of rows){
        if(!grants.has(row.userId))grants.set(row.userId,{userId:row.userId,labels:row.limited?[]:null,customers:row.customers,assignedAt:row.assignedAt,assignedBy:row.assignedBy});
        if(row.label!==null && row.limited)grants.get(row.userId).labels.push(row.label);
      }
      return [...grants.values()];
    }),
    // Users granted one campaign.
    userIdsFor:(name,phone)=>db.use(async s=>(await s.all('SELECT user_id FROM campaign_grants WHERE session=? AND campaign_phone=?',[name,phone])).map(r=>r.user_id)),
    // One page of a campaign's assigned customers; q matches the customer's digits.
    contactPage:(name,phone,{username,q='',offset,pageSize})=>db.use(async s=>{
      const digits=q.replace(/\D/g,'');
      const where=' WHERE g.session=? AND g.campaign_phone=?'+(username===undefined?'':' AND u.USER_NAME=?')+(digits?' AND instr(CAST(c.phone_number AS TEXT),?)>0':'');
      const params=[name,phone,...(username===undefined?[]:[username]),...(digits?[digits]:[])];
      const {total}=await s.get(`SELECT COUNT(*) AS total FROM campaign_contacts c JOIN campaign_grants g ON g.ID=c.grant_id
        JOIN users u ON u.ID=g.user_id`+where,params);
      const rows=await s.all(contactSelect+where+' ORDER BY u.USER_NAME,c.phone_number LIMIT ? OFFSET ?',[...params,pageSize,offset]);
      return {rows,total};
    }),
    // Campaigns granted to one user, as {session, phone}.
    forUser:userId=>db.use(s=>s.all('SELECT session,campaign_phone AS phone FROM campaign_grants WHERE user_id=?',[userId])),
    contacts:(name,phone,username)=>db.use(s=>s.all(contactSelect+' WHERE g.session=? AND g.campaign_phone=?'+
      (username===undefined?'':' AND u.USER_NAME=?')+' ORDER BY u.USER_NAME,c.phone_number',
      username===undefined?[name,phone]:[name,phone,username])),
    // Create or update a grant. labels: null for every label on the number, or
    // the only labels the user may see. Granting the primary inbox for the first
    // time carries over the user's legacy assigned numbers.
    grant:(name,phone,userId,labels,primary,actor=null)=>db.transaction(async s=>{
      const user=await s.get('SELECT USER_NAME,IS_ADMIN FROM users WHERE ID=?',[userId]);
      if(!user || user.IS_ADMIN)throw fail(422,'Choose a regular user');
      let id=await grantId(s,name,phone,userId);
      const created=!id;
      if(!id){
        id=(await s.run('INSERT INTO campaign_grants(session,campaign_phone,user_id,assigned_at,assigned_by) VALUES(?,?,?,?,?)',[name,phone,userId,now(),actor])).id;
        if(primary){
          await s.run('INSERT OR IGNORE INTO campaign_contacts(grant_id,phone_number,assigned_at,assigned_by) SELECT ?,phone_number,?,? FROM assigned_numbers WHERE user_name=? ORDER BY ID',[id,now(),actor,user.USER_NAME]);
          await s.run('DELETE FROM assigned_numbers WHERE user_name=?',[user.USER_NAME]);
        }
      }
      await s.run('UPDATE campaign_grants SET labels_limited=? WHERE ID=?',[labels===null?0:1,id]);
      await s.run('DELETE FROM campaign_grant_labels WHERE grant_id=?',[id]);
      for(const label of labels??[])await s.run('INSERT INTO campaign_grant_labels VALUES(?,?)',[id,label]);
      changed();
      // created: the user did not hold this number before (a later call only changes labels).
      return {created,username:user.USER_NAME};
    }),
    // Move one customer to a single user on this number (the chat list's
    // assignee menu): that user gets it, keeping their assignment if they
    // already had it, and every other user on this number loses it. One
    // transaction, so the customer is never left half-moved.
    reassign:(name,phone,phoneNumber,username,actor=null)=>db.transaction(async s=>{
      if(typeof username!=='string' || !username)throw fail(400,'Choose a user');
      if(!validPhone(phoneNumber))throw fail(400,'Enter a valid customer phone number');
      const grant=await regularGrant(s,name,phone,username);
      const previous=(await s.all(`SELECT u.USER_NAME AS username FROM campaign_contacts c JOIN campaign_grants g ON g.ID=c.grant_id
        JOIN users u ON u.ID=g.user_id WHERE g.session=? AND g.campaign_phone=? AND c.phone_number=? AND c.grant_id<>? ORDER BY u.USER_NAME`,
        [name,phone,phoneNumber,grant])).map(row=>row.username);
      await s.run(`DELETE FROM campaign_contacts WHERE phone_number=? AND grant_id<>?
        AND grant_id IN (SELECT ID FROM campaign_grants WHERE session=? AND campaign_phone=?)`,[phoneNumber,grant,name,phone]);
      const kept=await s.get('SELECT ID,assigned_at FROM campaign_contacts WHERE grant_id=? AND phone_number=?',[grant,phoneNumber]);
      const at=now();
      const id=kept?kept.ID:(await s.run('INSERT INTO campaign_contacts(grant_id,phone_number,assigned_at,assigned_by) VALUES(?,?,?,?)',[grant,phoneNumber,at,actor])).id;
      changed();
      // fresh: the user did not have this customer before (told to the user, not sent to the browser).
      return {id,phoneNumber,username,assignedAt:kept?kept.assigned_at:at,removedFrom:previous,fresh:!kept};
    }),
    // Removing a grant also removes its labels and assigned customers.
    revoke:(name,phone,userId)=>db.use(async s=>changed((await s.run('DELETE FROM campaign_grants WHERE session=? AND campaign_phone=? AND user_id=?',[name,phone,userId])).changes)),
    contact:(name,phone,method,id,body,actor=null)=>db.transaction(async s=>{
      if(body.username!==undefined && typeof body.username!=='string')throw fail(400,'Choose a user');
      if(body.phoneNumber!==undefined && !validPhone(body.phoneNumber))throw fail(400,'Enter a valid customer phone number');
      if(method==='POST'){
        if(body.username===undefined || body.phoneNumber===undefined)throw fail(400,'Send a customer phoneNumber and a username');
        const grant=await regularGrant(s,name,phone,body.username);
        const at=now();
        try{id=(await s.run('INSERT INTO campaign_contacts(grant_id,phone_number,assigned_at,assigned_by) VALUES(?,?,?,?)',[grant,body.phoneNumber,at,actor])).id;}
        catch(error){if(unique(error))throw fail(409,'Customer is already assigned to this user');throw error;}
        changed();
        return {id,phoneNumber:body.phoneNumber,username:body.username,assignedAt:at};
      }
      const old=/^[1-9]\d{0,15}$/.test(id) && await s.get(`SELECT c.ID,c.grant_id,c.phone_number,u.USER_NAME FROM campaign_contacts c
        JOIN campaign_grants g ON g.ID=c.grant_id JOIN users u ON u.ID=g.user_id WHERE c.ID=? AND g.session=? AND g.campaign_phone=?`,[Number(id),name,phone]);
      if(!old)throw fail(404,'Assignment no longer exists');
      if(method==='DELETE'){await s.run('DELETE FROM campaign_contacts WHERE ID=?',[old.ID]);changed();return;}
      const grant=body.username===undefined?old.grant_id:await regularGrant(s,name,phone,body.username);
      const number=body.phoneNumber??old.phone_number;
      // Any change is a fresh assignment by this admin.
      const at=now();
      try{await s.run('UPDATE campaign_contacts SET grant_id=?,phone_number=?,assigned_at=?,assigned_by=? WHERE ID=?',[grant,number,at,actor,old.ID]);}
      catch(error){if(unique(error))throw fail(409,'Customer is already assigned to this user');throw error;}
      changed();
      return {id:old.ID,phoneNumber:number,username:body.username??old.USER_NAME,assignedAt:at};
    })
  };
}

// Mounted inside each inbox router. identity({fresh}) resolves the inbox's
// current campaign phone; writes name the phone the admin was looking at.
// onAssigned({username,phoneNumber,campaignPhone,actor}) is told of every customer
// newly assigned to a user (actor: the admin's username), after it is saved;
// onGranted({username,campaignPhone,actor}) of every user newly given this number.
export function campaignRoutes({store,session,primary,identity,adminAccess,readLabels,onAssigned,onGranted}){
  const router=Router();
  // Telling the user must never undo or fail the assignment itself.
  const assigned=(req,phone,contact)=>{
    try{Promise.resolve(onAssigned?.({username:contact.username,phoneNumber:contact.phoneNumber,campaignPhone:phone,actor:req.auth.sub})).catch(()=>{});}
    catch{ /* the assignment is saved */ }
  };
  const run=fn=>async(req,res)=>{
    try{
      const phone=await identity({fresh:req.method!=='GET'});
      if(!phone)throw fail(409,'Campaign number is disconnected');
      if(req.method!=='GET' && req.get('X-Campaign-Phone')!==phone)throw fail(409,'Campaign number changed. Refresh before saving.');
      await fn(req,res,phone);
    }catch(err){res.status(err.status||503).json({error:err.status?err.message:'Campaign unavailable'});}
  };
  const userId=value=>{
    const id=Number(value);
    if(!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id))throw fail(400,'Invalid user ID');
    return id;
  };
  router.get('/campaign-grants',adminAccess,run(async(req,res,phone)=>{
    res.json({phone,grants:await store.grants(session,phone)});
  }));
  router.put('/campaign-grants/:id',adminAccess,run(async(req,res,phone)=>{
    const id=userId(req.params.id);
    // labels: null for every label on this number, or the only labels allowed.
    const ids=req.body?.labels;
    if(ids!==null && (!Array.isArray(ids)||ids.length>200||ids.some(label=>typeof label!=='string'||!/^[-\w]{1,100}$/.test(label))))throw fail(400,'Send labels as null (every label) or a list of label IDs');
    if(ids?.length){const labels=(await readLabels()).filter(isBusinessLabel);if(ids.some(label=>!labels.some(l=>String(l.id)===label)))throw fail(422,'A selected label is unavailable');}
    const granted=await store.grant(session,phone,id,ids===null?null:[...new Set(ids)],primary,req.userId);
    if(granted.created){
      try{Promise.resolve(onGranted?.({username:granted.username,campaignPhone:phone,actor:req.auth.sub})).catch(()=>{});}
      catch{ /* the number is assigned */ }
    }
    res.sendStatus(204);
  }));
  router.delete('/campaign-grants/:id',adminAccess,run(async(req,res,phone)=>{
    await store.revoke(session,phone,userId(req.params.id));res.sendStatus(204);
  }));
  router.get('/campaign-contacts',run(async(req,res,phone)=>{
    if(req.campaign){
      return res.json({assignments:[...req.campaign.numbers].map(n=>({id:n,phoneNumber:Number(n),username:req.auth.sub}))});
    }
    const username=typeof req.query.username==='string' && req.query.username?req.query.username:undefined;
    const paging=pageRequest(req.query),q=searchTerm(req.query.q);
    if(paging===false || q===false)return badPage(res);
    if(!paging)return res.json({phone,assignments:await store.contacts(session,phone,username)});
    const {rows,total}=await store.contactPage(session,phone,{username,q,...paging});
    res.json({phone,assignments:rows,...pageMeta(paging,total)});
  }));
  // Body {phoneNumber, username}: the customer ends up assigned to that user
  // only. Returns {id, phoneNumber, username, assignedAt, removedFrom:[usernames]}.
  router.put('/campaign-contacts/reassign',adminAccess,run(async(req,res,phone)=>{
    const {fresh,...moved}=await store.reassign(session,phone,req.body?.phoneNumber,req.body?.username,req.userId);
    if(fresh)assigned(req,phone,moved);
    res.json(moved);
  }));
  for(const [method,path] of [['post','/campaign-contacts'],['patch','/campaign-contacts/:id'],['delete','/campaign-contacts/:id']]){
    router[method](path,adminAccess,run(async(req,res,phone)=>{
      const contact=await store.contact(session,phone,req.method,req.params.id,req.body||{},req.userId);
      if(!contact)return res.sendStatus(204);
      // A new assignment, or an edit (which counts as a fresh assignment by this admin).
      assigned(req,phone,contact);
      res.status(method==='post'?201:200).json(contact);
    }));
  }
  return router;
}
