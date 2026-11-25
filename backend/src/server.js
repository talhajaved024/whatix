import { requirementStore, requirementRange, senderPhone } from './offline-requirements.js';
import 'dotenv/config';
import { dirname, join, resolve } from 'node:path';
import { sentMessages, validMessageId } from './sent-messages.js';
import { businessLabelRoutes } from './business-labels.js';
import { labelDeletionRoutes } from './label-deletion.js';
import { personalChats } from './personal-chats.js';
import { callEvents, createCalls } from './calls.js';
import { broadcastQueue, broadcastSender } from './broadcasts.js';
import { awayResponder, intakeModel, listenForAwayMessages } from './away-replies.js';
import { busyResponder } from './busy-replies.js';
import { chatCoverage } from './coverage.js';
import { waitingAlerts } from './waiting-alerts.js';
import { teamChat } from './team-chat.js';
import { openWhatix } from './whatix.js';
import { accountStore } from './accounts.js';
import { records, replyMarkers } from './sqlite.js';
import { assignmentStore } from './assigned-numbers.js';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';

const required = ['JWT_ACCESS_SECRET','JWT_REFRESH_SECRET','WAHA_API_KEY'];
for (const k of required) if (!process.env[k]) throw new Error(`Missing ${k} in backend environment`);
if (process.env.JWT_ACCESS_SECRET.length < 32 || process.env.JWT_REFRESH_SECRET.length < 32 || process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) throw new Error('Use distinct random JWT secrets at least 32 chars long');
const production = process.env.NODE_ENV === 'production';
if (production && process.env.ADMIN_PASSWORD === 'admin' && process.env.ALLOW_INSECURE_DEMO_CREDENTIALS !== 'true') throw new Error('Default admin password blocked in production. Change ADMIN_PASSWORD before deploying.');
const USERNAME = process.env.ADMIN_USERNAME || 'admin';
const roleOf = username => sessions.get(username)?.isAdmin ? (username===USERNAME ? 'super_user' : 'admin') : 'user';
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const WAHA = (process.env.WAHA_URL || 'http://127.0.0.1:3000').replace(/\/$/,'');
const SESSION = process.env.WAHA_SESSION || 'TEST_BULK';
const usersPath=resolve(process.env.USER_WORKBOOK_PATH || 'data/users.xlsx');
const dataDir=dirname(usersPath);
const {db,cipher}=await openWhatix({
  path:resolve(process.env.WHATIX_DB_PATH || join(dataDir,'whatix.db')),usersPath,
  assignedPath:resolve(process.env.ASSIGNED_NUMBERS_PATH || join(dataDir,'assigned_numbers.xlsx')),
  admin:USERNAME,bootstrapPassword:process.env.ADMIN_PASSWORD,legacyJson:process.env.APP_USERS_JSON,
  secret:process.env.WHATIX_PASSWORD_SECRET || ACCESS_SECRET
});
const accounts=accountStore(db,USERNAME,cipher);
const assigned=assignmentStore(db);
const requirements=requirementStore(db);
const sessionKey=crypto.createHash('sha256').update(SESSION).digest('hex');
// Which chats signed-in staff can see: admins and the super user see all,
// regular users see their manually assigned numbers and assigned requirements.
const coverage=chatCoverage({
  onlineStaff:()=>[...sessions.keys()].map(username=>currentSession(username)).filter(Boolean)
    .map(session=>({username:session.username,userId:session.userId,isAdmin:!!session.isAdmin || session.username===USERNAME})),
  numbersFor:async member=>[...(await assigned.list(member.username)).map(row=>row.phoneNumber),...await requirements.numbersFor(member.userId)],
  phoneFor:chatId=>senderPhone(chatId,WAHA,SESSION,wahaHeaders)
});
// "+92… is waiting for your reply" notifications for the header bell.
const alerts=waitingAlerts();
const sent=sentMessages(records(db,'sent'),SESSION);
const PORT = Number(process.env.PORT || 8080);
const COOKIE_SECURE = production;
const sessions = new Map(); // One active session per username on this backend process.
const idleWarningMs = 5 * 60_000;
const idleGraceMs = 2 * 60_000;
const allowedOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(helmet({contentSecurityPolicy:false,crossOriginResourcePolicy:{policy:'cross-origin'}}));
app.use(express.json({limit:'52mb'}));
app.use(cookieParser());
app.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Vary','Origin');
  if (req.headers.origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin',allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials','true');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
  }
  if(req.method==='OPTIONS') return res.sendStatus(req.headers.origin === allowedOrigin ? 204:403);
  if(!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== allowedOrigin) return res.status(403).json({error:'Origin not allowed'});
  next();
});
// Only failed login attempts count; normal refreshes must never lock out sign-in.
function createLoginLimiter(){
  return rateLimit({windowMs:15*60*1000,limit:10,skipSuccessfulRequests:true,requestWasSuccessful:(_req,res)=>res.statusCode<400 || res.statusCode===409,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Too many failed login attempts. Try again in 15 minutes.'}});
}
const adminLoginLimiter=createLoginLimiter();
const regularLoginLimiter=createLoginLimiter();
function limitLogin(req,res,next){
  const encoded=req.body?.credentials;
  if(typeof encoded==='string' && encoded.length<=4096 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)){
    try{req.loginCredentials=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));}catch{}
  }
  const limiter=req.loginCredentials?.username===USERNAME ? adminLoginLimiter : regularLoginLimiter;
  return limiter(req,res,next);
}
const cookieBase={httpOnly:true,secure:COOKIE_SECURE,sameSite:'strict',path:'/'};
const tokenCookie={...cookieBase,maxAge:15*60*1000};
const refreshCookie={...cookieBase,path:'/api/auth',maxAge:7*24*60*60*1000};
function endSession(session,reason){
  if(sessions.get(session.username)!==session) return;
  sessions.delete(session.username);
  coverage.changed().catch(()=>{});
  clearTimeout(session.idleTimer);
  for(const close of session.streams) close(reason);
}
function currentSession(username,now=Date.now()){
  const session=sessions.get(username);
  if(session && Math.min(session.expiresAt,session.idleExpiresAt)<=now){
    endSession(session);
    return null;
  }
  return session;
}
function recordActivity(session,now){
  session.lastActiveAt=now;
  session.idleWarningAt=now+idleWarningMs;
  session.idleExpiresAt=session.idleWarningAt+idleGraceMs;
  clearTimeout(session.idleTimer);
  session.idleTimer=setTimeout(()=>{
    endSession(session);
  },idleWarningMs+idleGraceMs);
  session.idleTimer.unref();
}
function idleStatus(session){
  return {serverNow:Date.now(),idleWarningAt:session.idleWarningAt,idleExpiresAt:session.idleExpiresAt};
}
function issue(res,user,session){
  const jti=crypto.randomUUID();
  const sid=session.id;
  const access=jwt.sign({sub:user,typ:'access',sid},ACCESS_SECRET,{algorithm:'HS256',expiresIn:'15m',issuer:'wa-bulk'});
  const refresh=jwt.sign({sub:user,typ:'refresh',sid,jti},REFRESH_SECRET,{algorithm:'HS256',expiresIn:'7d',issuer:'wa-bulk'});
  session.jti=jti;
  session.expiresAt=jwt.decode(refresh).exp*1000;
  sessions.set(user,session);
  res.cookie('wa_access',access,tokenCookie);
  res.cookie('wa_refresh',refresh,refreshCookie);
  return {username:user,name:session.name||user,role:roleOf(user),expiresIn:900,...idleStatus(session)};
}
function clear(res){res.clearCookie('wa_access',cookieBase);res.clearCookie('wa_refresh',{...cookieBase,path:'/api/auth'});}
function sessionClaims(token,secret,type){
  if(!token) return null;
  try {
    const claims=jwt.verify(token,secret,{algorithms:['HS256'],issuer:'wa-bulk'});
    const session=currentSession(claims.sub);
    if(!session || claims.typ!==type || claims.sid!==session.id) return null;
    if(type==='refresh' && claims.jti!==session.jti) return null;
    return claims;
  }catch{return null;}
}
function refreshClaims(req){return sessionClaims(req.cookies?.wa_refresh,REFRESH_SECRET,'refresh');}
function accessClaims(req){
  const token=req.cookies?.wa_access || (/^Bearer (.+)$/.exec(req.headers.authorization || '')||[])[1];
  return sessionClaims(token,ACCESS_SECRET,'access');
}
function protectedRoute(req,res,next){
  const claims=accessClaims(req);
  if(!claims) {
    const refreshable=req.originalUrl.split('?')[0]==='/api/auth/me' && Boolean(refreshClaims(req));
    return res.status(401).json({error:'Authentication required',refreshable});
  }
  req.auth=claims;
  req.userId=sessions.get(claims.sub).userId;
  next();
}
app.post('/api/auth/login',limitLogin,async(req,res)=>{
  const obj=req.loginCredentials;
  if(obj===undefined)return res.status(400).json({error:'Invalid credentials format'});
  const user=obj?.username;
  if(typeof user!=='string'||typeof obj.password!=='string')return res.status(401).json({error:'Invalid username or password'});
  try{
    const result=await accounts.login(user,obj.password,req.ip,(account,commit)=>{
      const session=currentSession(user);
      const browser=refreshClaims(req)||accessClaims(req);
      if(browser && browser.sub!==user)return {status:409,error:'Log out of the current account before switching users.'};
      if(session && browser?.sub!==user)return {status:409,error:'This account is already signed in. Log out of the other browser before signing in here.'};
      if(!commit)return {status:200};
      const owner=session || {userId:account.id,isAdmin:account.isAdmin,username:user,id:crypto.randomUUID(),listId:crypto.randomUUID(),startedAt:Date.now(),streams:new Set()};
      // Full name from the NAME column, shown in the header pill.
      owner.name=typeof account.name==='string' && account.name.trim()?account.name.trim():user;
      recordActivity(owner,Date.now());
      return {status:200,body:issue(res,user,owner)};
    });
    // Sign-in completes only once chat coverage knows which chats this user
    // can see, so the automatic replies pause for them straight away.
    if(result.status===200){await coverage.changed().catch(()=>{});return res.json(result.body);}
    res.status(result.status).json({error:result.error || (result.status===403?'Login is banned. Contact your admin.':'Invalid username or password')});
  }catch{res.status(503).json({error:'Account database unavailable.'});}
});
app.post('/api/auth/refresh',(req,res)=>{
  const claims=refreshClaims(req);
  if(!claims) return res.status(401).json({error:'Session expired'});
  res.json(issue(res,claims.sub,sessions.get(claims.sub)));
});
app.post('/api/auth/logout',(req,res)=>{
  const claims=refreshClaims(req) || accessClaims(req);
  if(claims) endSession(sessions.get(claims.sub));
  clear(res);res.json({ok:true});
});
app.get('/api/auth/me',protectedRoute,(req,res)=>res.json({username:req.auth.sub,name:sessions.get(req.auth.sub)?.name||req.auth.sub,role:roleOf(req.auth.sub),expiresIn:req.auth.exp-Math.floor(Date.now()/1000),...idleStatus(sessions.get(req.auth.sub))}));
app.post('/api/auth/activity',protectedRoute,(req,res)=>{
  const now=Date.now();
  const session=currentSession(req.auth.sub,now);
  if(!session) return res.status(401).json({error:'Session expired'});
  if(now>=session.idleWarningAt && req.body?.keepSession!==true) {
    return res.status(409).json({error:'Choose Keep session to continue.',...idleStatus(session)});
  }
  recordActivity(session,now);
  res.json(idleStatus(session));
});
function adminAccess(req,res,next){
  if(roleOf(req.auth.sub)==='user')return res.status(403).json({error:'Admin access required'});
  next();
}
async function requirementAssignees(){
  const users=(await accounts.list()).filter(account=>!account.isAdmin && account.username!==USERNAME);
  return new Map(users.map(({id,name,username})=>[id,{id,name,username}]));
}
function requirementProfile(row,users){
  const {assignedUserIds,...details}=row;
  return {...details,assignedUsers:assignedUserIds.map(id=>users.get(id)).filter(Boolean)};
}
app.get('/api/admin/offline-requirements/assignees',protectedRoute,adminAccess,async(_req,res)=>{
  try{res.json({users:[...(await requirementAssignees()).values()]});}
  catch{res.status(503).json({error:'Account directory unavailable'});}
});
app.use(['/api/admin/assigned-numbers','/api/admin/offline-requirements'],(req,res,next)=>{
  if(req.method!=='GET')res.on('finish',()=>{if(res.statusCode<300)coverage.changed().catch(()=>{});});
  next();
});
app.patch('/api/admin/offline-requirements/:id/assignees',protectedRoute,adminAccess,async(req,res)=>{
  const id=Number(req.params.id);
  const {userIds,expectedUserIds}=req.body??{};
  const validIds=ids=>Array.isArray(ids) && ids.every(i=>Number.isSafeInteger(i) && i>0) && new Set(ids).size===ids.length;
  if(!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(id) || id<1 || !validIds(userIds) || (expectedUserIds!==undefined && !validIds(expectedUserIds))){
    return res.status(400).json({error:'Expected a requirement ID and arrays of distinct numeric account IDs'});
  }
  try{
    const users=await requirementAssignees();
    if(!userIds.every(userId=>users.has(userId)))return res.status(422).json({error:'Select existing regular users only'});
    const result=await requirements.setAssignees(id,userIds,expectedUserIds,users);
    if(result.status===404)return res.status(404).json({error:'Requirement not found'});
    if(result.status===409)return res.status(409).json({error:'Assignments changed. Refresh before saving.'});
    res.json({requirement:requirementProfile(result.requirement,users)});
  }catch{res.status(503).json({error:'Could not save requirement assignments'});}
});
app.get('/api/admin/offline-requirements',protectedRoute,adminAccess,async(req,res)=>{
  const range=requirementRange(req.query);
  if(!range)return res.status(400).json({error:'Use valid YYYY-MM-DD dates with from on or before to'});
  try{
    const [rows,users]=await Promise.all([requirements.list(range),requirementAssignees()]);
    res.json({...range,requirements:rows.map(row=>requirementProfile(row,users))});
  }
  catch{res.status(503).json({error:'Offline requirements database unavailable'});}
});
function superUserOnly(req,res,next){
  if(roleOf(req.auth.sub)!=='super_user') return res.status(403).json({error:'Super user access required'});
  next();
}
const accountFields={
  username:v=>typeof v==='string' && !!v.trim() && v===v.trim() && v.length<=64,
  name:v=>typeof v==='string' && !!v.trim() && v.length<=128,
  password:v=>typeof v==='string' && v.length>=8 && v.length<=256,
  phoneNumber:v=>v===null || (Number.isSafeInteger(v) && v>0 && v<=999999999999999),
  isAdmin:v=>typeof v==='boolean',
  banLogin:v=>typeof v==='boolean'
};
function validFields(fields){
  return fields && typeof fields==='object' && !Array.isArray(fields) && Object.keys(fields).length>0 &&
    Object.entries(fields).every(([key,value])=>Object.hasOwn(accountFields,key) && accountFields[key](value));
}
function userProfile(account){
  return {...account,isSuperUser:account.username===USERNAME,sessionId:currentSession(account.username)?.listId??null};
}
app.get('/api/admin/username-availability',protectedRoute,adminAccess,async(req,res)=>{
  const username=req.query.username;
  if(!accountFields.username(username))return res.status(400).json({error:'Invalid username'});
  try{res.json({available:await accounts.usernameAvailable(username)});}
  catch{res.status(503).json({error:'Account database unavailable'});}
});
app.post('/api/admin/users',protectedRoute,adminAccess,async(req,res)=>{
  const {username,password,name=username,phoneNumber=null,isAdmin=false,banLogin=false}=req.body || {};
  if(!validFields({username,password,name,phoneNumber,isAdmin,banLogin})){
    return res.status(400).json({error:'Invalid account details. Check name, username, password, numeric phone and checkbox values.'});
  }
  if(isAdmin && roleOf(req.auth.sub)!=='super_user')return res.status(403).json({error:'Only the super user can grant admin access'});
  try{
    const account=await accounts.add({username,password,name:name.trim(),phoneNumber,isAdmin,banLogin});
    if(!account)return res.status(409).json({error:'Username already in use'});
    res.status(201).json({...account,role:account.isAdmin?'admin':'user'});
  }catch{res.status(503).json({error:'Could not update the account database.'});}
});
app.get('/api/admin/users',protectedRoute,adminAccess,async(_req,res)=>{
  try{
    const users=(await accounts.list()).map(userProfile);
    res.json({users});
  }catch{res.status(503).json({error:'Account database unavailable'});}
});
function revokeAccount(account){
  const session=currentSession(account.username);
  if(session && session.userId===account.id)endSession(session,'admin_revoked');
}
app.route('/api/admin/users/:id')
  .all(protectedRoute,adminAccess,(req,res,next)=>{
    const id=Number(req.params.id);
    if(!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id))return res.status(400).json({error:'Invalid user ID'});
    req.accountId=id;
    next();
  })
  .get(async(req,res)=>{
    try{
      const account=await accounts.get(req.accountId);
      if(!account)return res.status(404).json({error:'User not found'});
      res.json(userProfile(account));
    }catch{res.status(503).json({error:'Account database unavailable'});}
  })
  .patch(async(req,res)=>{
    if(!validFields(req.body))return res.status(400).json({error:'Invalid or unsupported profile fields'});
    try{
      const allowed=account=>{return canManageAccount(req.auth.sub,account) &&
        (roleOf(req.auth.sub)==='super_user' || (!Object.hasOwn(req.body,'username') && !Object.hasOwn(req.body,'isAdmin')));};
      const result=await accounts.update(req.accountId,req.body,allowed,revokeAccount);
      if(result.status===200){
        // A display-name change shows in that user's header without signing in again.
        const live=sessions.get(result.user.username);
        if(live && typeof result.user.name==='string' && result.user.name.trim()){
          live.name=result.user.name.trim();
          teamChatServer.rename(result.user.id,live.name);
        }
        return res.json(userProfile(result.user));
      }
      const errors={403:'You cannot change this profile or the selected fields',404:'User not found',409:'Username already in use'};
      res.status(result.status).json({error:errors[result.status]});
    }catch{res.status(503).json({error:'Could not update the account database.'});}
  })
  .delete(async(req,res)=>{
    try{
      const status=await accounts.remove(req.accountId,account=>canManageAccount(req.auth.sub,account),revokeAccount);
      if(status===204){teamChatServer.forget(req.accountId);return res.sendStatus(204);}
      res.status(status).json({error:status===403?'You cannot delete this profile':'User not found'});
    }catch{res.status(503).json({error:'Could not update the account database.'});}
  });
