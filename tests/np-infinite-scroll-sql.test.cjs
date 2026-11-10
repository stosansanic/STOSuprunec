const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
test('NP archive returns 50 then 10, filters before slicing and protects linked act numbers',async()=>{
 const db=new PGlite();try {
  await db.exec("create role anon;create role authenticated;create role service_role;create table novaposhta(ttn text primary key,data jsonb,act_ids bigint[],last_seen_at timestamptz,document_date text,direction text);create function np_online_can_act(integer,bigint,boolean) returns boolean language sql as $$select $2=1$$;");
  const sql=fs.readFileSync('supabase/migrations/20261011123102_nova_poshta_infinite_scroll.sql','utf8');
  await db.exec(sql);await db.exec(sql);
  await db.exec("insert into novaposhta select lpad(n::text,14,'0'),jsonb_build_object('state',case when n=1 then 'arrived' else 'transit' end,'origin','Kyiv'),array[1,999]::bigint[],now(),'2026-10-11','incoming' from generate_series(1,62) n;grant select on novaposhta to service_role;set role service_role;");
  const read=async(offset,size,query='',state=null)=>(await db.query("select np_archive_list_v2(1,$1,$2,null,null,null,null,$3,$4) v",[offset,size,query,state])).rows[0].v;
  const all=[];
  for(const [offset,size,length,more] of [[0,50,50,true],[50,10,10,true],[60,10,2,false]]){
   const p=await read(offset,size);assert.equal(p.shipments.length,length);assert.equal(p.has_more,more);all.push(...p.shipments.map(s=>s.ttn));
   p.shipments.forEach(s=>assert.deepEqual(s.act_ids,[1]));
  }
  assert.equal(new Set(all).size,62);assert.equal(all[0],'00000000000062');
  assert.equal((await read(0,50,'','arrived')).shipments[0].ttn,'00000000000001');
  assert.equal((await read(0,5,'#999')).shipments.length,0);
  assert.equal((await read(0,5,'kyiv')).shipments.length,5);
  await db.exec('reset role;set role anon');
  await assert.rejects(read(0,50),/permission denied/);
 }finally{await db.close()}
});
