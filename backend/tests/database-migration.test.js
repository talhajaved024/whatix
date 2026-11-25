import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ExcelJS from 'exceljs';
import {openWhatix} from '../src/whatix.js';
import {accountStore,hashPassword,passwordCipher} from '../src/accounts.js';
import {assignmentStore} from '../src/assigned-numbers.js';
import {connectDatabase} from '../src/sqlite.js';

test('migration rolls back on an unreadable credential, preserves IDs and reopens without source files',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'whatix-migration-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,'source');
  await mkdir(source);
  const options={path:join(dir,'whatix.db'),usersPath:join(source,'users.xlsx'),assignedPath:join(source,'assigned_numbers.xlsx'),
    admin:'administrator',secret:randomUUID()};
  const key=randomBytes(32),cipher=passwordCipher(key),password=randomUUID();
  const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Users');
  sheet.addRow(['ID','NAME','USER_NAME','PASSWORD','BAN_LOGIN','DATE_CREATED','USER_IP','PHONE_NUMBER','IS_ADMIN']);
  sheet.addRow([4,'Administrator','administrator',cipher.seal(await hashPassword(password),4,'administrator'),false,null,null,null,true]);
  sheet.addRow([8,'Member','member',cipher.seal(await hashPassword(password),8,'member'),false,null,null,null,false]);
  book.addWorksheet('AccountSequence').addRow(['lastId',20]);
  await book.xlsx.writeFile(options.usersPath);
  await writeFile(options.usersPath+'.key',randomBytes(32));
  await assert.rejects(openWhatix(options));
  const empty=await connectDatabase(options.path);
  try{
    assert.equal((await empty.use(s=>s.get('PRAGMA user_version'))).user_version,0);
    assert.equal((await empty.use(s=>s.all("SELECT name FROM sqlite_master WHERE type='table'"))).length,0);
  }finally{await empty.close();}
  await writeFile(options.usersPath+'.key',key);
  const assignments=new ExcelJS.Workbook();
  assignments.addWorksheet('AssignedNumbers').addRows([['ID','phone_number','user_name'],[3,923324479729,'member']]);
  assignments.addWorksheet('AssignmentSequence').addRow(['lastId',12]);
  await assignments.xlsx.writeFile(options.assignedPath);
  const imported=await openWhatix(options);
  try{
    const accounts=accountStore(imported.db,options.admin,imported.cipher);
    assert.equal((await accounts.login('member',password,'test',()=>({status:200}))).status,200);
    assert.equal((await accounts.add({name:'New',username:'new',password,isAdmin:false,banLogin:false})).id,21);
    assert.equal((await assignmentStore(imported.db).add({phoneNumber:923204569689,username:'new'})).assignment.id,13);
  }finally{await imported.db.close();}
  await rename(source,join(dir,'backup'));
  const reopened=await openWhatix(options);
  try{
    const accounts=accountStore(reopened.db,options.admin,reopened.cipher);
    assert.equal((await accounts.login('new',password,'test',()=>({status:200}))).status,200);
    assert.equal((await assignmentStore(reopened.db).list()).length,2);
  }finally{await reopened.db.close();}
});
