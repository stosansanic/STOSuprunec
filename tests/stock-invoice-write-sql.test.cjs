const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
test('invoice receipt retry returns same ID, preserves consumption, and blocks duplicate direct inserts',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create table sclad(sclad_id bigserial primary key,time_on date not null,shops text,part_number text,name text,kilkist_on numeric not null default 0,kilkist_off numeric not null default 0,price numeric,rahunok int4,unit_measurement text,akt int4,"scladNomer" numeric,xto_zamovuv int8,statys text,prumitka text,client_price numeric);`);
 await db.exec(fs.readFileSync('supabase/migrations/20261011050000_stock_invoice_idempotency.sql','utf8'));
 const marker='[atlas-invoice:'+'a'.repeat(64)+':1]';const row={time_on:'2026-10-11',shops:'Shop',part_number:'001',name:'Part',kilkist_on:12,kilkist_off:0,price:10,rahunok:1,unit_measurement:'шт',prumitka:marker,client_price:null};
 const rpc=async payload=>(await db.query('select stock_insert_invoice($1::jsonb) as r',[JSON.stringify(payload)])).rows[0].r;
 const first=await rpc(row);assert.equal(first.status,'created');await db.exec('update sclad set kilkist_off=6');
 const again=await rpc(row);assert.equal(again.sclad_id,first.sclad_id);assert.equal(again.status,'existing');assert.equal((await db.query('select kilkist_off::int as n from sclad')).rows[0].n,6);
 await assert.rejects(rpc({...row,price:11}),/changed data/);
 await assert.rejects(db.query('insert into sclad(time_on,prumitka)values($1,$2)',['2026-10-11',marker]),/already received/);
 await assert.rejects(db.exec("update sclad set prumitka=''"),/cannot be removed/);
 await db.query('insert into sclad(time_on,part_number,name) values($1,$2,$3),($1,$2,$3)',['2026-10-11','001','Part']);
 assert.equal((await db.query('select count(*)::int as n from sclad')).rows[0].n,3);
 const pair=await Promise.all([rpc({...row,prumitka:marker.replace(':1]',':2]')}),rpc({...row,prumitka:marker.replace(':1]',':2]')})]);assert.equal(pair[0].sclad_id,pair[1].sclad_id);
 }finally{await db.close();}
});
