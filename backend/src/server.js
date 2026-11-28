import {campaignRoutes,campaignStore,campaignPhone} from './campaigns.js';
import {sessionPhones} from './session-phones.js';
import {badPage,pageMeta,pageRequest,searchTerm} from './paging.js';
import {campaignAccess,AVAILABILITY_MAX_AGE_MS} from './campaign-access.js';
import { mountNumberManagement, dashboardUpgrade, validInboxName } from './numbers.js';
import { upstreamHub } from './upstream-hub.js';
import { chatList } from './chat-list.js';
import { assignmentNotices } from './assignment-notices.js';
import { contactAliases } from './contact-aliases.js';
import { requirementStore, requirementRange, senderPhone, receivedDate } from './offline-requirements.js';
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
import { numberRetirement } from './number-retirement.js';
import { waitingAlerts } from './waiting-alerts.js';
import { teamChat } from './team-chat.js';
import { openWhatix } from './whatix.js';
import { accountStore } from './accounts.js';
import { records, replyMarkers } from './sqlite.js';
import { assignmentStore } from './assigned-numbers.js';
import { wahaSendBody, resolveBroadcastMedia } from './send-body.js';
import { windowLimiter } from './rate-limits.js';
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
// ADMIN_PASSWORD only seeds a new database, so the check above cannot see a
// default password that is already stored. Warn loudly instead of refusing to
// start, which would take production down.
if(production)accounts.passwordMatches(USERNAME,'admin').then(weak=>{
  if(weak)console.warn('SECURITY WARNING: the super user still has the default password. Change it under "Password" after signing in.');
}).catch(()=>{});
const assigned=assignmentStore(db);
const campaignStoreDb=campaignStore(db);
// Business phone of each WAHA session, cached and shared (see session-phones.js).
// Set once the database is ready (below). Every connected number is reported to
// it first, so one that replaced another has the old one's data erased.
let numberState=null;
const phones=sessionPhones({base:WAHA,headers:()=>wahaHeaders(),
  onPhone:(name,phone)=>Promise.resolve(numberState?.observe(name,phone)).catch(()=>{console.error('Could not erase the data of a replaced WhatsApp number; it is retried');})});
const requirements=requirementStore(db);

