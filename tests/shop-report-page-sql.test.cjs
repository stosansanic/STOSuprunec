const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
async function fixture(){
 const db=new PGlite();await db.exec('create role anon;create role authenticated;create table shops(shop_id bigint primary key,data jsonb);create table acts(act_id bigint primary key,date_off timestamptz,data jsonb);create table sclad(sclad_id bigint primary key,price numeric,"scladNomer" integer,xto_zamovuv integer,data jsonb);create table slyusars(slyusar_id bigint primary key,data jsonb);');
 const helper=fs.readFileSync('supabase/migrations/20261005100000_traffic_service_book.sql','utf8');await db.exec(helper.slice(0,helper.indexOf('create or replace function public.sto_service_book_search_v1'))+'commit;');
 const search=fs.readFileSync('supabase/migrations/20261011040000_traffic_act_search.sql','utf8');await db.exec(search.slice(0,search.indexOf('create or replace function public.traffic_search_trim'))+'commit;');
 await db.exec(fs.readFileSync('supabase/migrations/20261011120000_traffic_shop_report_page.sql','utf8'));
 const rpc=async(filter={},offset=0,limit=100)=>(await db.query('select traffic_shop_report_page($1,$2,$3) v',[JSON.stringify(filter),offset,limit])).rows[0].v;
 const put=async(id,history)=>db.query('insert into shops values($1,$2)',[id,JSON.stringify({Name:'Shop '+id,Склад:{private:'huge'},Історія:history})]);
 return{db,rpc,put};
}
test('shop report filters before paging and totals all 1003 rows without stock/settings payload',async()=>{
 const f=await fixture();try{
 const details=Array.from({length:1003},(_,i)=>({Найменування:'Part '+i,Каталог:'AB-12',Ціна:10,Кількість:2,sclad_id:1}));
 await f.db.exec(`insert into acts values(1,null,'{"Знижка":10,"Заморожений":true}');insert into sclad values(1,3,2,4,null);insert into slyusars values(4,'{"Name":"Employee","Історія":{"secret":1}}');`);
 const entry={Акт:1,Автомобіль:'Car',ДатаЗакриття:'01.01.2020',Деталі:details};await f.put(1,{'11.10.2026':[entry]});
 const first=await f.rpc({catalog:'ab12',status:'open'});assert.equal(first.items.length,100);assert.equal(first.totalCount,1003);assert.deepEqual(first.totals,{sale:20060,purchase:6018,margin:12036});assert.equal(first.items[0].dateClose,'');assert.equal(first.items[0].zapchastystName,'Employee');assert.equal(first.shops[0].data.Склад,undefined);assert.deepEqual(first.shops[0].data.Історія['11.10.2026'][0],entry);
 const ids=new Set();for(let o=0;o<1003;o+=100){const p=await f.rpc({catalog:'ab12',status:'open'},o);for(const r of p.items)ids.add(r.rowId);assert.equal(p.totals.sale,20060);}assert.equal(ids.size,1003);
 assert.equal((await f.rpc({item:'Part 1002'})).items[0].item,'Part 1002');assert.equal((await f.rpc({status:'closed'})).totalCount,0);
 assert.equal((await f.rpc({warehouse:3})).totalCount,0);assert.deepEqual((await f.rpc({warehouse:3})).warehouses,[2]);
 }finally{await f.db.close()}
});
test('date modes, legacy stock overrides, returns, missing acts and RLS preserve financial meaning',async()=>{
 const f=await fixture();try{
 await f.db.exec(`insert into acts values(1,'2026-10-09T10:00:00Z','{"Знижка":25}'),(2,null,'{}');insert into sclad values(1,9,1,null,'{"price":4,"scladNomer":3}'),(2,8,1,null,'"{\\"price\\":5}"');`);
 const entry=(act,qty,stock,paid)=>({Акт:act,Автомобіль:'Car',ДатаЗакриття:'10.10.2026',...(paid?{Розрахунок:paid}:{}),Деталі:[{Найменування:'Part',Каталог:'AB-12',Ціна:'20',Кількість:qty,sclad_id:stock}]});
 await f.put(1,{'01.10.2026':[entry(1,2,1,'11.10.2026')],'2026-10-02':[entry(2,-1,2)],'03.10.2026':[entry(99,1,99)]});
 const all=await f.rpc();assert.deepEqual(all.totals,{sale:40,purchase:3,margin:7});assert.equal(all.items[0].act,'99');assert.equal(all.items[0].purchasePrice,undefined);
 const closed=await f.rpc({dateMode:'close',from:'2026-10-09',to:'2026-10-09'});assert.equal(closed.totalCount,1);assert.equal(closed.items[0].act,'1');
 assert.equal((await f.rpc({dateMode:'paid'})).totalCount,1);assert.equal((await f.rpc({payment:'unpaid'})).totalCount,2);assert.equal((await f.rpc({status:'closed'})).totalCount,2);
 await f.put(2,{'12.10.2026':[entry(1,100,1)]});await f.db.exec('grant select on shops,acts,sclad,slyusars to authenticated;alter table shops enable row level security;create policy scope on shops to authenticated using(shop_id=1);set role authenticated;');assert.equal((await f.rpc()).totalCount,3);
 }finally{await f.db.close()}
});

