const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
test('financial aggregate includes beyond 5000 acts, expense schema, boundaries and RLS',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create table acts(act_id int primary key,date_on timestamptz,data jsonb,client_id int default 1,date_off timestamptz);create table slyusars(slyusar_id int primary key,data jsonb);create table vutratu(vutratu_id int primary key,"dataOnn" timestamp,suma numeric);`);
 // Helper reproduces scalar/array String coercion; imported separately from the search contract.
 const sql=fs.readFileSync('supabase/migrations/20261011040000_traffic_act_search.sql','utf8');
 const a=sql.indexOf('create or replace function public.traffic_search_truthy(');const b=sql.indexOf('create or replace function public.traffic_search_number(');
 await db.exec(sql.slice(a,b));
 const ta=sql.indexOf("create or replace function public.traffic_search_trim("),tb=sql.indexOf("create or replace function",ta+30);await db.exec(sql.slice(ta,tb));
 await db.exec(fs.readFileSync('supabase/migrations/20261011110000_traffic_ai_financial.sql','utf8'));
 await db.exec(fs.readFileSync('supabase/migrations/20261011140000_traffic_ai_workload.sql','utf8'));
 await db.exec('alter table acts add column cars_id int');
 await db.exec(fs.readFileSync('supabase/migrations/20261011160000_traffic_ai_closed_acts.sql','utf8'));
 await db.exec(`insert into acts(act_id,date_on,date_off,data) values(8000,'2026-01-01','2026-01-02','{"Роботи":[{"Робота":"Oil","Ціна":123}],"Секрет":true}')`);
 const narrow=(await db.query("select traffic_ai_closed_act_page('maintenance',0) v")).rows[0].v;assert.equal(narrow.items[0].data.Секрет,undefined);assert.equal(narrow.items[0].data.Роботи[0].Ціна,undefined);assert.equal(narrow.items[0].data.Роботи[0].Робота,'Oil');
 await db.exec('delete from acts where act_id=8000');
 await db.exec(`insert into acts(act_id,date_on,data) select n,'2026-10-10T00:00:00Z','{"СумаРобіт":"10.5 грн","СумаДеталей":2}'::jsonb from generate_series(1,5005)n;insert into acts(act_id,date_on,data) values(6000,'2026-09-30','{"СумаРобіт":-2.5}'),(6001,'2026-09-29','{"СумаРобіт":999}');insert into vutratu values(1,'2026-10-10',3),(2,'2026-09-30 12:00:00',4);`);
 for(const value of [' -2.5 грн','1e2abc','0x10','foo','\u00a0+3.25',[1,2],true,null,'1e-999','-1e-999','1e-324','5e-324','1e-999999','1e+','12,50','\uFEFF-2.5 грн']) {const parsed=(await db.query('select traffic_ai_parse_float($1::jsonb) v',[JSON.stringify(value)])).rows[0].v;assert.equal(parsed,parseFloat(value)||0,JSON.stringify(value))}
 await assert.rejects(db.query('select traffic_ai_parse_float($1::jsonb)',[JSON.stringify('1e999')]),/out of range/);
 await db.exec("insert into slyusars values(1,'{\"Name\":\"Test\",\"Історія\":{\"secret\":true}}');update acts set data=data||'{\"Слюсар\":\"Test\"}'::jsonb");
 const staff=(await db.query("select traffic_ai_staff_ranking('2026-10-01',null) v")).rows[0].v;
 assert.equal(staff.items[0].__stats.acts,5005);assert.equal(staff.items[0].data.Історія,undefined);
 const workload=(await db.query("select traffic_ai_workload('2026-10-01','Europe/Kyiv') v")).rows[0].v;
 assert.equal(workload.total,5005);assert.equal(workload.days[0].dates,1);assert.equal(workload.hours[0].hour,3);
 await db.exec(`insert into acts(act_id,date_on,data) values(7000,'2026-10-10T21:30:00Z','{"Загальна сума":"-2.5 грн"}')`);
 const late=(await db.query("select traffic_ai_workload('2026-10-10T21:00:00Z','Europe/Kyiv') v")).rows[0].v;
 assert.equal(late.days[0].dow,0);assert.equal(late.days[0].revenue,-2.5);assert.equal(late.hours[0].hour,0);
 await db.exec('delete from acts where act_id=7000');
 const get=async()=> (await db.query(`select traffic_ai_financial('2026-10-01','2026-09-30') v`)).rows[0].v;
 const result=await get();assert.equal(result.current.acts_count,5005);assert.equal(result.current.revenue,5005*12.5);assert.equal(result.current.expenses,3);assert.equal(result.previous.revenue,-2.5);assert.equal(result.previous.expenses,4);
 const vip=(await db.query("select traffic_ai_vip('2026-10-01',20) v")).rows[0].v;assert.equal(vip.items[0][1].acts,5005);assert.equal(vip.items[0][1].revenue,5005*12.5);
 await db.exec(`alter table acts enable row level security;alter table vutratu enable row level security;grant select on acts,vutratu to authenticated;create policy visible_acts on acts for select to authenticated using(act_id=1);create policy visible_expenses on vutratu for select to authenticated using(vutratu_id=1);set role authenticated;`);
 const visibleWorkload=(await db.query("select traffic_ai_workload('2026-10-01','Europe/Kyiv') v")).rows[0].v;assert.equal(visibleWorkload.total,1);
 const restricted=await get();assert.equal(restricted.current.acts_count,1);assert.equal(restricted.current.revenue,12.5);assert.equal(restricted.previous.expenses,0);
 await db.exec('reset role;alter table vutratu rename column "dataOnn" to data_vutratu;alter table vutratu alter column data_vutratu type timestamptz using data_vutratu at time zone \'Europe/Kyiv\';insert into vutratu values(3,null,99999)');
 const legacy=await get();assert.equal(legacy.current.expenses,3);assert.equal(legacy.previous.expenses,4);
 }finally{await db.close()}
});

test('stock alerts filter before paging and preserve thresholds',async()=>{
 const db=new PGlite();try{
 await db.exec('create role anon;create role authenticated;create table sclad(sclad_id int primary key,name text,part_number text,shops text,kilkist_on text,kilkist_off text,prumitka text)');
 const sql=fs.readFileSync('supabase/migrations/20261011040000_traffic_act_search.sql','utf8');
 await db.exec(sql.slice(sql.indexOf('create or replace function public.traffic_search_truthy('),sql.indexOf('create or replace function public.traffic_search_trim(')));
 await db.exec(fs.readFileSync('supabase/migrations/20261011150000_traffic_ai_stock_alerts.sql','utf8'));
 await db.exec(`insert into sclad select n,'healthy',null,null,'100','0',null from generate_series(1,1100)n;insert into sclad select n,'alert',null,null,'2','1','мін:2' from generate_series(2000,2204)n;insert into sclad values(3000,'zero',null,null,'bad',null,null)`);
 const get=async offset=>(await db.query('select traffic_ai_stock_alerts(2,$1) v',[offset])).rows[0].v;
 const a=await get(0),b=await get(200);assert.equal(a.total_stock,1306);assert.equal(a.total_alerts,206);assert.equal(a.items.length,200);assert.equal(a.has_more,true);assert.equal(b.items.length,6);assert.equal(b.has_more,false);assert.equal(b.items.at(-1).current_qty,0);assert.equal(a.items[0].threshold,2);assert.equal(a.items[0].prumitka,undefined);
 }finally{await db.close()}
});

test('workload keeps local hours for actual timestamp-without-timezone schema',async()=>{
 const db=new PGlite();try{
 await db.exec('create role anon;create role authenticated;create table acts(act_id int,date_on timestamp,data jsonb)');
 await db.exec('create function traffic_ai_parse_float(jsonb) returns double precision language sql immutable as $$select 0::double precision$$');
 await db.exec(fs.readFileSync('supabase/migrations/20261011140000_traffic_ai_workload.sql','utf8'));
 await db.exec(`insert into acts values(1,'2026-10-11 00:30:00','{}'),(2,'2026-10-11 04:00:00','{}')`);
 const v=(await db.query("select traffic_ai_workload('2026-10-10T21:00:00Z','Europe/Kyiv') v")).rows[0].v;
 assert.equal(v.total,2);assert.equal(v.days[0].dow,0);assert.equal(v.days[0].dates,2);assert.deepEqual(v.hours.map(h=>h.hour),[0,4]);
 }finally{await db.close()}
});
