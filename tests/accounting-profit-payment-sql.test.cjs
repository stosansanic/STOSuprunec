const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
const sql=fs.readFileSync('supabase/migrations/20261021172813_accounting_profit_payment_scope.sql','utf8');
async function fixture(){
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;
 create table acts(act_id bigint primary key,client_id bigint,cars_id bigint,date_on timestamp,date_off timestamp,rosraxovano timestamp,xto_rozraxuvav text,avans numeric,"tupOplatu" text,data jsonb);
 create table vutratu(vutratu_id bigint primary key,"dataOnn" timestamp,"dataOff" timestamp,kategoria text,act bigint,opys_vytraty text,suma numeric,sposob_oplaty text,prymitky text,xto_zapusav text);
 create table slyusars(slyusar_id bigint primary key,data jsonb);create table clients(client_id bigint primary key,data jsonb);create table cars(cars_id bigint primary key,data jsonb);
 create function sto_read_object_v1(p_data jsonb) returns jsonb language sql immutable as $$select case when jsonb_typeof(p_data)='object' then p_data when jsonb_typeof(p_data)='string' then (p_data#>>'{}')::jsonb else '{}'::jsonb end$$;
 insert into acts select x,null,null,'2026-10-20','2026-10-20',null,null,0,'Готівка','{"За роботу":200,"За деталі":100,"Прибуток за роботу":100,"Прибуток за деталі":30,"Знижка":0}' from generate_series(1,3) x;
 insert into vutratu values(1,'2026-10-20',null,'Інше',null,'Expense',-10,'Готівка','', 'User');`);
 await db.exec(fs.readFileSync('supabase/migrations/20261015154335_traffic_profit_accounting_page.sql','utf8'));
 await db.exec(sql);
 const filter={from:'2026-10-01',to:'2026-10-21',mode:'open',payment:'2',type:'2',status:'2',discount:'2'};
 const read=async (limit=30)=>(await db.query('select traffic_profit_accounting_page($1,null,$2) v',[JSON.stringify(filter),limit])).rows[0].v;
 const pay=async(rows,stamp='2026-10-21T12:13:14',actor='Admin')=>(await db.query('select traffic_profit_payment_rows($1,$2,$3) v',[JSON.stringify(rows),stamp,actor])).rows[0].v;
 const capture=r=>({id:r.id,baseline:r.paymentBaseline,expected_paid:r.rosraxovanoDate,expected_actor:r.xto_rozraxuvav});
 return {db,read,pay,capture};
}
test('only explicit already fetched IDs are paid; compact receipt; same desired retry is harmless',async()=>{const f=await fixture();try{
 const page=await f.read(1);assert.equal(page.rows.length,1);assert.equal(page.has_more,true);
 const q=page.rows.map(f.capture),a=await f.pay(q),b=await f.pay(q);
 assert.equal(a.updated_count,1);assert.deepEqual(a,b);assert.ok(JSON.stringify(a).length<250);
 assert.equal((await f.db.query('select count(*)::int n from acts where rosraxovano is not null')).rows[0].n,0);
 assert.equal((await f.db.query('select count(*)::int n from vutratu where "dataOff" is not null')).rows[0].n,1);
}finally{await f.db.close();}});
test('financial change rejects whole mixed batch and preserves paid flags',async()=>{const f=await fixture();try{
 const page=await f.read();await f.db.exec(`update acts set data=jsonb_set(data,'{За роботу}','999') where act_id=2`);
 await assert.rejects(f.pay(page.rows.map(f.capture)),/ACCOUNTING_PAYMENT_STALE/);
 assert.equal((await f.db.query('select count(*)::int n from acts where rosraxovano is not null')).rows[0].n,0);
 assert.equal((await f.db.query('select count(*)::int n from vutratu where "dataOff" is not null')).rows[0].n,0);
}finally{await f.db.close();}});
test('paid status conflict preserves other persons calculation',async()=>{const f=await fixture();try{
 const q=(await f.read()).rows.filter(r=>r.id===-1).map(f.capture);
 await f.db.exec(`update acts set rosraxovano='2026-10-21 10:00',xto_rozraxuvav='Other' where act_id=1`);
 await assert.rejects(f.pay(q),/ACCOUNTING_PAYMENT_STALE/);
 assert.equal((await f.db.query('select xto_rozraxuvav from acts where act_id=1')).rows[0].xto_rozraxuvav,'Other');
}finally{await f.db.close();}});
test('cancel and repeated cancel affect only captured act, without modifying JSON',async()=>{const f=await fixture();try{
 const q=(await f.read()).rows.filter(r=>r.id===-1).map(f.capture);await f.pay(q);
 const next=(await f.read()).rows.filter(r=>r.id===-1).map(f.capture);
 const before=(await f.db.query('select data from acts where act_id=1')).rows[0].data;
 const a=await f.pay(next,null),b=await f.pay(next,null);assert.deepEqual(a,b);
 const r=(await f.db.query('select * from acts where act_id=1')).rows[0];assert.equal(r.rosraxovano,null);assert.deepEqual(r.data,before);
}finally{await f.db.close();}});
test('ambiguous IDs, missing row, and omitted financial baseline fail closed',async()=>{const f=await fixture();try{
 const q=(await f.read()).rows.filter(r=>r.id===-1).map(f.capture);
 await assert.rejects(f.pay([q[0],q[0]]),/Duplicate/);
 await assert.rejects(f.pay([{...q[0],id:-555}]),/STALE/);
 await assert.rejects(f.pay([{...q[0],baseline:undefined}]),/Invalid/);
 await assert.rejects(f.pay([{...q[0],expected_paid:undefined}]),/Invalid/);
}finally{await f.db.close();}});
test('receiver payroll change invalidates confirmed profit',async()=>{const f=await fixture();try{
 const q=(await f.read()).rows.filter(r=>r.id===-1).map(f.capture);
 await f.db.exec(`insert into slyusars values(10,'{"Доступ":"Приймальник","Історія":{"2026-10-20":[{"Акт":1,"ЗарплатаРоботи":15}]}}')`);
 await assert.rejects(f.pay(q),/STALE/);
}finally{await f.db.close();}});
test('RLS denial of a selected write rolls back the whole operation',async()=>{const f=await fixture();try{
 const q=(await f.read()).rows.filter(r=>r.id<0).map(f.capture);
 await f.db.exec(`grant usage on schema public to authenticated;grant select,update on acts,vutratu to authenticated;grant select on slyusars,clients,cars to authenticated;
 alter table acts enable row level security;create policy read_acts on acts for select to authenticated using(true);
 create policy write_some on acts for update to authenticated using(act_id<>2) with check(act_id<>2);set role authenticated;`);
 await assert.rejects(f.pay(q),/not permitted/);await f.db.exec('reset role');
 assert.equal((await f.db.query('select count(*)::int n from acts where rosraxovano is not null')).rows[0].n,0);
}finally{await f.db.close();}});
test('migration is repeatable and bounded financial rows exclude nonselected records',async()=>{const f=await fixture();try{
 await f.db.exec(sql);
 const r=await f.db.query(`select r->>'id' id from traffic_profit_accounting_rows('{"from":"2026-10-01","to":"2026-10-21","payment_ids":[-2]}') r`);
 assert.deepEqual(r.rows,[{id:'-2'}]);
}finally{await f.db.close();}});
test('legacy text date and paid columns keep day filtering, CAS and replay compatible',async()=>{const f=await fixture();try{
 await f.db.exec(`alter table acts alter column date_on type text,alter column date_off type text,alter column rosraxovano type text;
 alter table vutratu alter column "dataOnn" type text,alter column "dataOff" type text;`);
 const q=(await f.read()).rows.map(f.capture),a=await f.pay(q),b=await f.pay(q);
 assert.equal(a.updated_count,4);assert.deepEqual(a,b);
 const next=(await f.read()).rows.filter(r=>r.id===-1).map(f.capture);await f.pay(next,null);
 assert.equal((await f.db.query('select rosraxovano from acts where act_id=1')).rows[0].rosraxovano,null);
}finally{await f.db.close();}});
test('timestamp with timezone and date-only paid columns preserve Kyiv date and retries',async()=>{const f=await fixture();try{
 await f.db.exec(`alter table acts alter column rosraxovano type timestamptz using rosraxovano at time zone 'Europe/Kyiv';
 alter table vutratu alter column "dataOff" type date;set timezone='UTC';`);
 const q=(await f.read()).rows.map(f.capture),a=await f.pay(q,'2026-10-21T00:30:00'),b=await f.pay(q,'2026-10-21T00:30:00');
 assert.deepEqual(a,b);assert.equal(a.rows.find(r=>r.id===1).paid_at,'2026-10-21T00:00:00.000000');
 assert.equal((await f.db.query("select to_char(rosraxovano at time zone 'Europe/Kyiv','YYYY-MM-DD HH24:MI') v from acts where act_id=1")).rows[0].v,'2026-10-21 00:30');
}finally{await f.db.close();}});
test('legacy empty text unpaid date and empty actor are valid exact baselines',async()=>{const f=await fixture();try{
 await f.db.exec(`alter table acts alter column rosraxovano type text;
 alter table vutratu alter column "dataOff" type text;
 update acts set rosraxovano='',xto_rozraxuvav='';update vutratu set "dataOff"='',xto_zapusav='';`);
 const q=(await f.read()).rows.map(f.capture);
 assert.ok(q.every(r=>r.expected_paid===''&&r.expected_actor===''));
 const a=await f.pay(q),b=await f.pay(q);assert.equal(a.updated_count,4);assert.deepEqual(a,b);
}finally{await f.db.close();}});
test('explicit act lock keeps the primary key index usable',async()=>{const f=await fixture();try{
 const lock=sql.match(/perform act_id from public\.acts where[^;]+for update;/)[0];
 assert.ok(!lock.includes('where -act_id'));
 const statement=lock.replace(/^perform /,'select ').replace('unnest(captured)','unnest(array[-2,1]::bigint[])');
 await f.db.exec('set enable_seqscan=off');
 const explanation=(await f.db.query('explain (format json) '+statement)).rows[0]['QUERY PLAN'];
 assert.match(JSON.stringify(explanation),/acts_pkey/);
 assert.match(JSON.stringify(explanation),/Index (Only )?Scan/);
}finally{await f.db.close();}});
