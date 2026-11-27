import {connectDatabase,schema,campaignSchema,auditSchema,indexSchema,labelScopeSchema,receivedBySchema,passwordChangeSchema} from '../src/sqlite.js';

export async function testDatabase(t){
  const db=await connectDatabase(':memory:');
  t.after(()=>db.close());
  await db.use(s=>s.exec(schema+campaignSchema+auditSchema+indexSchema+labelScopeSchema+receivedBySchema+passwordChangeSchema));
  return db;
}

// Accounts an admin creates must choose their own password at the first sign-in.
// Tests that only need a working account do that here, then set the original
// password back, so the rest of the test can keep signing in with it.
export async function completePasswordSetup(base,username,password){
  const login=async pass=>{
    const response=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({credentials:Buffer.from(JSON.stringify({username,password:pass})).toString('base64')})});
    if(response.status!==200)throw Error('Sign-in for '+username+' failed: '+response.status);
    return response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  };
  const change=async(Cookie,currentPassword,newPassword)=>{
    const response=await fetch(base+'/auth/password',{method:'POST',headers:{Cookie,'Content-Type':'application/json'},
      body:JSON.stringify({currentPassword,newPassword})});
    if(response.status!==204)throw Error('Password change for '+username+' failed: '+response.status);
  };
  const temporary=password+'-own';
  await change(await login(password),password,temporary);
  await change(await login(temporary),temporary,password);
}