// Which chats signed-in staff can see: admins and the super user see all,
// regular users see their manually assigned numbers and assigned requirements.
const coverage=chatCoverage({
  onlineStaff:()=>[...sessions.keys()].map(username=>currentSession(username)).filter(Boolean)
    .map(session=>({username:session.username,userId:session.userId,isAdmin:!!session.isAdmin || session.username===USERNAME})),
  numbersFor:async member=>{
    const phone=await phones.phone(SESSION).catch(()=>null);
    const grant=phone && await campaignStoreDb.get(SESSION,phone,member.userId);
    return [...(await assigned.list(member.username)).map(row=>row.phoneNumber),
      ...(grant?grant.contacts.map(contact=>contact.phoneNumber):[]),...await requirements.numbersFor(member.userId,SESSION,true)];
  },
  phoneFor:chatId=>senderPhone(chatId,WAHA,SESSION,wahaHeaders)
});
// "+92… is waiting for your reply" notifications for the header bell.
const defaultAlerts=waitingAlerts();
const PORT = Number(process.env.PORT || 8080);
const COOKIE_SECURE = production;
const sessions = new Map(); // One active session per username on this backend process.
const idleWarningMs = 5 * 60_000;
const idleGraceMs = 2 * 60_000;
const allowedOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
// Outside production, also accept any localhost/127.0.0.1 port so local testing isn't blocked.
const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const isAllowedOrigin = origin => origin === allowedOrigin || (!production && localOrigin.test(origin || ''));
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(helmet({contentSecurityPolicy:false,crossOriginResourcePolicy:{policy:'cross-origin'}}));
// API responses are data, never pages: nothing may run in or frame them. The
// WAHA dashboard pages proxied under /api/admin/waha-ui keep their own rules.
const apiPolicy=helmet.contentSecurityPolicy({useDefaults:false,directives:{defaultSrc:["'none'"],frameAncestors:["'none'"],baseUri:["'none'"],formAction:["'none'"]}});
app.use((req,res,next)=>req.path.startsWith('/api/admin/waha-ui')?next():apiPolicy(req,res,next));
app.use(cookieParser());
// Request bodies stay small, except media sends and broadcasts, which carry
// base64 attachments. Those large bodies are only read for a signed-in user.
const smallJson=express.json({limit:'1mb'}), largeJson=express.json({limit:'52mb'});
const largeBodyRoute=/^(?:\/api\/inboxes\/[^/]+)?\/api\/(?:sendImage|sendVideo|sendFile|sendVoice|broadcasts)$/;
app.use((req,res,next)=>{
  if(req.method!=='POST' || !largeBodyRoute.test(req.path))return smallJson(req,res,next);
  if(!accessClaims(req))return res.status(401).json({error:'Authentication required',refreshable:false});
  largeJson(req,res,next);
});
app.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Vary','Origin');
  if (isAllowedOrigin(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Origin',req.headers.origin);
    res.setHeader('Access-Control-Allow-Credentials','true');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
  }
  if(req.method==='OPTIONS') return res.sendStatus(isAllowedOrigin(req.headers.origin) ? 204:403);
  if(!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin && !isAllowedOrigin(req.headers.origin)) return res.status(403).json({error:'Origin not allowed'});
  next();
});
// Only failed login attempts count; normal refreshes must never lock out sign-in.
function createLoginLimiter(){
  return rateLimit({windowMs:15*60*1000,limit:10,skipSuccessfulRequests:true,requestWasSuccessful:(_req,res)=>res.statusCode<400 || res.statusCode===409,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Too many failed login attempts. Try again in 15 minutes.'}});
}
const adminLoginLimiter=createLoginLimiter();
const regularLoginLimiter=createLoginLimiter();
// Per account as well as per IP: guessing one account's password from many
// addresses is throttled too. Successful sign-ins do not count.
const accountLoginLimiter=rateLimit({windowMs:15*60*1000,limit:30,skipSuccessfulRequests:true,
  requestWasSuccessful:(_req,res)=>res.statusCode<400 || res.statusCode===409,standardHeaders:'draft-7',legacyHeaders:false,
  keyGenerator:req=>'account:'+String(req.loginCredentials?.username??'').trim().toLowerCase().slice(0,128),
  message:{error:'Too many failed login attempts for this account. Try again in 15 minutes.'}});
function limitLogin(req,res,next){
  const encoded=req.body?.credentials;
  if(typeof encoded==='string' && encoded.length<=4096 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)){
    try{req.loginCredentials=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));}catch{}
  }
  const limiter=req.loginCredentials?.username===USERNAME ? adminLoginLimiter : regularLoginLimiter;
  return limiter(req,res,err=>err?next(err):accountLoginLimiter(req,res,next));
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
// A refresh response can be lost (sleep, network drop). The token it replaced
// stays valid this long, so the browser's retry gets the current session
// instead of being signed out while its session lives on and blocks sign-in.
const REFRESH_GRACE_MS=30_000;
function issue(res,user,session){
  const jti=crypto.randomUUID();
  if(session.jti){session.prevJti=session.jti;session.rotatedAt=Date.now();}
  const sid=session.id;
  const access=jwt.sign({sub:user,typ:'access',sid},ACCESS_SECRET,{algorithm:'HS256',expiresIn:'15m',issuer:'wa-bulk'});
  const refresh=jwt.sign({sub:user,typ:'refresh',sid,jti},REFRESH_SECRET,{algorithm:'HS256',expiresIn:'7d',issuer:'wa-bulk'});
  session.jti=jti;
  session.expiresAt=jwt.decode(refresh).exp*1000;
  sessions.set(user,session);
  res.cookie('wa_access',access,tokenCookie);
  res.cookie('wa_refresh',refresh,refreshCookie);
  return {username:user,name:session.name||user,role:roleOf(user),mustChangePassword:!!session.mustChangePassword,expiresIn:900,...idleStatus(session)};
}
function clear(res){res.clearCookie('wa_access',cookieBase);res.clearCookie('wa_refresh',{...cookieBase,path:'/api/auth'});}
function sessionClaims(token,secret,type){
  if(!token) return null;
  try {
    const claims=jwt.verify(token,secret,{algorithms:['HS256'],issuer:'wa-bulk'});
    const session=currentSession(claims.sub);
    if(!session || claims.typ!==type || claims.sid!==session.id) return null;
    if(type==='refresh' && claims.jti!==session.jti &&
      !(claims.jti===session.prevJti && Date.now()-session.rotatedAt<=REFRESH_GRACE_MS)) return null;
    return claims;
  }catch{return null;}
}
// A genuine refresh token that no longer works:
// - replayed: it belongs to the live session but was already rotated (a copy
//   was stolen, or this browser missed a refresh long ago). That ends the session.
// - replaced: the account has since signed in elsewhere, which took over.
function staleRefresh(req){
  try{
    const claims=jwt.verify(req.cookies?.wa_refresh,REFRESH_SECRET,{algorithms:['HS256'],issuer:'wa-bulk'});
    const session=claims.typ==='refresh' && currentSession(claims.sub);
    if(!session)return null;
    return claims.sid===session.id ? {replayed:session} : {replaced:true};
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
  const session=sessions.get(claims.sub);
  req.userId=session.userId;
  // An account whose password an admin set must choose its own first. Until
  // then it can only read its identity, report activity and change the password.
  if(session.mustChangePassword && !PASSWORD_SETUP_ROUTES.has(req.originalUrl.split('?')[0]))
    return res.status(403).json({error:'Choose a new password before continuing.',reason:'password_change_required'});
  next();
}
const PASSWORD_SETUP_ROUTES=new Set(['/api/auth/password','/api/auth/me','/api/auth/activity']);
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
      if(!commit)return {status:200};
      // Still one session per account, but the right password always gets in:
      // a session held elsewhere (another device, or one this browser lost —
      // closed, cleared, idle-expired, or a logout that never reached the
      // server) is signed out instead of locking its owner out.
      let held=session;
      if(session && browser?.sub!==user){
        endSession(session,'signed_in_elsewhere');
        held=null;
      }
      const owner=held || {userId:account.id,isAdmin:account.isAdmin,username:user,id:crypto.randomUUID(),listId:crypto.randomUUID(),startedAt:Date.now(),streams:new Set()};
      // Full name from the NAME column, shown in the header pill.
      owner.name=typeof account.name==='string' && account.name.trim()?account.name.trim():user;
      owner.mustChangePassword=!!account.mustChangePassword;
      recordActivity(owner,Date.now());
      return {status:200,body:issue(res,user,owner)};
    });
    // Sign-in completes only once chat coverage knows which chats this user
    // can see, so the automatic replies pause for them straight away.
    // Bounded, so a slow WAHA cannot hold the reply until the browser gives up
    // on a sign-in the server already completed.
    if(result.status===200){
      await Promise.race([coverage.changed().catch(()=>{}),new Promise(done=>setTimeout(done,3000).unref?.())]);
      return res.json(result.body);
    }
    res.status(result.status).json({error:result.error || (result.status===403?'Login is banned. Contact your admin.':'Invalid username or password')});
  }catch{res.status(503).json({error:'Account database unavailable.'});}
});
app.post('/api/auth/refresh',(req,res)=>{
  const claims=refreshClaims(req);
  if(!claims){
    const stale=staleRefresh(req);
    if(stale?.replayed){
      console.warn('Replayed refresh token: session ended');
      endSession(stale.replayed,'token_reuse');
    }
    // Tell a browser whose session was taken over why it is signed out.
    return res.status(401).json({error:'Session expired',...(stale?.replaced?{reason:'signed_in_elsewhere'}:{})});
  }
  res.json(issue(res,claims.sub,sessions.get(claims.sub)));
});
// Anyone signed in, the super user included, can change their own password.
// The current password is required, attempts are limited, and the session
// ends afterwards so the next sign-in uses the new password.
const passwordChanges=windowLimiter({limit:10,windowMs:15*60*1000});
app.post('/api/auth/password',protectedRoute,async(req,res)=>{
  const {currentPassword,newPassword}=req.body||{};
  if(typeof currentPassword!=='string' || !currentPassword || currentPassword.length>256)
    return res.status(400).json({error:'Enter your current password.'});
  if(!accountFields.password(newPassword))return res.status(400).json({error:'The new password must be 8 to 256 characters.'});
  if(newPassword===currentPassword)return res.status(400).json({error:'Choose a password different from the current one.'});
  if(!passwordChanges.take(req.userId)){
    res.set('Retry-After',String(passwordChanges.retryAfter(req.userId)));
    return res.status(429).json({error:'Too many attempts. Try again later.'});
  }
  try{
    const status=await accounts.changePassword(req.userId,currentPassword,newPassword);
    if(status===403)return res.status(403).json({error:'Your current password is incorrect.'});
    if(status!==204)return res.status(status).json({error:'Account not found.'});
    const session=sessions.get(req.auth.sub);
    if(session)endSession(session,'password_changed');
    clear(res);
    res.sendStatus(204);
  }catch{res.status(503).json({error:'Account database unavailable.'});}
});
app.post('/api/auth/logout',(req,res)=>{
  const claims=refreshClaims(req) || accessClaims(req);
  if(claims) endSession(sessions.get(claims.sub));
  clear(res);res.json({ok:true});
});
app.get('/api/auth/me',protectedRoute,(req,res)=>res.json({username:req.auth.sub,name:sessions.get(req.auth.sub)?.name||req.auth.sub,role:roleOf(req.auth.sub),mustChangePassword:!!sessions.get(req.auth.sub)?.mustChangePassword,expiresIn:req.auth.exp-Math.floor(Date.now()/1000),...idleStatus(sessions.get(req.auth.sub))}));
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
// "Received by": which of our numbers (inbox session) received the requirement,
// and its phone then. Rows without one belong to the main number.
const mainNumber=()=>phones.phone(SESSION).then(phone=>phone?String(phone):null,()=>null);
const receivedSessionOf=row=>row.receivedSession||SESSION;
function requirementProfile(row,users,mainPhone=null){
  const {assignedUserIds,receivedSession,receivedBy,...details}=row;
  const session=receivedSession||SESSION;
  return {...details,assignedUsers:assignedUserIds.map(id=>users.get(id)).filter(Boolean),
    receivedBy:{session,phone:receivedBy||(receivedSession?null:mainPhone),main:session===SESSION}};
}
// A regular user sees a customer only inside a campaign they hold, so a
// requirement can be assigned only to users holding the campaign of the number
// that received it (others would never see the chat).
async function eligibleAssignees(users,session=SESSION){
  const phone=await phones.phone(session).catch(()=>null);
  if(!phone)return {phone:null,users:new Map()};
  const holders=new Set(await campaignStoreDb.userIdsFor(session,String(phone)));
  return {phone:String(phone),users:new Map([...users].filter(([id])=>holders.has(id)))};
}
const unconfirmed='Could not confirm the WhatsApp number that received this requirement. Check that it is connected, then try again.';
app.get('/api/admin/offline-requirements/assignees',protectedRoute,adminAccess,async(req,res)=>{
  try{
    let session=SESSION;
    if(req.query.requirement!==undefined){
      const id=requirementId(String(req.query.requirement));
      if(!id)return res.status(400).json({error:'Invalid requirement ID'});
      const row=await requirements.get(id);
      if(!row)return res.status(404).json({error:'Requirement not found'});
      session=receivedSessionOf(row);
    }
    const {phone,users}=await eligibleAssignees(await requirementAssignees(),session);
    if(!phone)return res.status(503).json({error:unconfirmed});
    res.json({session,phone,users:[...users.values()]});
  }
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
    const existing=await requirements.get(id);
    if(!existing)return res.status(404).json({error:'Requirement not found'});
    const users=await requirementAssignees();
    const eligible=await eligibleAssignees(users,receivedSessionOf(existing));
    if(!eligible.phone)return res.status(503).json({error:unconfirmed});
    if(!userIds.every(userId=>eligible.users.has(userId)))return res.status(422).json({error:'Select users who hold the campaign of the number that received this requirement'});
    const result=await requirements.setAssignees(id,userIds,expectedUserIds,users);
    if(result.status===404)return res.status(404).json({error:'Requirement not found'});
    if(result.status===409)return res.status(409).json({error:'Assignments changed. Refresh before saving.'});
    // Users added to this requirement just now are told (those already on it are not).
    for(const userId of userIds){
      const user=users.get(userId);
      if(user && !existing.assignedUserIds.includes(userId))notices.add(user.username,{type:'requirement.assigned',session:receivedSessionOf(existing),
        campaignPhone:eligible.phone,requirementId:id,name:existing.name,phoneNumber:existing.phone,by:assigner(req.auth.sub)}).catch(()=>{});
    }
    res.json({requirement:requirementProfile(result.requirement,users,await mainNumber())});
  }catch{res.status(503).json({error:'Could not save requirement assignments'});}
});
app.get('/api/admin/offline-requirements',protectedRoute,adminAccess,async(req,res)=>{
  const range=requirementRange(req.query);
  if(!range)return res.status(400).json({error:'Use valid YYYY-MM-DD dates with from on or before to'});
  try{
    const paging=pageRequest(req.query),q=searchTerm(req.query.q);
    if(paging===false || q===false)return badPage(res);
    if(!paging){
      const [rows,users,mainPhone]=await Promise.all([requirements.list(range),requirementAssignees(),mainNumber()]);
      return res.json({...range,requirements:rows.map(row=>requirementProfile(row,users,mainPhone))});
    }
    const [{rows,total},users,mainPhone]=await Promise.all([requirements.page(range,{q,...paging}),requirementAssignees(),mainNumber()]);
    res.json({...range,requirements:rows.map(row=>requirementProfile(row,users,mainPhone)),...pageMeta(paging,total)});
  }
  catch{res.status(503).json({error:'Offline requirements database unavailable'});}
});
// Admins add, edit and delete requirements by hand (the WhatsApp intake adds
// them automatically). All four details are required.
async function requirementInput(body,existing=null){
  const {name,phone,query,dateReceived,receivedSession}=body ?? {};
  if(typeof receivedSession!=='string' || !validInboxName(receivedSession))return {error:'Choose which of our WhatsApp numbers received this requirement.'};
  if(typeof name!=='string' || !name.trim() || name.trim().length>128)return {error:'Enter the customer name (up to 128 characters).'};
  if(!Number.isSafeInteger(phone) || !/^[1-9]\d{6,14}$/.test(String(phone)))return {error:phoneRule};
  if(typeof query!=='string' || !query.trim() || query.length>4000)return {error:'Enter the requirement (up to 4000 characters).'};
  if(typeof dateReceived!=='string' || !requirementRange({from:dateReceived,to:dateReceived}))return {error:'Enter a valid date received.'};
  if(dateReceived>receivedDate(Date.now()))return {error:'The date received cannot be in the future.'};
  const value={name:name.trim(),phone,query:query.trim(),dateReceived,receivedSession};
  const connected=(await directory().catch(()=>[])).find(item=>item.name===receivedSession && item.status==='WORKING');
  const ours=connected && campaignPhone(connected);
  if(ours)return {value:{...value,receivedBy:String(ours)}};
  if(existing && receivedSessionOf(existing)===receivedSession)return {value:{...value,receivedBy:existing.receivedBy}};
  return {error:'That WhatsApp number is not connected right now. Choose a connected number.'};
}
const requirementId=raw=>/^\d{1,15}$/.test(raw) && Number(raw)>0 ? Number(raw) : null;
app.post('/api/admin/offline-requirements',protectedRoute,adminAccess,async(req,res)=>{
  try{
    const input=await requirementInput(req.body);
    if(input.error)return res.status(400).json({error:input.error});
    const [row,users,mainPhone]=await Promise.all([requirements.create(input.value),requirementAssignees(),mainNumber()]);
    res.status(201).json({requirement:requirementProfile(row,users,mainPhone)});
  }catch{res.status(503).json({error:'Could not save the requirement'});}
});
app.patch('/api/admin/offline-requirements/:id',protectedRoute,adminAccess,async(req,res)=>{
  const id=requirementId(req.params.id);
  if(!id)return res.status(400).json({error:'Invalid requirement ID'});
  try{
    const existing=await requirements.get(id);
    if(!existing)return res.status(404).json({error:'Requirement not found'});
    const input=await requirementInput(req.body,existing);
    if(input.error)return res.status(400).json({error:input.error});
    const [row,users,mainPhone]=await Promise.all([requirements.update(id,input.value),requirementAssignees(),mainNumber()]);
    if(!row)return res.status(404).json({error:'Requirement not found'});
    res.json({requirement:requirementProfile(row,users,mainPhone)});
  }catch{res.status(503).json({error:'Could not save the requirement'});}
});
app.delete('/api/admin/offline-requirements/:id',protectedRoute,adminAccess,async(req,res)=>{
  const id=requirementId(req.params.id);
  if(!id)return res.status(400).json({error:'Invalid requirement ID'});
  try{
    if(!await requirements.remove(id))return res.status(404).json({error:'Requirement not found'});
    res.sendStatus(204);
  }catch{res.status(503).json({error:'Could not delete the requirement'});}
});
function superUserOnly(req,res,next){
  if(roleOf(req.auth.sub)!=='super_user') return res.status(403).json({error:'Super user access required'});
  next();
}
const accountFields={
  // No spaces anywhere and no capital letters (any alphabet), for new and renamed accounts.
  username:v=>typeof v==='string' && v.length>=1 && v.length<=64 && !/\s/u.test(v) && v===v.toLowerCase(),
  name:v=>typeof v==='string' && !!v.trim() && v.length<=128,
  password:v=>typeof v==='string' && v.length>=8 && v.length<=256,
  // Required: the full international number, 7 to 15 digits (no leading 0).
  phoneNumber:v=>Number.isSafeInteger(v) && v>=1000000 && v<=999999999999999,
  isAdmin:v=>typeof v==='boolean',
  banLogin:v=>typeof v==='boolean'
};
const usernameRule='Usernames must be 1 to 64 characters with no spaces and no capital letters.';
const phoneRule='Enter the phone number with country code: 7 to 15 digits, without a leading 0.';
// Name, username, password and phone are all required for a new account.
function missingAccountFields(body){
  const blank=value=>value===undefined || value===null || (typeof value==='string' && !value.trim());
  return [['name',body.name],['username',body.username],['password',body.password],['phone number',body.phoneNumber]]
    .filter(([,value])=>blank(value)).map(([label])=>label);
}
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
  const {username,password,name,phoneNumber,isAdmin=false,banLogin=false}=req.body || {};
  const missing=missingAccountFields(req.body || {});
  if(missing.length)return res.status(400).json({error:'Required: '+missing.join(', ')+'.'});
  if(typeof username==='string' && !accountFields.username(username))
    return res.status(400).json({error:usernameRule});
  if(!accountFields.phoneNumber(phoneNumber))return res.status(400).json({error:phoneRule});
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
// Super user, then admins, then whoever is signed in, then by name.
const directoryOrder=(a,b)=>(b.isSuperUser-a.isSuperUser)||(b.isAdmin-a.isAdmin)||((b.sessionId!=null)-(a.sessionId!=null))||
  String(a.name??a.username).localeCompare(String(b.name??b.username));
