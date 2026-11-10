const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
test('batch SQL paginates names, exact historical catalog names, and only open acts',async()=>{
 const db=new PGlite();try {
 await db.exec(`create role anon;create role authenticated;create table shops(shop_id bigint,data jsonb);create table details(detail_id bigint,data jsonb);create table sclad(sclad_id bigint,part_number text,name text,time_on date,shops text,kilkist_on numeric,price numeric,rahunok int,unit_measurement text,"scladNomer" numeric,xto_zamovuv bigint);create table slyusars(slyusar_id bigint,data jsonb);create table clients(client_id bigint,data jsonb);create table cars(cars_id bigint,data jsonb);create table acts(act_id bigint,date_off timestamptz,client_id bigint,cars_id bigint);
 create function sto_read_object_v1(v jsonb) returns jsonb language sql immutable as 'select v';
 create function traffic_catalog_key(v text) returns text language sql immutable as 'select lower(regexp_replace(v,''[^a-zA-Z0-9]'','''',''g''))';`);
 await db.exec(fs.readFileSync('supabase/migrations/20261005010000_traffic_detail_suggestions.sql','utf8'));
 await db.exec(fs.readFileSync('supabase/migrations/20261011030000_traffic_batch_suggestions.sql','utf8'));
 await db.exec(`insert into shops select i,jsonb_build_object('Name','Shop '||i) from generate_series(1,50)i;
 insert into sclad(sclad_id,part_number,name) select i,'0001','Name '||i from generate_series(1,25)i;insert into sclad(sclad_id,part_number,name) values(99,'0002','Unrelated');
 insert into clients values(1,'{"ПІБ":"Клієнт"}');insert into cars values(1,'{"Авто":"BMW","Номер авто":"AA0001"}');
 insert into acts values(1,null,1,1),(2,now(),1,1);`);
 const rpc=async(kind,q='',offset=0,exact=false)=>(await db.query('select traffic_batch_suggestions($1,$2,$3,$4) as p',[kind,q,offset,exact])).rows[0].p;
 const shops=await rpc('shops');assert.equal(shops.items.length,20);assert.equal(shops.has_more,true);
 const names=await rpc('catalogs','0001',20,true);assert.equal(names.items.length,5);assert.equal(names.has_more,false);assert.ok(names.items.every(x=>x.value==='0001'));
 const act=await rpc('acts','Клієнт');assert.equal(act.items.length,1);assert.equal(act.items[0].value,'1');assert.match(act.items[0].label,/BMW/);
 assert.equal((await rpc('acts','2',0,true)).items.length,0);
 const mapping=(await db.query("select traffic_invoice_catalogs(array['0001','absent'],0) as p")).rows[0].p;assert.equal(mapping.items.length,25);assert.ok(mapping.items.every(row=>row.catalog==='0001'));assert.equal(mapping.has_more,false);
 const position=(await db.query('select traffic_stock_position(99) as p')).rows[0].p;assert.equal(position.sclad_id,99);assert.equal(position.name,'Unrelated');assert.equal(position.detail_id,null);
 } finally {await db.close();}
});
