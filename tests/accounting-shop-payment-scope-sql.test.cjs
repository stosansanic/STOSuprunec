const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
const sql=fs.readFileSync('supabase/migrations/20261021172731_accounting_shop_payment_scope.sql','utf8');
const shopSource=fs.readFileSync('supabase/migrations/20261011120000_traffic_shop_report_page.sql','utf8');
const stockSource=fs.readFileSync('supabase/migrations/20261015154333_traffic_stock_accounting_page.sql','utf8');
const daySql=shopSource.slice(shopSource.indexOf('create or replace function public.traffic_shop_date'),shopSource.indexOf('create or replace function public.traffic_shop_report_page'));
const stockRowsSql=stockSource.slice(stockSource.indexOf('create or replace function public.traffic_stock_accounting_rows'),stockSource.indexOf('create or replace function public.traffic_stock_accounting_page('));
async function fixture(type='jsonb',paidType='date') {
 const db=new PGlite(); await db.exec(`create role anon;create role authenticated;
 create table shops(shop_id bigint primary key,data ${type});
 create table acts(act_id bigint primary key,date_off timestamp,data jsonb);
 create table slyusars(slyusar_id bigint primary key,data jsonb);
 create table sclad(sclad_id bigint primary key,time_on timestamp,shops text,rahunok text,akt bigint,name text,part_number text,kilkist_on numeric,kilkist_off numeric,price numeric,rosraxovano ${paidType},povernennya timestamp,xto_povernyv text,"scladNomer" integer,xto_zamovuv bigint);
 create function sto_read_object_v1(p jsonb) returns jsonb language sql immutable as $$select case when jsonb_typeof(p)='string' then (p#>>'{}')::jsonb else coalesce(p,'{}') end$$;
 create function traffic_json_object(p jsonb) returns jsonb language sql immutable as $$select sto_read_object_v1(p)$$;
 create function traffic_search_truthy(p jsonb) returns boolean language sql immutable as $$select p is not null and p not in ('null','false','""','0')$$;
 create function traffic_search_number(p jsonb) returns numeric language sql immutable as $$select case when p is null or p='null' then null else (p#>>'{}')::numeric end$$;`);
 await db.exec(daySql+stockRowsSql+sql);
 const detail={recordId:'a',sclad_id:1,Найменування:'Part A',Каталог:1,Ціна:50,Кількість:1};
 const body={Name:'Shop',private:'keep',Історія:{'2026-10-20':[{Акт:10,Деталі:[detail,{...detail,recordId:'b',Найменування:'Part B'}],Розрахунок:'2026-10-19',Клієнт:'Keep'}],old:[{Акт:99,Деталі:[]}]}};
 await db.query('insert into shops values(1,$1)',[type==='text'?JSON.stringify(body):JSON.stringify(body)]);
 await db.exec(`insert into acts values(10,null,'{}');insert into sclad(sclad_id,time_on,shops,name,kilkist_on,kilkist_off,price) values(1,'2026-10-20','Shop','Part A',1,0,30),(2,'2026-10-20','Shop','Part B',2,0,10);`);
 const filter={from:'2026-10-01',to:'2026-10-21',dateMode:'open',payment:'all',status:'all'};
 const query=async(q,args=[])=>(await db.query(q,args)).rows[0].v;
 const report=async()=>query('select traffic_shop_report_page($1,0,20) v',[JSON.stringify(filter)]);
 const getBody=async()=>query('select sto_read_object_v1(to_jsonb(data)) v from shops where shop_id=1');
 const detailChange=async(index=0,desired=null)=>{const row=(await report()).items[index];return {shopId:row.shopId,date:row.dateOpen,act:row.act,entryOrdinal:row.entryOrdinal,detailOrdinal:row.detailOrdinal,fingerprint:row.paymentFingerprint,expected:row.paymentDate||null,desired};};
 const stockChange=async(id=1,desired='2026-10-21')=>query(`select jsonb_build_object('id',sclad_id,'fingerprint',traffic_stock_payment_fingerprint(to_jsonb(s)),'expected',rosraxovano,'desired',$2::text) v from sclad s where sclad_id=$1`,[id,desired]);
 return {db,body,report,getBody,detailChange,stockChange,query,
  payDetails: changes=>query('select write_shop_detail_payments($1) v',[JSON.stringify(changes)]),
  payStock: changes=>query('select write_stock_payment_rows($1) v',[JSON.stringify(changes)]),
  writeHistory: changes=>query('select write_shop_history_fragments(1,$1) v',[JSON.stringify(changes)])};
}
test('a clicked detail overrides legacy paid act without changing its sibling, history or stock',async()=>{const f=await fixture();try{
 const c=await f.detailChange();await f.payDetails([c]);const b=await f.getBody();
 assert.equal(b.Історія['2026-10-20'][0].Деталі[0].Розраховано,null);assert.equal(b.Історія['2026-10-20'][0].Розрахунок,'2026-10-19');
 assert.equal((await f.report()).items[0].isPaid,false);assert.equal((await f.report()).items[1].isPaid,true);
 assert.equal(b.private,'keep');assert.deepEqual(b.Історія.old,f.body.Історія.old);await f.payDetails([c]);
 const next=await f.detailChange(0,'2026-10-21');await f.payDetails([next]);await f.payDetails([next]);assert.equal((await f.report()).items[0].paymentDate,'2026-10-21');
}finally{await f.db.close();}});
test('detail stale quantity, moved rows, duplicate targets and inaccessible shop abort the whole batch',async()=>{const f=await fixture();try{
 const c=await f.detailChange(),other=await f.detailChange(1);await assert.rejects(f.payDetails([c,c]),/повторні/);
 await assert.rejects(f.payDetails([c,{...other,shopId:999}]),/недоступний/);assert.equal((await f.report()).items[0].isPaid,true);
 await f.db.exec(`update shops set data=jsonb_set(data,'{Історія,2026-10-20,0,Деталі,1,Кількість}','9')`);
 await assert.rejects(f.payDetails([c,other]),/Деталь змінено/);assert.equal((await f.report()).items[0].isPaid,true);
 await assert.rejects(f.payDetails([{...c,act:'999'}]),/переміщено/);
}finally{await f.db.close();}});
test('stock explicit ids pay one row, retry once, reject stale price and never touch unseen rows',async()=>{const f=await fixture();try{
 const c=await f.stockChange();await f.payStock([c]);await f.payStock([c]);
 assert.equal(await f.query('select rosraxovano::text v from sclad where sclad_id=1'),'2026-10-21');assert.equal(await f.query('select rosraxovano v from sclad where sclad_id=2'),null);
 const undo=await f.stockChange(1,null);await f.payStock([undo]);const second=await f.stockChange(2);await f.db.exec('update sclad set price=99 where sclad_id=2');
 await assert.rejects(f.payStock([c,second]),/Позицію змінено/);assert.equal(await f.query('select rosraxovano v from sclad where sclad_id=1'),null);
 await assert.rejects(f.payStock([c,c]),/повторні/);await assert.rejects(f.payStock([c,{...second,id:999}]),/недоступна/);
}finally{await f.db.close();}});
test('stock report adds only a small matching fingerprint and requires period',async()=>{const f=await fixture();try{
 const page=await f.query('select traffic_stock_accounting_page($1) v',[JSON.stringify({from:'2026-10-01',to:'2026-10-21'})]);
 assert.equal(page.items.length,2);assert.equal(page.items[0].paymentFingerprint,(await f.stockChange(2)).fingerprint);
 await assert.rejects(f.query("select traffic_shop_report_page('{}') v"),/період/);
}finally{await f.db.close();}});
for(const type of ['jsonb','text'])test(`history write preserves concurrent individual payment (${type}), rejects stale non-payment fields`,async()=>{const f=await fixture(type);try{
 const before=structuredClone(f.body.Історія['2026-10-20'][0]);const desired=structuredClone(before);desired.Деталі[0].Ціна=60;
 await f.payDetails([await f.detailChange()]);await f.writeHistory([{date:'2026-10-20',act:'10',expected:before,desired}]);
 let b=await f.getBody();assert.equal(b.Історія['2026-10-20'][0].Деталі[0].Розраховано,null);assert.equal(b.Історія['2026-10-20'][0].Деталі[0].Ціна,60);assert.equal(b.private,'keep');
 await assert.rejects(f.writeHistory([{date:'2026-10-20',act:'10',expected:before,desired:{...desired,Клієнт:'Bad'}}]),/Історію акта змінено/);
 const current=b.Історія['2026-10-20'][0];await assert.rejects(f.writeHistory([{date:'2026-10-20',act:'10',expected:current,desired:null}]),/скасуйте/);
 await f.db.exec("update acts set date_off='2026-10-21 12:00:00' where act_id=10");await f.query("select write_shop_act_status(10,'2026-10-20',array['Shop']) v");
 b=await f.getBody();assert.equal(b.Історія['2026-10-20'][0].Деталі[0].recordId,'a');assert.equal(b.Історія['2026-10-20'][0].Деталі[0].Розраховано,null);assert.equal(b.Історія['2026-10-20'][0].ДатаЗакриття,'2026-10-21T12:00:00');
}finally{await f.db.close();}});
test('RLS denied update rolls back every selected stock row',async()=>{const f=await fixture();try{
 const a=await f.stockChange(1),b=await f.stockChange(2);await f.db.exec(`alter table sclad enable row level security;grant usage on schema public to authenticated;grant select,update on sclad to authenticated;create policy sel on sclad for select to authenticated using(true);create policy upd on sclad for update to authenticated using(sclad_id=1) with check(sclad_id=1);set role authenticated;`);
 await assert.rejects(f.payStock([a,b]));await f.db.exec('reset role');assert.equal(await f.query('select count(*)::int v from sclad where rosraxovano is not null'),0);
}finally{await f.db.close();}});
for(const type of ['timestamp','timestamptz','text'])test(`stock same-request retry and undo retain correct state with ${type} payment date`,async()=>{const f=await fixture('jsonb',type);try{
 const c=await f.stockChange();await f.payStock([c]);await f.payStock([c]);const undo=await f.stockChange(1,null);await f.payStock([undo]);await f.payStock([undo]);
 assert.equal(await f.query('select rosraxovano v from sclad where sclad_id=1'),null);
}finally{await f.db.close();}});
test('new part under old whole-act paid date remains unpaid and duplicated desired IDs are rejected',async()=>{const f=await fixture();try{
 const before=f.body.Історія['2026-10-20'][0],desired=structuredClone(before);desired.Деталі.push({...before.Деталі[0],recordId:'new',Найменування:'New part'});
 await f.writeHistory([{date:'2026-10-20',act:'10',expected:before,desired}]);const b=await f.getBody();
 assert.equal(b.Історія['2026-10-20'][0].Деталі[2].Розраховано,null);assert.equal((await f.report()).items[2].isPaid,false);assert.equal((await f.report()).items[0].isPaid,true);
 const next=structuredClone(b.Історія['2026-10-20'][0]);next.Деталі.push({...next.Деталі[0]});await assert.rejects(f.writeHistory([{date:'2026-10-20',act:'10',expected:b.Історія['2026-10-20'][0],desired:next}]),/Повторний recordId/);
}finally{await f.db.close();}});
test('serialized JSONB preserves payment metadata and returns no history in v3 report',async()=>{const f=await fixture();try{
 await f.db.query('update shops set data=to_jsonb($1::text)',[JSON.stringify(f.body)]);await f.payDetails([await f.detailChange()]);
 const report=await f.query('select traffic_shop_report_v3($1,0,20) v',[JSON.stringify({from:'2026-10-01',to:'2026-10-21'})]);
 assert.deepEqual(report.shops,[]);assert.equal(report.items[0].isPaid,false);assert.equal(await f.query('select jsonb_typeof(data) v from shops'),'string');
}finally{await f.db.close();}});
test('legacy paid detail that lost recordId keeps settlement when assigned its recovered unique identity',async()=>{const f=await fixture();try{
 await f.db.exec(`update shops set data=data#-'{Історія,2026-10-20,0,Деталі,0,recordId}'`);const b=await f.getBody(),before=b.Історія['2026-10-20'][0],desired=structuredClone(before);
 desired.Деталі[0].recordId='recovered';desired.Деталі[0].Ціна=75;await f.writeHistory([{date:'2026-10-20',act:'10',expected:before,desired}]);
 const row=(await f.report()).items[0];assert.equal(row.isPaid,true);assert.equal(row.recordId,'recovered');assert.equal(row.price,75);
}finally{await f.db.close();}});
test('RLS denied shop write never settles an earlier selected shop',async()=>{const f=await fixture();try{
 await f.db.query('insert into shops values(2,$1)',[JSON.stringify(f.body)]);const rows=(await f.report()).items,c=await f.detailChange();const other=rows.find(row=>row.shopId===2);
 const d={...c,shopId:2,fingerprint:other.paymentFingerprint};await f.db.exec(`alter table shops enable row level security;grant usage on schema public to authenticated;grant select,update on shops to authenticated;create policy sel on shops for select to authenticated using(true);create policy upd on shops for update to authenticated using(shop_id=1) with check(shop_id=1);set role authenticated;`);
 await assert.rejects(f.payDetails([c,d]));await f.db.exec('reset role');assert.equal((await f.report()).items[0].isPaid,true);
}finally{await f.db.close();}});