// Filters: role=user (regular users only), campaign+campaignPhone (users holding
// that campaign), q (name, username or phone). Paged with ?page / ?pageSize.
// Accounts number in the dozens and their order depends on live sign-ins, so
// they are filtered and paged here rather than in SQL; only one page is sent.
app.get('/api/admin/users',protectedRoute,adminAccess,async(req,res)=>{
  const paging=pageRequest(req.query),q=searchTerm(req.query.q);
  const {role,campaign,campaignPhone:phone}=req.query;
  if(paging===false || q===false)return badPage(res);
  if((role!==undefined && role!=='user') || (campaign!==undefined && (!validInboxName(campaign) || !/^[1-9]\d{0,14}$/.test(String(phone)))))
    return res.status(400).json({error:'Invalid user filter'});
  try{
    let users=(await accounts.list()).map(userProfile);
    if(role==='user')users=users.filter(u=>!u.isAdmin && !u.isSuperUser);
    const summary={total:users.length,online:users.filter(u=>u.sessionId!=null).length};
    if(campaign!==undefined){
      const holders=new Set(await campaignStoreDb.userIdsFor(campaign,String(phone)));
      users=users.filter(u=>holders.has(u.id));
    }
    if(q)users=users.filter(u=>[u.name,u.username,u.phoneNumber].some(v=>String(v??'').toLowerCase().includes(q)));
    users.sort(directoryOrder);
    if(!paging)return res.json({users,summary});
    res.json({users:users.slice(paging.offset,paging.offset+paging.pageSize),summary,...pageMeta(paging,users.length)});
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
    if(typeof req.body?.username==='string' && !accountFields.username(req.body.username))return res.status(400).json({error:usernameRule});
    // Name, username and phone cannot be cleared; the password changes only when given.
    for(const [key,label] of [['name','name'],['username','username'],['phoneNumber','phone number']])
      if(req.body && Object.hasOwn(req.body,key) && (req.body[key]===null || (typeof req.body[key]==='string' && !req.body[key].trim())))
        return res.status(400).json({error:'The '+label+' is required.'});
    if(req.body && Object.hasOwn(req.body,'phoneNumber') && !accountFields.phoneNumber(req.body.phoneNumber))return res.status(400).json({error:phoneRule});
    if(!validFields(req.body))return res.status(400).json({error:'Invalid or unsupported profile fields'});
    try{
      // Older accounts may have no phone yet: an update must add one.
      const current=await accounts.get(req.accountId);
      if(current && canManageAccount(req.auth.sub,current) && current.phoneNumber==null && !Object.hasOwn(req.body,'phoneNumber'))
        return res.status(400).json({error:'This user has no phone number yet. Add one (with country code) to save changes.'});
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
  if(regular){req.url='/api/campaign-contacts';return (await inboxRouter(SESSION))(req,res,()=>res.sendStatus(404));}
  const {username}=req.query;
  if(!regular && username!==undefined && !accountFields.username(username))return res.status(400).json({error:'Invalid username'});
  try{
    const assignments=await assigned.list(regular?req.auth.sub:username);
    if(regular){
      const manual=new Set(assignments.map(row=>row.phoneNumber));
      for(const phoneNumber of await requirements.numbersFor(req.userId,SESSION,true)){
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

const wahaHeaders=()=>({'X-Api-Key':process.env.WAHA_API_KEY});
const inboxRegistry=records(db,'connected-inboxes');
const routers=new Map();
const directory=mountNumberManagement(app,{protectedRoute,adminAccess,base:WAHA,headers:wahaHeaders,defaultSession:SESSION,
  // A number deleted on the Add Number tab is not restarted with the backend,
  // and everything kept for it is erased (number-retirement.js).
  onSessionDeleted:async name=>{
    try{
      await inboxRegistry.drop(name);
      await numberState.remove(name);
      const router=await routers.get(name)?.catch(()=>null);
      routers.delete(name);router?.shutdown();phones.invalidate(name);
    }catch{console.error('A deleted WhatsApp number could not be fully erased');}
  }});
const sessionNamespaces=name=>{const key=crypto.createHash('sha256').update(name).digest('hex');return ['personal:'+key,'labels:'+key,'broadcasts:'+key];};
numberState=await numberRetirement({store:records(db,'number-state'),campaigns:campaignStoreDb,
  async forget(name){
    await (await routers.get(name)?.catch(()=>null))?.forget();
    await db.use(s=>s.run('DELETE FROM app_records WHERE namespace IN (?,?,?)',sessionNamespaces(name)));
  }});
// Devices keep chat history per account ID (inbox-availability). This lists the
// IDs still valid for this user; a device deletes what it holds under any other
// ID, unless that history's number is listed as pending (not connected just
// now, so nothing can be concluded about it).
app.get('/api/history-accounts',protectedRoute,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
    const role=roleOf(req.auth.sub),accounts=[],pending=[];
    const held=role==='user'?new Set((await campaignStoreDb.forUser(req.userId)).map(grant=>grant.session)):null;
    for(const row of await directory()){
      if(held && !held.has(row.name))continue;
      if(row.status!=='WORKING'){pending.push(row.name);continue;}
      try{
        if(!routers.has(row.name))await inboxRegistry.put(row.name,'true');
        const account=await (await inboxRouter(row.name)).accountFor(req.userId,role);
        if(account)accounts.push(account);
      }catch{pending.push(row.name);}
    }
    res.json({accounts,pending});
  }catch{res.status(503).json({error:'Could not list history accounts'});}
});

// "A customer was assigned to you" notifications (assignment-notices.js). They
// belong to the user, not to one WhatsApp number, so every open stream of that
// user carries them whichever number it shows.
const notices=assignmentNotices(records(db,'assignment-notices'));
// Who assigned it, as the assigned user will read it (actor: the admin's username).
const assigner=actor=>({username:actor,name:sessions.get(actor)?.name||actor,role:roleOf(actor)});
// A user's notices that still hold: the customer is still assigned to them on
// that number, they still hold the number, or they are still on the
// requirement. One whose assignment was since edited, moved, removed or whose
// campaign was taken away is dropped here, however that happened.
async function currentNotices(username,userId){
  const rows=await notices.list(username),grants=new Map(),kept=[],stale=[];
  for(const row of rows){
    let holds;
    if(row.type==='requirement.assigned')holds=!!(await requirements.get(row.requirementId))?.assignedUserIds.includes(userId);
    else{
      const key=JSON.stringify([row.session,row.campaignPhone]);
      if(!grants.has(key)){
        const grant=await campaignStoreDb.get(row.session,row.campaignPhone,userId);
        grants.set(key,grant && new Set(grant.contacts.map(c=>String(c.phoneNumber))));
      }
      const customers=grants.get(key);
      holds=row.type==='number.assigned'?!!customers:!!customers?.has(row.phoneNumber);
    }
    (holds?kept:stale).push(row);
  }
  if(stale.length)notices.remove(username,stale.map(row=>row.id)).catch(()=>{});
  return kept;
}
// The user opened or dismissed notices: one (/:id), several together (body
// {ids}, a grouped entry), or all of theirs (neither).
const noticeId=id=>typeof id==='string' && /^[0-9a-f-]{36}$/.test(id);
app.delete(['/api/assignment-notices','/api/assignment-notices/:id'],protectedRoute,async(req,res)=>{
  const ids=req.params.id===undefined?req.body?.ids:undefined;
  const target=req.params.id??ids;
  if(target!==undefined && !(Array.isArray(target)?target.length>0 && target.length<=200 && target.every(noticeId):noticeId(target)))
    return res.status(400).json({error:'Invalid notification'});
  try{await notices.dismiss(req.auth.sub,target);res.sendStatus(204);}
  catch{res.status(503).json({error:'Could not update notifications'});}
});
// The user opened a customer's chat: its "New" tag (and bell entry) is done with.
app.post('/api/assignment-notices/opened',protectedRoute,async(req,res)=>{
  const {session,phoneNumber}=req.body??{};
  if(typeof session!=='string' || !validInboxName(session) || typeof phoneNumber!=='string' || !/^[1-9]\d{0,14}$/.test(phoneNumber))
    return res.status(400).json({error:'Expected a WhatsApp number and a customer phone number'});
  try{await notices.opened(req.auth.sub,session,phoneNumber);res.sendStatus(204);}
  catch{res.status(503).json({error:'Could not update notifications'});}
});
// A user's own names for customers (contact-aliases.js): private to that user.
const aliases=contactAliases(records(db,'contact-aliases'));
app.get('/api/contact-aliases',protectedRoute,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{res.json({aliases:await aliases.list(req.auth.sub)});}
  catch{res.status(503).json({error:'Your contact names could not be loaded'});}
});
// Body {name}: the user's name for this customer; an empty name removes it.
app.put('/api/contact-aliases/:phone',protectedRoute,async(req,res)=>{
  try{res.json({aliases:await aliases.set(req.auth.sub,req.params.phone,req.body?.name)});}
  catch(err){res.status(err.status||503).json({error:err.status?err.message:'Could not save the name'});}
});
app.get('/api/my-campaigns',protectedRoute,async(req,res)=>{
  try{
    const rows=await directory();
    if(roleOf(req.auth.sub)!=='user')return res.json({sessions:rows.map(row=>({...row,phone:campaignPhone(row)})),defaultSession:SESSION});
    // Regular users see the campaign numbers assigned to them (to tell them
    // apart when switching), and nothing about other sessions.
    const granted=new Set((await campaignStoreDb.forUser(req.userId)).map(g=>JSON.stringify([g.session,g.phone])));
    const sessions=rows.filter(row=>granted.has(JSON.stringify([row.name,campaignPhone(row)])))
      .map(row=>({name:row.name,status:row.status,phone:campaignPhone(row)}));
    res.json({sessions,defaultSession:SESSION});
  }catch{res.status(503).json({error:'Could not load campaigns'});}
});
function inboxRouter(name){
  if(!routers.has(name)){
    const pending=createInboxRouter(name).catch(error=>{routers.delete(name);throw error;});
    routers.set(name,pending);
  }
  return routers.get(name);
}
app.use('/api/inboxes/:name',protectedRoute,async(req,res)=>{
  const name=req.params.name;
  if(!validInboxName(name))return res.sendStatus(404);
  try{
    // The primary inbox is also reachable here, so admin screens can address
    // every campaign number the same way.
    if(!routers.has(name)){
      if(!(await directory()).some(item=>item.name===name && item.status==='WORKING'))return res.status(409).json({error:'Inbox is not connected'});
      await inboxRegistry.put(name,'true');
    }
    const router=await inboxRouter(name);
    router(req,res,()=>res.sendStatus(404));
  }catch{res.status(503).json({error:'WhatsApp inbox unavailable'});}
});
// Must register SSE before proxy: proxy middleware falls through for incoming-text.
const server=http.createServer(app);
// Real-time team chat (WebSocket at /api/team-chat). Relayed live, never stored.
// The socket closes with the sign-in session (logout, ban, revoke, role change).
const chatRole=account=>account.username===USERNAME?'super_user':account.isAdmin?'admin':'user';
const teamChatServer=teamChat({server,allowedOrigin:isAllowedOrigin,otherUpgrade:dashboardUpgrade(WAHA,wahaHeaders),
  authenticate:({cookies})=>{
    const claims=sessionClaims(cookies.wa_access,ACCESS_SECRET,'access');
    const session=claims && sessions.get(claims.sub);
    // Team chat and the WAHA dashboard socket wait until a required password change is done.
    if(!session || session.mustChangePassword)return null;
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
const defaultBusy=process.env.BUSY_REPLIES_ENABLED==='true'?busyResponder({session:SESSION,staffOnline:chatId=>coverage.covered(chatId),phoneFor,
  onHeld:(chatId,key)=>defaultAlerts.add(chatId,key),onAttended:key=>defaultAlerts.clear(key),send:sendAutoReply,
  delayMs:seconds('BUSY_REPLY_DELAY_SECONDS',60),followUpGapMs:seconds('BUSY_FOLLOWUP_GAP_SECONDS',300),engagedMs:seconds('BUSY_ENGAGED_SECONDS',600),cooldownMs:seconds('BUSY_REPLY_COOLDOWN_SECONDS',1800)}):null;
if(away || defaultBusy){
  const stopListening=listenForAwayMessages(WAHA,SESSION,process.env.WAHA_API_KEY,
    async event=>{
      await coverage.resolve(event?.payload?.from);
      await Promise.all([away?.(event),defaultBusy?.handle(event)]);
    });
  server.once('close',()=>{stopListening();defaultBusy?.stop();});
}
async function createInboxRouter(SESSION){
  const app=express.Router();
  const primary=SESSION===defaultSession;
  const prefix=primary?'':'/api/inboxes/'+encodeURIComponent(SESSION);
  const sessionKey=crypto.createHash('sha256').update(SESSION).digest('hex');
  const sent=sentMessages(records(db,'sent'),SESSION);
  const alerts=primary?defaultAlerts:waitingAlerts();
  const busy=primary?defaultBusy:null;
  const sendRoutes=new Set(['sendText','sendImage','sendVideo','sendSeen','sendFile','sendVoice']);
  // Generous for people, tight for scripts: protects the number from WhatsApp bans.
  const sendLimit=windowLimiter({limit:120,windowMs:60_000});
  const labelAddLimit=windowLimiter({limit:60,windowMs:60_000});
  const MAX_STREAMS_PER_USER=8;
  const userStreams=new Map();
  function allowedWaha(method,path,role){
    if(method==='POST' && sendRoutes.has(path.slice('/api/'.length))) return true;
    if(method!=='GET' && method!=='HEAD') return false;
    if(path.startsWith('/api/files/') && path.slice(11).includes('/') && !path.startsWith('/api/files/'+encodeURIComponent(SESSION)+'/'))return false;
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
  const access=campaignAccess({session:SESSION,base:WAHA,headers:wahaHeaders,store:campaignStoreDb,requirements,primary,secret:ACCESS_SECRET,sent,phones});
  app.use('/api',protectedRoute,(req,res,next)=>roleOf(req.auth.sub)==='user'?access.gate(req,res,next):next());
  app.use('/api',campaignRoutes({store:campaignStoreDb,session:SESSION,primary,identity:access.identity,adminAccess,readLabels:access.readLabels,
    // The assigned user is told which customer, on which number, and by whom.
    onAssigned:({username,phoneNumber,campaignPhone,actor})=>notices.add(username,{session:SESSION,campaignPhone,phoneNumber,by:assigner(actor)}),
    // A user given this WhatsApp number (Assign WA Num) is told as well.
    onGranted:({username,campaignPhone,actor})=>notices.add(username,{type:'number.assigned',session:SESSION,campaignPhone,by:assigner(actor)})}));
  app.get('/api/inbox-availability',async(req,res)=>{
    try{
      // The browser polls this every 5 s to notice a re-paired number or lost access. The
      // phone answer is shared by all tabs and at most 5 s old, so WAHA gets one call per
      // number per 5 s instead of one per tab (audit PERF-04).
      const phone=req.campaign?.phone || await access.identity({maxAgeMs:AVAILABILITY_MAX_AGE_MS});
      if(!phone)return res.json({account:null});
      res.json({account:accountId(req.campaign,phone,req.userId)});
    }catch(err){res.sendStatus(err.status||502);}
  });
  // The browser can partition local history without revealing the sender number to regular users.
  // The number's generation is part of it once a number has left this session name, so history
  // saved for the number that left is never opened again (number-retirement.js).
  function accountId(campaign,phone,userId){
    const parts=campaign?[SESSION,phone,userId,[...campaign.numbers].sort(),campaign.labels]:[SESSION,phone,userId];
    const generation=numberState.generation(SESSION);
    if(generation)parts.push({generation});
    return crypto.createHmac('sha256',process.env.WHATIX_PASSWORD_SECRET || ACCESS_SECRET).update(JSON.stringify(parts)).digest('hex');
  }
  // This user's account ID here, or null without access (/api/history-accounts).
  app.accountFor=async(userId,role)=>{
    if(role==='user'){const campaign=await access.load(userId);return campaign?accountId(campaign,campaign.phone,userId):null;}
    const phone=await access.identity();
    return phone?accountId(null,phone,userId):null;
  };
  // This number's own phone and linked ID rarely change: shared for 30 s, and
  // dropped when WAHA reports a session status change.
  let identityAnswer=null;
  app.get('/api/session-identity',adminAccess,async(_req,res)=>{
    res.set('Cache-Control','no-store');
    if(identityAnswer && Date.now()-identityAnswer.at<30000)return res.json(identityAnswer.body);
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
      const body={session:SESSION,number:match ? '+'+match[1] : null,lid:lid ? lid+'@lid' : null};
      if(match)identityAnswer={at:Date.now(),body};
      res.json(body);
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
    visible:(req,id)=>!req.campaign||req.campaign.numbers.has(id.split('@')[0])}));
  // Each add asks WhatsApp whether the number exists; regular users are paced.
  app.post('/api/business-labels/:id/contacts',(req,res,next)=>{
    if(roleOf(req.auth.sub)!=='user' || labelAddLimit.take(req.userId))return next();
    res.set('Retry-After',String(labelAddLimit.retryAfter(req.userId)));
    res.status(429).json({error:'Too many campaign changes. Wait a moment and try again.'});
  });
  app.use('/api/business-labels',businessLabelRoutes(WAHA,SESSION,wahaHeaders,adminAccess));
  app.put('/api/reaction',async(req,res)=>{
    const {messageId,reaction}=req.body || {};
    const chatId=typeof messageId==='string' && /^(?:true|false)_(\d+@(?:c\.us|lid|s\.whatsapp\.net))_/.exec(messageId)?.[1];
    if(!chatId || !validMessageId(messageId) || typeof reaction!=='string' || reaction.length>32)
      return res.status(400).json({error:'Invalid message or reaction'});
    try{
      const response=await fetch(WAHA+'/api/reaction',{method:'PUT',headers:{...wahaHeaders(),'Content-Type':'application/json'},
        body:JSON.stringify({session:SESSION,messageId,reaction}),signal:AbortSignal.timeout(15000)});
      await response.body?.cancel();
      if(!response.ok)return res.status(502).json({error:'WhatsApp declined the reaction'});
      res.sendStatus(204);
    }catch{res.status(502).json({error:'Could not reach WhatsApp'});}
  });
  const broadcasts=await broadcastQueue(records(db,'broadcasts:'+sessionKey),{
    send:async(job,number,body)=>{
      const owner=await accounts.get(job.owner);
      if(!owner || owner.banLogin || (!owner.isAdmin && !await access.allowed(await access.load(job.owner),number)))return {ok:false,error:'Recipient is no longer assigned'};
      return broadcastSender(WAHA,SESSION,wahaHeaders,sent)(job,number,body);
    },
    canSend:async id=>{const account=await accounts.get(id);return !!account && !account.banLogin;}
  });
  // A media link is downloaded by the backend (never by WAHA) when the job is accepted.
  app.post('/api/broadcasts',async(req,res,next)=>{
    const failed=await resolveBroadcastMedia(req.body);
    if(failed)return res.status(failed.status).json({error:failed.error});
    next();
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
  // The whole chat list in one answer (chat-list.js), instead of 100+ browser requests.
  const chats=chatList({base:WAHA,session:SESSION,headers:wahaHeaders});
  app.get('/api/chat-list',adminAccess,async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{
      // The list belongs to the phone this session is paired to right now. It is
      // checked again after reading: a session re-paired meanwhile is refused
      // rather than answered with chats that may come from two accounts.
      const account=await access.identity({maxAgeMs:AVAILABILITY_MAX_AGE_MS});
      if(!account)return res.status(409).json({error:'This WhatsApp number is not connected.'});
      const answer=await chats.get({stale:req.query.stale==='1',phones:req.query.phones==='1',account});
      if(await access.identity()!==account){
        chats.reset();
        return res.status(409).json({error:'This WhatsApp number changed. Try again.'});
      }
      res.json(answer);
    }catch{res.status(502).json({error:'The WhatsApp chat list could not be loaded.'});}
  });
  app.get('/api/contacts/name',async(req,res)=>{
    const {contactId}=req.query;
    if(typeof contactId!=='string' || !/^\d{1,20}@(c\.us|lid)$/.test(contactId))
      return res.status(400).json({error:'Expected a direct WhatsApp chat ID'});
    res.set('Cache-Control','no-store');
    try{
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
    if(req.path==='/incoming-text') return next();
    const pathname='/api'+req.path;
    if(!allowedWaha(req.method,pathname,roleOf(req.auth.sub))) return res.status(404).json({error:'Unsupported route'});
    if(sendRoutes.has(req.path.slice(1)) && (typeof req.body?.session!=='string' || req.body.session!==SESSION)) return res.status(400).json({error:'Invalid WAHA session'});
    if(req.query.session!==undefined && req.query.session!==SESSION)return res.status(400).json({error:'Invalid WAHA session'});
    const destination=WAHA+pathname+(req.url.includes('?')?'?'+req.url.split('?').slice(1).join('?'):'');
    let payload;
    if(req.method==='POST'){
      const route=req.path.slice(1);
      // Direct sends are paced per person; bulk sending goes through broadcasts.
      if(route!=='sendSeen' && !sendLimit.take(req.userId)){
        res.set('Retry-After',String(sendLimit.retryAfter(req.userId)));
        return res.status(429).json({error:'You are sending messages too quickly. Wait a moment, or use a broadcast for many recipients.'});
      }
      const shaped=await wahaSendBody(route,req.body,{session:SESSION,restricted:roleOf(req.auth.sub)==='user'});
      if(shaped.error)return res.status(shaped.status).json({error:shaped.error});
      payload=shaped.body;
    }
    try {
      const isFile=pathname.startsWith('/api/files/');
      const headers=wahaHeaders();
      if(req.method==='POST') headers['Content-Type']='application/json';
      if(isFile) {
        headers['Accept-Encoding']='identity';
        if(req.headers.range) headers.Range=req.headers.range;
      }
      const upstream=await fetch(destination,{method:req.method,headers,body:payload===undefined?undefined:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(120000)});
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
    let src; if(typeof media.url==='string'){try{const url=new URL(media.url,'http://localhost');if(url.pathname.startsWith('/api/files/'))src=prefix+url.pathname+url.search;}catch{}}
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
  // One WAHA socket for this inbox, shared by all its open streams (upstream-hub.js).
  // Bookkeeping that is the same for every viewer runs once per event here.
  const upstream=upstreamHub({
    url:()=>{
      const url=new URL(WAHA.replace(/^http/,'ws')+'/ws');url.searchParams.set('session',SESSION);url.searchParams.append('events','message');url.searchParams.append('events','message.ack');
      // WAHA supports API key in websocket query; never expose this URL to browser.
      for(const event of callEvents)url.searchParams.append('events',event);
      url.searchParams.append('events','message.reaction');
      url.searchParams.append('events','session.status');
      url.searchParams.set('x-api-key',process.env.WAHA_API_KEY);
      return url;
    },
    onEvent:event=>{
      if(event?.session===SESSION && event.event==='session.status'){
        phones.invalidate(SESSION);identityAnswer=null;directory.invalidate?.();chats.reset();
      }
      if(event?.session===SESSION && event.event==='message')chats.invalidate();
      // Call state is shared server-side (admins subscribe to it), so it is
      // recorded before any stream's own visibility filter.
      calls.observe(event);
    }
  });
  app.get('/api/incoming-text',(req,res)=>{
    res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();res.write('retry: 3000\n\n');
    // Waiting-client notifications, limited to chats this user can see: admins
    // and the super user see all, regular users only their assigned numbers.
    const viewer=sessions.get(req.auth.sub);
    const member={username:req.auth.sub,isAdmin:!!viewer?.isAdmin || req.auth.sub===USERNAME};
    const unsubscribeCalls=member.isAdmin ? calls.subscribe((name,data)=>{
      if(!res.destroyed)res.write('event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n');
    }) : null;
    res.write('event: client.waiting.snapshot\ndata: '+JSON.stringify(alerts.list().filter(alert=>member.isAdmin || req.campaign?.numbers.has(String(alert.openKey))))+'\n\n');
    const unsubscribeAlerts=alerts.subscribe(async(name,data)=>{
      if(!member.isAdmin){try{if(!await access.allowed(await access.load(req.userId),data.chatId||data.openKey||data.id))return;}catch{return;}}
      if(res.destroyed || res.writableEnded)return;
      res.write('event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n');
    });
    // Customers assigned to this user: those still unopened first, then live.
    const tell=(name,data)=>{if(!res.destroyed && !res.writableEnded)res.write('event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n');};
    currentNotices(req.auth.sub,req.userId).then(rows=>tell('assignment.snapshot',rows)).catch(()=>{});
    const unsubscribeNotices=notices.subscribe(req.auth.sub,tell);
    const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},20000);
    const onEvent=async event=>{
      if(event?.session===SESSION && event.event==='session.status'){
        if(!res.destroyed)res.write('event: inbox-status\ndata: {}\n\n');
        return;
      }
      if(!member.isAdmin){
        // The event is shared with other streams: this user's media links go on a copy.
        event=structuredClone(event);
        const payload=event?.payload||{};
        const id=payload.id?._serialized||payload.id;
        const destination=event.event==='message.reaction'?payload.reaction?.messageId?.split('_')[1]:
          event.event==='message.ack'?(payload.to || (typeof id==='string'?id.split('_')[1]:null)):payload.from;
        try{
          const current=await access.load(req.userId);
          if(!current || current.phone!==req.campaign.phone){finish();return;}
          if(!await access.allowed(current,destination) || res.destroyed || res.writableEnded)return;
          if(payload.media?.url)payload.media.url=access.media(current,payload.media.url,destination);
        }catch{return;}
      }
      if(event?.session===SESSION && event.event==='message.reaction'){
        const p=event.payload, id=p?.reaction?.messageId, text=p?.reaction?.text;
        const chatId=typeof id==='string' && /^(?:true|false)_(\d+@(?:c\.us|lid|s\.whatsapp\.net))_/.exec(id)?.[1];
        if(chatId && validMessageId(id) && typeof text==='string' && text.length<=32){
          const publish=()=>{
            if(!res.destroyed)
              res.write('event: reaction\ndata: '+JSON.stringify({id,text,actor:p.fromMe?'self':'peer',at:event.timestamp || Date.now()})+'\n\n');
          };
          publish();
        }
        return;
      }
      if(event?.session===SESSION && event.event==='message.ack'&&event.payload?.fromMe){
        const m=event.payload;const id=typeof m.id==='string'?m.id:m.id?._serialized;
        const stages={ERROR:-1,PENDING:0,SERVER:1,DEVICE:2,READ:3,PLAYED:4};const ack=stages[m.ackName]??m.ack;
        if(id&&Number.isInteger(ack))res.write('event: receipt\ndata: '+JSON.stringify({id,ack})+'\n\n');return;
      }
      const msg=incomingText(event,member.isAdmin);if(msg&&!res.destroyed)res.write('data: '+JSON.stringify(msg)+'\n\n');
    };
    const streams=sessions.get(req.auth.sub).streams;
    let unsubscribe=()=>{};
    const expires=setTimeout(finish,Math.max(0,req.auth.exp*1000-Date.now()));
    function finish(reason){
      if(!streams.delete(finish)) return;
      mine.delete(finish);
      if(!mine.size && userStreams.get(req.userId)===mine)userStreams.delete(req.userId);
      unsubscribeCalls?.();
      unsubscribeAlerts();
      unsubscribeNotices();
      clearInterval(heartbeat);
      clearTimeout(expires);
      unsubscribe();
      if(!res.destroyed){
        // Say why, so the browser shows the right message.
        if(reason==='admin_revoked' || reason==='signed_in_elsewhere') res.write('event: session-ended\ndata: '+JSON.stringify({reason})+'\n\n');
        res.end();
      }
    }
    streams.add(finish);
    // Past the cap, the oldest stream closes (a forgotten tab), so a new tab always connects.
    const mine=userStreams.get(req.userId) ?? new Set();
    userStreams.set(req.userId,mine);
    mine.add(finish);
    if(mine.size>MAX_STREAMS_PER_USER)mine.values().next().value('stream_limit');
    res.on('close',finish);
    // "ready" once WAHA's socket is open; a dropped socket ends the stream so the
    // browser reconnects and resyncs, as when each stream had its own socket.
    if(streams.has(finish))unsubscribe=upstream.subscribe({
      ready(){if(!res.destroyed)res.write('event: ready\ndata: {}\n\n');},
      lost(){finish();},
      event:onEvent
    });
  });
  // The number left this session (number-retirement.js): drop what is held for it in memory.
  app.forget=async()=>{await broadcasts.clear();chats.reset();phones.invalidate(SESSION);identityAnswer=null;};
  app.shutdown=()=>broadcasts.close();
  return app;
}
const defaultSession=SESSION;
app.use(await inboxRouter(SESSION));
// Restart durable broadcast workers even if no admin has reopened the inbox yet.
for(const name of await inboxRegistry.keys())if(validInboxName(name) && name!==SESSION)await inboxRouter(name);
server.listen(PORT,'0.0.0.0',()=>console.log(`Secure WAHA backend listening on ${server.address().port}`));