function canManageAccount(actor,target){
  const role=roleOf(actor);
  return actor!==target.username && target.username!==USERNAME &&
    (role==='super_user' || (role==='admin' && !target.isAdmin));
}
app.post('/api/admin/users/:id/ban',protectedRoute,adminAccess,async(req,res)=>{
  const {banLogin}=req.body || {};
  if(typeof banLogin!=='boolean')return res.status(400).json({error:'banLogin must be a boolean'});
  try{
    const status=await accounts.ban(Number(req.params.id),banLogin,account=>canManageAccount(req.auth.sub,account)?204:403,account=>{if(banLogin)revokeAccount(account);});
    res.sendStatus(status);
  }catch{res.status(503).json({error:'Account database unavailable'});}
});
app.get('/api/admin/active-users',protectedRoute,superUserOnly,(_req,res)=>{
  const users=[];
  for(const username of sessions.keys()){
    const session=currentSession(username);
    if(session && roleOf(username)!=='super_user'){
      users.push({sessionId:session.listId,username,startedAt:session.startedAt,lastActiveAt:session.lastActiveAt});
    }
  }
  res.json({users});
});
app.post('/api/admin/sessions/:id/end',protectedRoute,adminAccess,async(req,res)=>{
  const {banLogin=false}=req.body || {};
  if(typeof banLogin!=='boolean')return res.status(400).json({error:'banLogin must be a boolean'});
  for(const session of sessions.values()){
    if(session.listId!==req.params.id) continue;
    if(!canManageAccount(req.auth.sub,session))return res.sendStatus(403);
    if(!currentSession(session.username)) break;
    if(banLogin){
      try{
        const status=await accounts.ban(session.userId,true,account=>{
          if(!canManageAccount(req.auth.sub,account))return 403;
          return account.username===session.username && currentSession(session.username)===session?204:404;
        },revokeAccount);
        return res.sendStatus(status);
      }catch{return res.status(503).json({error:'Could not save the account ban.'});}
    }
    endSession(session,'admin_revoked');
    return res.sendStatus(204);
  }
  res.status(404).json({error:'Session is no longer active'});
});
// Assigned numbers: admins and the super user manage them; each regular user reads only their own.
const assignmentFields={phoneNumber:accountFields.phoneNumber,username:accountFields.username};
function validAssignment(body,partial){
  if(!body || typeof body!=='object' || Array.isArray(body))return false;
  const keys=Object.keys(body);
  if(!keys.length || !keys.every(k=>Object.hasOwn(assignmentFields,k)))return false;
  if(!partial && keys.length!==2)return false;
  return keys.every(k=>body[k]!==null && assignmentFields[k](body[k]));
}
// Only existing regular accounts can receive numbers.
async function assigneeError(username){
  const account=(await accounts.list()).find(a=>a.username===username);
  if(!account)return 'No account with that username';
  if(account.isAdmin || account.username===USERNAME)return 'Numbers can only be assigned to regular users';
  return null;
}
const assignmentUnavailable='Assignment database unavailable.';
app.get('/api/assigned-numbers',protectedRoute,async(req,res)=>{
  const regular=roleOf(req.auth.sub)==='user';
  const {username}=req.query;
  if(!regular && username!==undefined && !accountFields.username(username))return res.status(400).json({error:'Invalid username'});
  try{
    const assignments=await assigned.list(regular?req.auth.sub:username);
    if(regular){
      const manual=new Set(assignments.map(row=>row.phoneNumber));
      for(const phoneNumber of await requirements.numbersFor(req.userId)){
        if(!manual.has(phoneNumber))assignments.push({id:'requirement-'+phoneNumber,phoneNumber,username:req.auth.sub,source:'offline_requirement'});
      }
    }
    res.json({assignments});
  }
  catch{res.status(503).json({error:assignmentUnavailable});}
});
app.post('/api/admin/assigned-numbers',protectedRoute,adminAccess,async(req,res)=>{
  if(!validAssignment(req.body,false))return res.status(400).json({error:'Send a numeric phoneNumber (up to 15 digits) and a username'});
  try{
    const problem=await assigneeError(req.body.username);
    if(problem)return res.status(422).json({error:problem});
    const result=await assigned.add({phoneNumber:req.body.phoneNumber,username:req.body.username});
    if(result.status===409)return res.status(409).json({error:'This number is already assigned to that user'});
    res.status(201).json(result.assignment);
  }catch{res.status(503).json({error:assignmentUnavailable});}
});
app.route('/api/admin/assigned-numbers/:id')
  .all(protectedRoute,adminAccess,(req,res,next)=>{
    const id=Number(req.params.id);
    if(!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id))return res.status(400).json({error:'Invalid assignment ID'});
    req.assignmentId=id;
    next();
  })
  .get(async(req,res)=>{
    try{
      const assignment=await assigned.get(req.assignmentId);
      if(!assignment)return res.status(404).json({error:'Assignment not found'});
      res.json(assignment);
    }catch{res.status(503).json({error:assignmentUnavailable});}
  })
  .patch(async(req,res)=>{
    if(!validAssignment(req.body,true))return res.status(400).json({error:'Send phoneNumber and/or username'});
    try{
      if(req.body.username!==undefined){
        const problem=await assigneeError(req.body.username);
        if(problem)return res.status(422).json({error:problem});
      }
      const result=await assigned.update(req.assignmentId,req.body);
      if(result.status===200)return res.json(result.assignment);
      res.status(result.status).json({error:result.status===404?'Assignment not found':'This number is already assigned to that user'});
    }catch{res.status(503).json({error:assignmentUnavailable});}
  })
  .delete(async(req,res)=>{
    try{
      const status=await assigned.remove(req.assignmentId);
      if(status===204)return res.sendStatus(204);
      res.status(404).json({error:'Assignment not found'});
    }catch{res.status(503).json({error:assignmentUnavailable});}
  });
