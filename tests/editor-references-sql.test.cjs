const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
test('editor uses bounded candidates and exact IDs even beyond first 1000; voice queries stock without full read',async()=>{
 const db=new PGlite();try{
 await db.exec('create role anon;create role authenticated;create table acts(act_id bigint,data jsonb);create table works(work_id integer,data text);create table details(detail_id integer,data text);create table shops(shop_id integer,data jsonb);create table sclad(sclad_id bigint,name text,part_number text);');
 await db.exec("create function sto_read_object_v1(v jsonb) returns jsonb language sql immutable as $$select case when jsonb_typeof(v)='object' then v else '{}'::jsonb end$$");
 const helper=fs.readFileSync('supabase/migrations/20261005010000_traffic_detail_suggestions.sql','utf8');await db.exec(helper.slice(0,helper.indexOf('create or replace function public.traffic_detail_suggestions')));
 await db.exec(fs.readFileSync('supabase/migrations/20261011100000_traffic_editor_references.sql','utf8'));
 await db.exec("insert into works select n,'Заміна '||n from generate_series(1,1200)n;insert into details select n,'Болт '||n from generate_series(1,1200)n;insert into sclad values(1500,'Фільтр масляний','AB12');insert into shops values(1,'{\"Name\":\"Постачальник\"}');");
 await db.exec("insert into acts values(1,'{\"Деталі\":[{\"sclad_id\":1500,\"Кількість\":\"3,5\",\"Деталь\":\"Private name\"}],\"Photos\":\"large\"}');");
 const qty=(await db.query('select traffic_editor_act_quantities(1) v')).rows[0].v;assert.deepEqual(qty.Деталі,[{sclad_id:1500,Кількість:'3,5'}]);assert.equal(qty.Photos,undefined);
 await db.exec(`insert into acts values(2,'{"Деталі":{"bad":true}}'),(3,'{}'),(4,'{"Деталі":null}');`);
 await assert.rejects(db.query('select traffic_editor_act_quantities(2)'),/Некоректний список/);
 assert.deepEqual((await db.query('select traffic_editor_act_quantities(3) v')).rows[0].v.Деталі,[]);
 assert.deepEqual((await db.query('select traffic_editor_act_quantities(4) v')).rows[0].v.Деталі,[]);
 const read=async(q='',names=[],works=[],details=[],voice=false)=>(await db.query('select traffic_editor_references($1,$2,$3,$4,$5) v',[q,names,works,details,voice])).rows[0].v;
 assert.equal((await read('болт')).length,50);assert.equal((await read('заміна')).length,50);
 const exact=await read('',[],['1199'],[1200]);assert.deepEqual(exact.map(x=>x.id).sort(),['1199','1200']);
 assert.equal((await read('', ['Болт 1200']))[0].id,'1200');assert.equal((await read())[0].kind,'shop');
 assert.equal((await read('додай фільтр масляний 2 штуки',[],[],[],true)).find(x=>x.kind==='stock').id,'1500');
 await db.exec("alter table works alter column data type jsonb using to_jsonb(data);alter table details alter column data type jsonb using to_jsonb(data);insert into details values(1300,'{\"Назва\":\"Legacy part\"}');");assert.equal((await read('', ['Болт 1200']))[0].name,'Болт 1200');assert.equal((await read('', ['Legacy part']))[0].id,'1300');assert.equal((await read('',[],['1199']))[0].name,'Заміна 1199');
 await db.exec('grant select on works,details,shops,sclad to authenticated;alter table details enable row level security;create policy scope on details to authenticated using(detail_id=1200);set role authenticated');
 assert.equal((await read('Болт')).length,1);
 }finally{await db.close()}
});
