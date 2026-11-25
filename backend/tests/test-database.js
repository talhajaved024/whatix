import {connectDatabase,schema} from '../src/sqlite.js';

export async function testDatabase(t){
  const db=await connectDatabase(':memory:');
  t.after(()=>db.close());
  await db.use(s=>s.exec(schema));
  return db;
}
