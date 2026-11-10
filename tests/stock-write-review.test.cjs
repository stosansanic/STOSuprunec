const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
const sql=name=>fs.readFileSync('supabase/migrations/'+name,'utf8');

test('reference resolver preserves legacy JSON names and rolls back denied RLS writes',async()=>{
 const db=new PGlite();try {
  await db.exec(`create role anon;create role authenticated;
   create table shops(shop_id bigint primary key,data text);
   create table details(detail_id bigint primary key,data jsonb);
   insert into shops values(1,'{"Name":"Legacy shop","Склад":{"keep":1}}');
   insert into details values(1,'{"Назва":"Legacy part","keep":1}');
   grant select,insert,update on shops,details to authenticated;
   alter table details enable row level security;
   create policy visible on details for select to authenticated using(true);
   create policy writable on details for insert to authenticated with check(detail_id<3);
   create policy editable on details for update to authenticated using(true);`);
  await db.exec(sql('20261005010000_traffic_detail_suggestions.sql'));
  await db.exec(sql('20261011040000_stock_reference_resolve.sql'));
  await db.exec('set role authenticated');
  const rpc=async items=>(await db.query('select stock_resolve_references($1::jsonb) r',[JSON.stringify(items)])).rows[0].r;
  const rows=await rpc([{key:'s',kind:'shops',name:'Legacy shop'},{key:'d',kind:'details',name:'Legacy part'}]);
  assert.deepEqual(rows.map(x=>x.id),[1,1]);
  assert.equal(JSON.parse((await db.query('select data from shops')).rows[0].data)['Склад'].keep,1);
  await assert.rejects(rpc([{key:'a',kind:'details',name:'Allowed'},{key:'b',kind:'details',name:'Denied'}]),/row-level security/);
  assert.equal((await db.query('select count(*)::int n from details')).rows[0].n,1);
 }finally{await db.close();}
});

test('invoice RPC and direct guard retain caller RLS and roll back rejected writes',async()=>{
 const db=new PGlite();try {
  await db.exec(`create role anon;create role authenticated;
   create table sclad(sclad_id bigserial primary key,time_on date,shops text,part_number text,name text,kilkist_on numeric,kilkist_off numeric,price numeric,rahunok text,unit_measurement text,akt bigint,"scladNomer" numeric,xto_zamovuv bigint,statys text,prumitka text,client_price numeric);
   grant select,insert,update on sclad to authenticated;
   grant usage on sequence sclad_sclad_id_seq to authenticated;
   alter table sclad enable row level security;
   create policy visible on sclad for select to authenticated using(true);
   create policy writable on sclad for insert to authenticated with check(shops='Allowed');
   create policy editable on sclad for update to authenticated using(true);`);
  await db.exec(sql('20261011050000_stock_invoice_idempotency.sql'));
  await db.exec('set role authenticated');
  const rpc=async row=>(await db.query('select stock_insert_invoice($1::jsonb) r',[JSON.stringify(row)])).rows[0].r;
  const row={time_on:'2026-10-11',shops:'Denied',part_number:'001',name:'Part',kilkist_on:1,price:10,prumitka:'[atlas-invoice:'+'b'.repeat(64)+':1]'};
  await assert.rejects(rpc(row),/row-level security/);
  assert.equal((await db.query('select count(*)::int n from sclad')).rows[0].n,0);
  const created=await rpc({...row,shops:'Allowed'});
  assert.equal((await rpc({...row,shops:'Allowed'})).sclad_id,created.sclad_id);
 }finally{await db.close();}
});