app.get('/api/health',(_req,res)=>res.json({ok:true}));

const sendRoutes=new Set(['sendText','sendImage','sendVideo','sendSeen','sendFile','sendVoice']);
function allowedWaha(method,path,role){
  if(method==='POST' && sendRoutes.has(path.slice('/api/'.length))) return true;
  if(method!=='GET' && method!=='HEAD') return false;
  if(/^\/api\/files\/[A-Za-z0-9_@./%-]+$/.test(path) && !/(?:%2e|%2f|%5c|%25|\.\.)/i.test(path)) return true;
  const enc=encodeURIComponent(SESSION);
  if(!path.startsWith('/api/'+enc+'/')&&!path.startsWith('/api/'+SESSION+'/')) return false;
  const suffix=path.slice(('/api/'+(path.startsWith('/api/'+enc+'/')?enc:SESSION)).length);
  return /^\/labels(?:\/[A-Za-z0-9_-]+\/chats)?$/.test(suffix)||
    /^\/lids\/[0-9]+$/.test(suffix)||
    /^\/chats\/overview$/.test(suffix)||
    (role!=='user' && /^\/groups\/\d+(?:-\d+)?(?:@|%40)g\.us\/participants(?:\/v2)?$/.test(suffix))||
    (role!=='user' && /^\/chats\/\d+(?:-\d+)?(?:@|%40)g\.us\/messages(?:\/[A-Za-z0-9_@.%:-]+)?$/.test(suffix))||
    /^\/chats\/[0-9]+(?:@|%40)(?:lid|c\.us|s\.whatsapp\.net)\/messages(?:\/[A-Za-z0-9_@.%:-]+)?$/.test(suffix);
}
const wahaHeaders=()=>({'X-Api-Key':process.env.WAHA_API_KEY});
app.use('/api',(req,res,next)=>{
  if(req.path.startsWith('/auth/')||req.path==='/health'||req.path==='/incoming-text') return next();
  protectedRoute(req,res,next);
});
app.get('/api/session-identity',adminAccess,async(_req,res)=>{
  res.set('Cache-Control','no-store');
  try {
    const upstream=await fetch(WAHA+'/api/sessions/'+encodeURIComponent(SESSION)+'/me',{
      headers:wahaHeaders(),redirect:'error',signal:AbortSignal.timeout(8000)
    });
    if(!upstream.ok) return res.status(502).json({error:'Session identity unavailable'});
    const account=await upstream.json();
    const match=/^([1-9]\d{5,14})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/.exec(account?.id ?? '');
    const linkedId=value=>/^(\d+)(?::\d+)?@lid$/.exec(value)?.[1];
    let lid=linkedId(account?.lid) || linkedId(account?.id);
    if(match && !lid){
      try{
        const mapping=await fetch(WAHA+'/api/'+encodeURIComponent(SESSION)+'/lids/pn/'+match[1],{
          headers:wahaHeaders(),redirect:'error',signal:AbortSignal.timeout(3000)
        });
        if(mapping.ok)lid=linkedId((await mapping.json()).lid);
        else await mapping.body?.cancel();
      }catch{ /* The phone identity still works when WAHA has no linked ID. */ }
    }
    res.json({session:SESSION,number:match ? '+'+match[1] : null,lid:lid ? lid+'@lid' : null});
  } catch {
    res.status(502).json({error:'Session identity unavailable'});
  }
});
const myChats=personalChats(records(db,'personal:'+sessionKey));
app.delete('/api/chats/:id/from-my-list',adminAccess,async(req,res)=>{
  const ids=[req.params.id];
  if(req.body?.alias)ids.push(req.body.alias);
  if(!ids.every(id=>typeof id==='string' && /^\d{1,20}@(lid|c\.us)$/.test(id)))
    return res.status(400).json({error:'Choose an individual chat.'});
  try{res.json({personalChats:await myChats.remove(req.userId,ids)});}
  catch{res.status(503).json({error:'Could not save your chat list change.'});}
});
app.use('/api/business-labels',labelDeletionRoutes({base:WAHA,session:SESSION,headers:wahaHeaders,adminAccess,
  personal: req=>roleOf(req.auth.sub)==='user'?{}:myChats.read(req.userId),
  store:records(db,'labels:'+sessionKey),
  visible:(req,id)=>roleOf(req.auth.sub)!=='user'||coverage.canSee({username:req.auth.sub},id)}));
