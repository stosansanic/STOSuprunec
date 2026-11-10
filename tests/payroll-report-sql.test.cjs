const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
async function setup(){const db=new PGlite();await db.exec('create role anon;create role authenticated;create table acts(act_id bigint primary key,data jsonb,date_off timestamp);create table slyusars(slyusar_id bigint primary key,data jsonb);');
 await db.exec(fs.readFileSync('supabase/migrations/20261011080000_traffic_payroll_json.sql','utf8'));
 const helpers=fs.readFileSync('supabase/migrations/20261011040000_traffic_act_search.sql','utf8');await db.exec(helpers.slice(0,helpers.indexOf('create or replace function public.traffic_act_search_match'))+'commit;');
 await db.exec(fs.readFileSync('supabase/migrations/20261011130000_traffic_payroll_report.sql','utf8'));return db;}
test('payroll report filters period/paid/status, preserves original work indices and global totals beyond page',async()=>{
 const db=await setup();try{
  await db.exec("insert into acts select i,'{}',case when i%2=0 then timestamp '2026-10-02' else null end from generate_series(1,1005)i");
  const history={'2026-10-01':Array.from({length:1005},(_,i)=>({Акт:String(i+1),ДатаЗакриття:'stale',Записи:[{recordId:'zero'+i,Робота:'Zero',Кількість:0,Зарплата:0},{recordId:'work'+i,Робота:'Work',Кількість:2,Ціна:100,Зарплата:30,...(i%2?{Розраховано:'03.10.2026'}:{})}]}))};
  await db.query('insert into slyusars values(1,$1)',[JSON.stringify({Name:'Worker',ПроцентРоботи:20,Історія:history,password:'secret'})]);
  const read=async(filters={},offset=0)=>(await db.query('select traffic_payroll_report($1::jsonb,$2) r',[JSON.stringify({from:'2026-10-01',to:'2026-10-11',mode:'open',...filters}),offset])).rows[0].r;
  const first=await read();assert.equal(first.total,1005);assert.equal(first.keys.length,50);assert.equal(first.salary,30150);assert.equal(first.revenue,201000);assert.equal(first.keys[0][2],'1005');assert.equal(first.keys[0][3],1);assert.equal(first.employees[0].data.password,undefined);assert.equal(first.employees[0].data.Історія['2026-10-01'].length,50);
  assert.equal((await read({mode:'paid'})).total,502);assert.equal((await read({mode:'close'})).total,502);assert.equal((await read({status:'open'})).total,503);assert.equal((await read({payment:'unpaid'})).total,503);assert.equal((await read({percentage:'lower'})).total,1005);assert.equal((await read({percentage:'higher'})).total,0);
  const ids=[];for(let offset=0;offset<1005;offset+=50)ids.push(...(await read({},offset)).keys.map(k=>k[2]));assert.equal(new Set(ids).size,1005);assert.equal(ids.at(-1),'1');
  await db.exec("update acts set data='{\"Заморожений\":true}' where act_id=1005");assert.equal((await read()).total,1004);
 }finally{await db.close();}
});
test('report retains legacy missing-act dates, receiver negative margins and detects duplicates outside period',async()=>{
 const db=await setup();try{
  const entries=[{Акт:'10',СуммаРоботи:100,СуммаЗапчастин:-50,ЗарплатаРоботи:20,ЗарплатаЗапчастин:5,ДатаЗакриття:'03.10.26'},{Акт:'11',СуммаЗапчастин:-100,ЗарплатаЗапчастин:50,Розраховано:'💰 02.10.2026'}];
  await db.query('insert into slyusars values(1,$1)',[JSON.stringify({Name:'Receiver',Історія:{'01.10.2026':entries}})]);
  const read=async mode=>(await db.query('select traffic_payroll_report($1::jsonb) r',[JSON.stringify({from:'01.10.26',to:'11.10.26',mode})])).rows[0].r;
  const page=await read('open');assert.equal(page.total,2);assert.equal(page.revenue,-50);assert.equal(page.salary,25);assert.equal(page.statuses.length,0);assert.equal((await read('close')).total,1);assert.equal((await read('paid')).total,1);
  await db.query("update slyusars set data=jsonb_set(data,'{Історія,1926-01-01}',$1)",[JSON.stringify([entries[0]])]);await assert.rejects(read('open'),/Дублікати/);
 }finally{await db.close();}
});

test('report respects caller RLS, legacy TEXT JSON and retains pending accruals without exposing credentials',async()=>{
 const db=await setup();try{
  await db.exec('alter table slyusars alter column data type text using data::text;alter table acts alter column data type text using data::text;');
  const doc=id=>({Name:'Worker'+id,password:'hidden',Історія:{'2026-10-01':[{Акт:String(id),Записи:[{Робота:'Work',Ціна:100,Кількість:1,Зарплата:20}]}]}});
  await db.query('insert into slyusars values(1,$1),(2,$2)',[JSON.stringify(doc(1)),JSON.stringify(doc(2))]);
  await db.query('insert into acts values(1,$1,null),(2,$1,null)',[JSON.stringify({__payroll_pending:true})]);
  await db.exec('alter table slyusars enable row level security;alter table acts enable row level security;create policy employee_read on slyusars for select to authenticated using(slyusar_id=1);create policy act_read on acts for select to authenticated using(act_id=1);grant select on slyusars,acts to authenticated;set role authenticated;');
  const {rows}=await db.query('select traffic_payroll_report($1::jsonb) r',[JSON.stringify({from:'2026-10-01',to:'2026-10-11'})]);
  assert.equal(rows[0].r.total,1);assert.equal(rows[0].r.statuses[0].payrollPending,true);assert.equal(rows[0].r.employees[0].data.password,undefined);
 }finally{await db.close();}
});
