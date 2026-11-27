import crypto from 'node:crypto';
import {promisify} from 'node:util';
const derive=promisify(crypto.scrypt);
export const verifierPattern=/^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
export async function hashPassword(password){
  const salt=crypto.randomBytes(16).toString('hex');
  return 'scrypt$'+salt+'$'+(await derive(password,salt,64)).toString('hex');
}
export function passwordCipher(key){
  if(key.length!==32)throw Error('Invalid account encryption key');
  return {
    seal(hash,id,username){
      const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
      cipher.setAAD(Buffer.from(JSON.stringify([id,username])));
      const data=Buffer.concat([cipher.update(hash,'utf8'),cipher.final()]);
      return ['v1',iv.toString('hex'),cipher.getAuthTag().toString('hex'),data.toString('hex')].join(':');
    },
    open(value,id,username){
      const [version,iv,tag,data]=value.split(':');
      if(version!=='v1')throw Error('Unknown password format');
      const cipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'hex'));
      cipher.setAAD(Buffer.from(JSON.stringify([id,username])));
      cipher.setAuthTag(Buffer.from(tag,'hex'));
      const hash=Buffer.concat([cipher.update(Buffer.from(data,'hex')),cipher.final()]).toString();
      if(!verifierPattern.test(hash))throw Error('Invalid password verifier');
      return hash;
    }
  };
}
function profile(row){
  return row?{id:row.ID,name:row.NAME,username:row.USER_NAME,banLogin:!!row.BAN_LOGIN,dateCreated:row.DATE_CREATED,
    userIp:row.USER_IP,phoneNumber:row.PHONE_NUMBER,isAdmin:!!row.IS_ADMIN,mustChangePassword:!!row.MUST_CHANGE_PASSWORD}:null;
}
export function accountStore(db,admin,cipher){
  const get=(s,id)=>s.get('SELECT * FROM users WHERE ID=?',[id]);
  // scrypt is slow on purpose. It runs outside the database queue, so a sign-in
  // (or a burst of wrong passwords) never stalls other requests (audit PERF-01).
  // Callers re-read the row afterwards and give up if it changed meanwhile.
  async function matches(row,password){
    const [,salt,hex]=cipher.open(row.PASSWORD,row.ID,row.USER_NAME).match(verifierPattern);
    return crypto.timingSafeEqual(await derive(password,salt,64),Buffer.from(hex,'hex'));
  }
  const unchanged=(now,before)=>now && now.USER_NAME===before.USER_NAME && now.PASSWORD===before.PASSWORD;
  const reserved=u=>u===admin||u==='super_user';
  const exists=(s,u)=>s.get('SELECT ID FROM users WHERE USER_NAME=?',[u]);
  return {
    usernameAvailable:u=>db.use(async s=>!reserved(u)&&!await exists(s,u)),
    list:()=>db.use(async s=>(await s.all('SELECT * FROM users ORDER BY ID')).map(profile)),
    get:id=>db.use(async s=>profile(await get(s,id))),
    async add(input){
      const hash=await hashPassword(input.password);
      return db.transaction(async s=>{
      const {name,username,phoneNumber,isAdmin,banLogin}=input;
      if(reserved(username)||await exists(s,username))return null;
      // The admin chose this password, so the user replaces it at their first sign-in.
      const {id}=await s.run("INSERT INTO users(NAME,USER_NAME,PASSWORD,BAN_LOGIN,DATE_CREATED,PHONE_NUMBER,IS_ADMIN,MUST_CHANGE_PASSWORD) VALUES(?,?,'',?,?,?,?,1)",
        [name,username,+banLogin,new Date().toISOString(),phoneNumber,+isAdmin]);
      await s.run('UPDATE users SET PASSWORD=? WHERE ID=?',[cipher.seal(hash,id,username),id]);
      return profile(await get(s,id));
    });},
    async update(id,changes,allowed,revoke){
      let revoked;
      const hashed=changes.password===undefined?undefined:await hashPassword(changes.password);
      const result=await db.transaction(async s=>{
        const row=await get(s,id),prev=profile(row);
        if(!row)return {status:404};
        if(prev.username===admin||!allowed(prev))return {status:403};
        const username=changes.username??prev.username,renamed=username!==prev.username;
        if(renamed&&(reserved(username)||await exists(s,username)))return {status:409};
        let password=row.PASSWORD;
        if(renamed||changes.password!==undefined)password=cipher.seal(changes.password===undefined?
          cipher.open(password,id,prev.username):hashed,id,username);
        const next={...prev,...changes,username};
        // An admin-set password is known to that admin: the user must replace it at their next sign-in.
        const mustChange=changes.password!==undefined?1:+prev.mustChangePassword;
        await s.run('UPDATE users SET NAME=?,USER_NAME=?,PASSWORD=?,BAN_LOGIN=?,PHONE_NUMBER=?,IS_ADMIN=?,MUST_CHANGE_PASSWORD=? WHERE ID=?',
          [next.name.trim(),username,password,+next.banLogin,next.phoneNumber,+next.isAdmin,mustChange,id]);
        if(renamed||changes.password!==undefined||changes.banLogin===true||prev.isAdmin!==next.isAdmin)revoked=prev;
        return {status:200,user:profile(await get(s,id))};
      });
      if(revoked)revoke(revoked);
      return result;
    },
    async remove(id,allowed,revoke){
      let removed;
      const status=await db.transaction(async s=>{
        const user=profile(await get(s,id));
        if(!user)return 404;
        if(user.username===admin||!allowed(user))return 403;
        await s.run('DELETE FROM users WHERE ID=?',[id]);removed=user;return 204;
      });
      if(removed)revoke(removed);
      return status;
    },
    async login(username,password,ip,verified){
      const checked=await db.use(s=>s.get('SELECT * FROM users WHERE USER_NAME=?',[username]));
      if(!checked || !await matches(checked,password))return {status:401};
      return db.use(async s=>{
        const row=await get(s,checked.ID);
        // Renamed, deleted or given a new password while the hash ran: not this password any more.
        if(!unchanged(row,checked))return {status:401};
        if(row.BAN_LOGIN)return {status:403};
        const result=verified(profile(row),false);
        if(result.status!==200)return result;
        if(row.USER_IP!==ip)await s.run('UPDATE users SET USER_IP=? WHERE ID=?',[ip,row.ID]);
        return verified(profile({...row,USER_IP:ip}),true);
      });
    },
    // Self-service change: the caller proves the current password first.
    async changePassword(id,current,next){
      const row=await db.use(s=>get(s,id));
      if(!row)return 404;
      if(!await matches(row,current))return 403;
      const hash=await hashPassword(next);
      return db.transaction(async s=>{
        const now=await get(s,id);
        if(!now)return 404;
        // Changed by someone else while hashing: the "current" password is no longer current.
        if(!unchanged(now,row))return 403;
        await s.run('UPDATE users SET PASSWORD=?,MUST_CHANGE_PASSWORD=0 WHERE ID=?',[cipher.seal(hash,now.ID,now.USER_NAME),now.ID]);
        return 204;
      });
    },
    async passwordMatches(username,password){
      const row=await db.use(s=>s.get('SELECT * FROM users WHERE USER_NAME=?',[username]));
      return !!row && await matches(row,password);
    },
    ban(id,banLogin,guard,afterSave){return db.use(async s=>{
      const user=profile(await get(s,id));
      if(!user)return 404;
      if(user.username===admin)return 403;
      const status=guard(user);if(status!==204)return status;
      await s.run('UPDATE users SET BAN_LOGIN=? WHERE ID=?',[+banLogin,id]);
      afterSave({...user,banLogin});return 204;
    });}
  };
}
