const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
test('reference resolve is idempotent, preserves duplicates and rolls back entire portion',async()=>{
 const db=new PGlite();try {
  await db.exec('create role anon;create role authenticated;create table shops(shop_id bigint primary key,data jsonb);create table details(detail_id bigint primary key,data jsonb);');
  await db.exec(fs.readFileSync('supabase/migrations/20261005010000_traffic_detail_suggestions.sql','utf8'));
  await db.exec(fs.readFileSync('supabase/migrations/20261011040000_stock_reference_resolve.sql','utf8'));
  const rpc=async items=>(await db.query('select stock_resolve_references($1::jsonb) as r',[JSON.stringify(items)])).rows[0].r;
  const items=Array.from({length:100},(_,i)=>({key:String(i),kind:'details',name:'Name '+i}));
  const first=await rpc(items);assert.equal(first.length,100);assert.ok(first.every(x=>x.status==='created'));
  const retry=await rpc(items);assert.deepEqual(retry.map(x=>x.id),first.map(x=>x.id));assert.ok(retry.every(x=>x.status==='existing'));
  await db.exec(`insert into details values(101,'"NAME 0"');`);
  const duplicate=await rpc([{key:'one',kind:'details',name:'Name 0'}]);assert.equal(duplicate[0].id,1);assert.equal(duplicate[0].status,'ambiguous');
  assert.equal((await rpc([{key:'one',kind:'details',name:'NAME 0',id:101}]))[0].id,101);
  await assert.rejects(rpc([{key:'new',kind:'shops',name:'Rollback'},{key:'bad',kind:'details',name:'Missing',id:9999}]));
  assert.equal((await db.query('select count(*)::int as n from shops')).rows[0].n,0);
  await assert.rejects(rpc(Array.from({length:101},(_,i)=>({key:String(i),kind:'details',name:'Overflow'}))));
  await db.exec('alter table details alter column data type text using data#>>\'{}\';');
  assert.equal((await rpc([{key:"text",kind:"details",name:"Текстова деталь"}]))[0].canonical,"Текстова деталь");
  assert.equal((await db.query("select data from details order by detail_id desc limit 1")).rows[0].data,"Текстова деталь");
  const concurrent=await Promise.all([rpc([{key:'a',kind:'shops',name:'New Shop'}]),rpc([{key:'b',kind:'shops',name:'new   shop'}])]);
  assert.equal(concurrent[0][0].id,concurrent[1][0].id);
 }finally{await db.close();}
});