app.use('/api/business-labels',businessLabelRoutes(WAHA,SESSION,wahaHeaders,adminAccess));
app.put('/api/reaction',async(req,res)=>{
  const {messageId,reaction}=req.body || {};
  const chatId=typeof messageId==='string' && /^(?:true|false)_(\d+@(?:c\.us|lid|s\.whatsapp\.net))_/.exec(messageId)?.[1];
  if(!chatId || !validMessageId(messageId) || typeof reaction!=='string' || reaction.length>32)
    return res.status(400).json({error:'Invalid message or reaction'});
  try{
    if(roleOf(req.auth.sub)==='user'){
      await coverage.resolve(chatId);
      if(!coverage.canSee({username:req.auth.sub},chatId))return res.sendStatus(403);
    }
    const response=await fetch(WAHA+'/api/reaction',{method:'PUT',headers:{...wahaHeaders(),'Content-Type':'application/json'},
      body:JSON.stringify({session:SESSION,messageId,reaction}),signal:AbortSignal.timeout(15000)});
    await response.body?.cancel();
    if(!response.ok)return res.status(502).json({error:'WhatsApp declined the reaction'});
    res.sendStatus(204);
  }catch{res.status(502).json({error:'Could not reach WhatsApp'});}
});
const broadcasts=await broadcastQueue(records(db,'broadcasts:'+sessionKey),{
  send:broadcastSender(WAHA,SESSION,wahaHeaders,sent),
  canSend:async id=>{const account=await accounts.get(id);return !!account && !account.banLogin;}
});
app.use('/api/broadcasts',broadcasts.router);
const calls=createCalls(WAHA,SESSION,wahaHeaders);
app.post('/api/calls/decline',adminAccess,calls.decline);
// The signed-in browser reports that a staff member opened a chat, so its
// pending holding reply is cancelled. Unread counts are not affected.
app.post('/api/chats/attended',async(req,res)=>{
  const chatId=req.body?.chatId;
  if(typeof chatId!=='string' || !/^\d{1,20}(?:@(?:c\.us|lid|s\.whatsapp\.net))?$/.test(chatId))return res.status(400).json({error:'Expected a direct chat ID'});
  await busy?.attended(chatId);
  res.status(204).end();
});
app.post('/api/messages/deletion-state',async(req,res)=>{
  const ids=req.body?.ids;
  if(!Array.isArray(ids)||ids.length>100||!ids.every(validMessageId))return res.status(400).json({error:'Expected up to 100 WAHA message IDs'});
  try{res.json({messages:await sent.states([...new Set(ids)],req.userId)});}
  catch{res.status(503).json({error:'Message state unavailable'});}
});
app.delete('/api/messages/:id',async(req,res)=>{
  const {id}=req.params, scope=req.body?.scope;
  if(!validMessageId(id)||!['me','everyone'].includes(scope))return res.status(400).json({error:'Invalid message ID or deletion scope'});
  try{
    const {status,...body}=await sent.remove(id,req.userId,scope,async(chatId,messageId)=>{
      const path='/api/'+encodeURIComponent(SESSION)+'/chats/'+encodeURIComponent(chatId)+'/messages/'+encodeURIComponent(messageId);
      try{
        const upstream=await fetch(WAHA+path,{method:'DELETE',headers:wahaHeaders(),redirect:'error',signal:AbortSignal.timeout(15000)});
        if(!upstream.ok){
          await upstream.body?.cancel();
          return {status:upstream.status>=500 || [401,403].includes(upstream.status)?502:409,error:'WAHA declined the revocation request'};
        }
        const reply=await upstream.text();
        if(reply && upstream.headers.get('content-type')?.includes('application/json')){
          const result=JSON.parse(reply);
          if(result===false || result?.success===false)return {status:409,error:'WAHA declined the revocation request'};
        }
      }catch{return {status:502,error:'Could not confirm acceptance by WAHA'};}
    });
    res.status(status).json(body);
  }catch{res.status(503).json({error:'Could not save message state'});}
});
app.get('/api/contacts/name',async(req,res)=>{
  const {contactId}=req.query;
  if(typeof contactId!=='string' || !/^\d{1,20}@(c\.us|lid)$/.test(contactId))
    return res.status(400).json({error:'Expected a direct WhatsApp chat ID'});
  res.set('Cache-Control','no-store');
  try{
    if(roleOf(req.auth.sub)==='user'){
      await coverage.resolve(contactId);
      if(!coverage.canSee({username:req.auth.sub},contactId))return res.sendStatus(403);
    }
    const query=new URLSearchParams({contactId,session:SESSION});
    const upstream=await fetch(WAHA+'/api/contacts?'+query,{headers:wahaHeaders(),redirect:'error',signal:AbortSignal.timeout(8000)});
    if(upstream.status===404)return res.json({name:null});
    if(!upstream.ok)return res.status(502).json({error:'Contact lookup failed'});
    const contact=await upstream.json();
    const name=[contact?.name,contact?.pushname,contact?.pushName,contact?.shortName]
      .find(value=>typeof value==='string' && value.trim() && !/^\+?[\d\s().-]+(?:@(c\.us|lid|s\.whatsapp\.net))?$/.test(value.trim()));
    res.json({name:name?.trim() || null});
  }catch{return res.status(502).json({error:'Contact lookup unavailable'});}
});
app.get('/api/contacts/profile-picture',async(req,res)=>{
  const {contactId}=req.query;
  if(typeof contactId!=='string' || !/^\+?\d{1,20}$|^\d{1,20}@(c\.us|s\.whatsapp\.net|lid)$/.test(contactId)){
    return res.status(400).json({error:'Enter a phone number with country code or a direct WhatsApp chat ID'});
  }
  const chatId=contactId.includes('@') ? contactId.replace(/@s\.whatsapp\.net$/,'@c.us') : contactId.replace(/^\+/,'')+'@c.us';
  const query=new URLSearchParams({contactId:chatId,session:SESSION});
  try{
    const upstream=await fetch(WAHA+'/api/contacts/profile-picture?'+query,{
      headers:wahaHeaders(),redirect:'error',signal:AbortSignal.timeout(15000)
    });
    if(!upstream.ok){
      await upstream.body?.cancel();
      if(upstream.status===404)return res.json({profilePictureURL:null});
      return res.status(502).json({error:'WAHA profile picture lookup failed'});
    }
    const {profilePictureURL}=await upstream.json();
    if(!profilePictureURL)return res.json({profilePictureURL:null});
    const url=new URL(profilePictureURL);
    if(url.protocol!=='https:' || url.username || url.password)throw Error('Invalid photo URL');
    res.json({profilePictureURL:url.href});
  }catch{return res.status(502).json({error:'WAHA profile picture unavailable'});}
});
app.use('/api',async(req,res,next)=>{
  if(req.path.startsWith('/auth/')||req.path==='/health'||req.path==='/incoming-text') return next();
  const pathname='/api'+req.path;
  if(!allowedWaha(req.method,pathname,roleOf(req.auth.sub))) return res.status(404).json({error:'Unsupported route'});
  if(sendRoutes.has(req.path.slice(1)) && (typeof req.body?.session!=='string' || req.body.session!==SESSION)) return res.status(400).json({error:'Invalid WAHA session'});
  const destination=WAHA+pathname+(req.url.includes('?')?'?'+req.url.split('?').slice(1).join('?'):'');
  try {
    const isFile=pathname.startsWith('/api/files/');
    const headers=wahaHeaders();
    if(req.method==='POST') headers['Content-Type']='application/json';
    if(isFile) {
      headers['Accept-Encoding']='identity';
      if(req.headers.range) headers.Range=req.headers.range;
    }
    const upstream=await fetch(destination,{method:req.method,headers,body:req.method==='POST'?JSON.stringify(req.body):undefined,signal:AbortSignal.timeout(120000)});
    if(upstream.status===401 || upstream.status===403) {
      // The app's JWT was already validated. This status comes from WAHA, not the login session.
      await upstream.body?.cancel();
      return res.status(502).json({error:'WAHA rejected the backend API key or access permissions (upstream HTTP '+upstream.status+'). Verify WAHA_API_KEY and WAHA_URL in backend/.env.'});
    }
    res.status(upstream.status);
    for(const k of ['content-type']) if(upstream.headers.get(k)) res.setHeader(k,upstream.headers.get(k));
    // A staff send (or read receipt) to a chat means it is being attended.
    if(req.method==='POST' && sendRoutes.has(req.path.slice(1)) && upstream.ok)busy?.attended(req.body.chatId).catch(()=>{});
    if(req.method==='POST' && sendRoutes.has(req.path.slice(1)) && req.path!=='/sendSeen' && upstream.ok){
      const bytes=Buffer.from(await upstream.arrayBuffer());
      try{
        const receipt=JSON.parse(bytes.toString('utf8'));
        const id=typeof receipt?.id==='string'?receipt.id:receipt?.id?._serialized;
        const chatId=req.body.chatId;
        if(validMessageId(id) && receipt?.fromMe!==false && typeof chatId==='string' && /^\d+@(c\.us|lid|s\.whatsapp\.net)$/.test(chatId)){
          await sent.record(id,chatId,req.userId);
        }
      }catch{console.warn('Sent message ownership could not be recorded');}
      // Preserve the successful send response even if deletion metadata is unavailable.
      return res.end(bytes);
    }
    if(isFile) {
      res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");
      res.setHeader('X-Content-Type-Options','nosniff');
      let mime=(upstream.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      if(mime==='application/mp4' && /\.mp4$/i.test(pathname)) {
        mime='video/mp4';
        res.setHeader('Content-Type',mime);
      }
      if((mime==='application/ogg'||mime==='application/octet-stream') && /\.(ogg|opus|oga)$/i.test(pathname)){
        mime='audio/ogg';
        res.setHeader('Content-Type',mime);
      }
      if(!upstream.headers.has('content-encoding') || upstream.headers.get('content-encoding')==='identity') {
        for(const name of ['accept-ranges','content-range','content-length']) {
          if(upstream.headers.has(name)) res.setHeader(name,upstream.headers.get(name));
        }
      }
      res.setHeader('Content-Disposition',/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime)|audio\/(ogg|opus|webm|mp4|mpeg|aac|wav))$/.test(mime)?'inline':'attachment');
    }
    if(!upstream.body) return res.end();
    const {Readable}=await import('node:stream');
    Readable.fromWeb(upstream.body).on('error',()=>res.destroy()).pipe(res);
  }catch(err){if(!res.headersSent)res.status(502).json({error:'WAHA upstream unavailable'});}
});
// Live WAHA websocket is server-side only. Access cookie cannot be read by JavaScript.
function incomingText(event,includeGroups){
  const msg=event?.payload;
  if(event?.session!==SESSION||event.event!=='message'||!msg||msg.fromMe||typeof msg.from!=='string')return null;
  const group=/^\d+(?:-\d+)?@g\.us$/.test(msg.from);
  if(!(group && includeGroups) && !/@(?:c\.us|s\.whatsapp\.net|lid)$/.test(msg.from))return null;
  const id=typeof msg.id==='string'?msg.id:msg.id?._serialized||event.id;if(typeof id!=='string')return null;
  const media=msg.media||{};const mime=String(media.mimetype||msg._data?.mimetype||'').toLowerCase();const hint=msg._data?.type||msg.type;
  const voice=hint==='ptt'||hint==='audio'||mime.startsWith('audio/');
  const hasMedia=msg.hasMedia||msg.media||voice;
  if(!hasMedia&&!String(msg.body||'').trim())return null;
  const kind=voice?'voice':mime.startsWith('image/')||hint==='image'?'image':mime.startsWith('video/')||hint==='video'?'video':'document';
  let src; if(typeof media.url==='string'){try{const path=new URL(media.url,'http://localhost').pathname;if(path.startsWith('/api/files/'))src=path;}catch{}}
  const data=msg._data;
  const content=data?.message || data?.Message;
  const mentions=group?[msg.mentions,msg.mentionedIds,data?.mentionedJidList,data?.mentionedIds,
    ...Object.values(content || {}).map(part=>part?.contextInfo?.mentionedJid)]
    .filter(Array.isArray).flat().map(value=>typeof value==='string'?value:value?._serialized ||
      (value?.user && value.server ? value.user+'@'+value.server : ''))
    .filter(id=>/^\d+(?::\d+)?@(lid|c\.us|s\.whatsapp\.net)$/.test(id)):[];
  const author=group?{
    mentions,
    participant:msg.participant || msg.author || msg._data?.author || msg._data?.key?.participant || msg._data?.Info?.Sender,
    participantAlt:msg.participantAlt || msg._data?.key?.participantAlt || msg._data?.Info?.SenderAlt,
    participantName:msg._data?.notifyName || msg._data?.pushName || msg._data?.Info?.PushName
  }:{};
  return {id:'incoming:'+id,sender:msg.from,...author,text:voice?'':msg.body||'',...(hasMedia?{kind,src,filename:media.filename||msg._data?.filename||(voice?'Voice note':'Attachment')}:{}),quotedId:msg.replyTo?.id||msg._data?.quotedStanzaID,timestamp:Number(msg.timestamp)*1000||Number(msg._data?.t)*1000||Number(event.timestamp)||Date.now()};
}
app.get('/api/incoming-text',protectedRoute,(req,res)=>{
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();res.write('retry: 3000\n\n');
  const url=new URL(WAHA.replace(/^http/,'ws')+'/ws');url.searchParams.set('session',SESSION);url.searchParams.append('events','message');url.searchParams.append('events','message.ack');
  // WAHA supports API key in websocket query; never expose this URL to browser.
  for(const event of callEvents)url.searchParams.append('events',event);
  url.searchParams.append('events','message.reaction');
  url.searchParams.set('x-api-key',process.env.WAHA_API_KEY);
  const ws=new WebSocket(url);
  // Waiting-client notifications, limited to chats this user can see: admins
  // and the super user see all, regular users only their assigned numbers.
  const viewer=sessions.get(req.auth.sub);
  const member={username:req.auth.sub,isAdmin:!!viewer?.isAdmin || req.auth.sub===USERNAME};
  const unsubscribeCalls=member.isAdmin ? calls.subscribe((name,data)=>{
    if(!res.destroyed)res.write('event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n');
  }) : null;
  res.write('event: client.waiting.snapshot\ndata: '+JSON.stringify(alerts.list().filter(alert=>coverage.canSee(member,alert.chatId)))+'\n\n');
  const unsubscribeAlerts=alerts.subscribe((name,data)=>{
    if(res.destroyed || (name==='client.waiting' && !coverage.canSee(member,data.chatId)))return;
    res.write('event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n');
  });
  const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},20000);
  ws.on('open',()=>{if(!res.destroyed)res.write('event: ready\ndata: {}\n\n');});
  ws.on('message',raw=>{
    let event;try{event=JSON.parse(raw.toString());}catch{return;}
    calls.observe(event);
    if(event?.session===SESSION && event.event==='message.reaction'){
      const p=event.payload, id=p?.reaction?.messageId, text=p?.reaction?.text;
      const chatId=typeof id==='string' && /^(?:true|false)_(\d+@(?:c\.us|lid|s\.whatsapp\.net))_/.exec(id)?.[1];
      if(chatId && validMessageId(id) && typeof text==='string' && text.length<=32){
        const publish=()=>{
          if(!res.destroyed && coverage.canSee(member,chatId))
            res.write('event: reaction\ndata: '+JSON.stringify({id,text,actor:p.fromMe?'self':'peer',at:event.timestamp || Date.now()})+'\n\n');
        };
        if(member.isAdmin)publish();else coverage.resolve(chatId).then(publish).catch(()=>{});
      }
      return;
    }
    if(event?.session===SESSION && event.event==='message.ack'&&event.payload?.fromMe){
      const m=event.payload;const id=typeof m.id==='string'?m.id:m.id?._serialized;
      const stages={ERROR:-1,PENDING:0,SERVER:1,DEVICE:2,READ:3,PLAYED:4};const ack=stages[m.ackName]??m.ack;
      if(id&&Number.isInteger(ack))res.write('event: receipt\ndata: '+JSON.stringify({id,ack})+'\n\n');return;
    }
    const msg=incomingText(event,member.isAdmin);if(msg&&!res.destroyed)res.write('data: '+JSON.stringify(msg)+'\n\n');
  });
  const streams=sessions.get(req.auth.sub).streams;
  const expires=setTimeout(finish,Math.max(0,req.auth.exp*1000-Date.now()));
  function finish(reason){
    if(!streams.delete(finish)) return;
    unsubscribeCalls?.();
    unsubscribeAlerts();
    clearInterval(heartbeat);
    clearTimeout(expires);
    ws.close();
    if(!res.destroyed){
      if(reason==='admin_revoked') res.write('event: session-ended\ndata: {"reason":"admin_revoked"}\n\n');
      res.end();
    }
  }
  streams.add(finish);
  res.on('close',finish);ws.on('error',finish);ws.on('close',finish);
});
// Must register SSE before proxy: proxy middleware falls through for incoming-text.
const server=http.createServer(app);
// Real-time team chat (WebSocket at /api/team-chat). Relayed live, never stored.
// The socket closes with the sign-in session (logout, ban, revoke, role change).
const chatRole=account=>account.username===USERNAME?'super_user':account.isAdmin?'admin':'user';
const teamChatServer=teamChat({server,allowedOrigin,
  authenticate:({cookies})=>{
    const claims=sessionClaims(cookies.wa_access,ACCESS_SECRET,'access');
    const session=claims && sessions.get(claims.sub);
    if(!session)return null;
    return {
      user:{id:session.userId,username:session.username,name:session.name||session.username,role:roleOf(session.username)},
      register(close){session.streams.add(close);return ()=>session.streams.delete(close);}
    };
  },
  directory:async()=>(await accounts.list()).filter(account=>!account.banLogin)
    .map(account=>({id:account.id,username:account.username,name:account.name||account.username,role:chatRole(account)}))
});
const phoneFor=chatId=>senderPhone(chatId,WAHA,SESSION,wahaHeaders);
// Automatic replies go straight to WAHA, not through the proxy, so they never
// count as a staff member attending the chat and never mark messages as read.
async function sendAutoReply(chatId,text){
  const response=await fetch(WAHA+'/api/sendText',{method:'POST',headers:{...wahaHeaders(),'Content-Type':'application/json'},
    redirect:'error',signal:AbortSignal.timeout(15000),body:JSON.stringify({chatId,text,session:SESSION,linkPreview:false})});
  await response.body?.cancel();
  if(!response.ok)throw Object.assign(Error('WAHA declined automatic reply'),{statusCode:response.status});
}
// Per chat: nobody who can see it signed in -> the AI intake responder; somebody
// who can see it signed in -> holding replies until they reach the chat.
const away=process.env.OLLAMA_MODEL && process.env.AWAY_REPLIES_ENABLED==='true'?awayResponder({
  session:SESSION,markers:replyMarkers(db),
  offlinePeriod:chatId=>coverage.periodFor(chatId),
  model:intakeModel(process.env.OLLAMA_BASE_URL || 'http://localhost:11434',process.env.OLLAMA_MODEL),
  requirements,phoneFor,send:sendAutoReply
}):null;
const seconds=(name,fallback)=>{const value=Number(process.env[name]);return Number.isFinite(value) && value>=0?value*1000:fallback*1000;};
const busy=process.env.BUSY_REPLIES_ENABLED==='true'?busyResponder({session:SESSION,staffOnline:chatId=>coverage.covered(chatId),phoneFor,
  onHeld:(chatId,key)=>alerts.add(chatId,key),onAttended:key=>alerts.clear(key),send:sendAutoReply,
  delayMs:seconds('BUSY_REPLY_DELAY_SECONDS',60),followUpGapMs:seconds('BUSY_FOLLOWUP_GAP_SECONDS',300),engagedMs:seconds('BUSY_ENGAGED_SECONDS',600),cooldownMs:seconds('BUSY_REPLY_COOLDOWN_SECONDS',1800)}):null;
if(away || busy){
  const stopListening=listenForAwayMessages(WAHA,SESSION,process.env.WAHA_API_KEY,
    async event=>{
      await coverage.resolve(event?.payload?.from);
      await Promise.all([away?.(event),busy?.handle(event)]);
    });
  server.once('close',()=>{stopListening();busy?.stop();});
}
server.listen(PORT,'0.0.0.0',()=>console.log(`Secure WAHA backend listening on ${server.address().port}`));
