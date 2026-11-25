export function assignmentStore(db){
  const select='SELECT ID AS id,phone_number AS phoneNumber,user_name AS username FROM assigned_numbers';
  const get=(s,id)=>s.get(select+' WHERE ID=?',[id]);
  function save(id,changes){return db.transaction(async s=>{
    const old=id===null?{}:await get(s,id);
    if(!old)return {status:404};
    const {phoneNumber,username}={...old,...changes};
    const dup=await s.get('SELECT ID FROM assigned_numbers WHERE phone_number=? AND user_name=?',[phoneNumber,username]);
    if(dup&&dup.ID!==id)return {status:409};
    const create=id===null;
    if(create)id=(await s.run('INSERT INTO assigned_numbers(phone_number,user_name) VALUES(?,?)',[phoneNumber,username])).id;
    else await s.run('UPDATE assigned_numbers SET phone_number=?,user_name=? WHERE ID=?',[phoneNumber,username,id]);
    return {status:create?201:200,assignment:{id,phoneNumber,username}};
  });}
  return {
    list:username=>db.use(s=>username===undefined?s.all(select+' ORDER BY ID'):s.all(select+' WHERE user_name=? ORDER BY ID',[username])),
    get:id=>db.use(s=>get(s,id)),add:input=>save(null,input),update:save,
    remove:id=>db.use(async s=>(await s.run('DELETE FROM assigned_numbers WHERE ID=?',[id])).changes?204:404)
  };
}
