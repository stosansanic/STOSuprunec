const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
const migration=fs.readFileSync('supabase/migrations/20261011080000_payroll_fragments.sql','utf8');
async function fixture() {
 const db=new PGlite();await db.exec('create role anon;create role authenticated;create table acts(act_id bigint primary key,data jsonb);create table slyusars(slyusar_id bigint primary key,data jsonb);');await db.exec(migration);
 const entry={Акт:'1',Записи:[{recordId:'w1',Зарплата:20},{recordId:'w2',Зарплата:30}]};
 const original={Name:'Worker',ПроцентРоботи:20,Історія:{'2026-10-11':[entry,{Акт:'2',Записи:[]}]}};
 await db.query('insert into acts values(1,$1),(2,$1);',['{}']);await db.query('insert into slyusars values(1,$1)',[JSON.stringify(original)]);
 const read=async()=>(await db.query('select data from slyusars where slyusar_id=1')).rows[0].data;
 const rpc=async(mode,changes)=>(await db.query('select write_payroll_fragments(1,$1,$2::jsonb) r',[mode,JSON.stringify(changes)])).rows[0].r;
 return {db,entry,original,read,rpc};
}
const payment=(entry,index,paid='11.10.2026')=>({act_id:1,date:'2026-10-11',target:'record',index,record_id:entry.Записи[index].recordId,expected:entry.Записи[index],desired:paid?{Розраховано:paid}:{}});
test('separate payment fragments preserve concurrent rows/settings, retry is idempotent, stale same target conflicts',async()=>{
 const f=await fixture();try{
  const a=payment(f.entry,0),b=payment(f.entry,1);
  await f.db.exec(`update slyusars set data=jsonb_set(data,'{ПроцентРоботи}','55')`);
  assert.equal((await f.rpc('payment',[a])).status,'updated');await f.rpc('payment',[b]);assert.equal((await f.rpc('payment',[a])).status,'unchanged');
  const data=await f.read();assert.equal(data.ПроцентРоботи,55);assert.ok(data.Історія['2026-10-11'][0].Записи.every(r=>r.Розраховано));assert.deepEqual(data.Історія['2026-10-11'][1],f.original.Історія['2026-10-11'][1]);
  await assert.rejects(f.rpc('payment',[{...a,desired:{Розраховано:'12.10.2026'}}]),/змінено/);
  await assert.rejects(f.rpc('payment',[{...a,desired:{Зарплата:100}}]),/лише/);
 }finally{await f.db.close();}
});
test('payment checks current frozen/pending act while accrual and freeze cleanup remain permitted',async()=>{
 const f=await fixture();try{
  for(const key of ['Заморожений','__payroll_pending']) {
   await f.db.query('update acts set data=$1 where act_id=1',[JSON.stringify({[key]:true})]);
   await assert.rejects(f.rpc('payment',[payment(f.entry,0)]),/заморожений|завершений/);
  }
  const expected=[{date:'2026-10-11',value:f.entry}],next=structuredClone(f.entry);next.Записи[0].Зарплата=21;
  await f.rpc('accrual',[{act_id:1,expected,desired:[{date:'2026-10-11',value:next}]}]);
  await f.db.query('update acts set data=$1 where act_id=1',[JSON.stringify({Заморожений:true})]);
  await f.rpc('accrual',[{act_id:1,expected:[{date:'2026-10-11',value:next}],desired:[]}]);
  assert.equal((await f.read()).Історія['2026-10-11'].length,1);
 }finally{await f.db.close();}
});
test('RLS denied write rolls back; legacy JSON text supports narrow atomic updates',async()=>{
 const f=await fixture();try{
  await f.db.exec(`alter table slyusars alter column data type text using data::text;
   grant select,update on acts,slyusars to authenticated;
   alter table slyusars enable row level security;
   create policy readable on slyusars for select to authenticated using(true);
   create policy forbidden on slyusars for update to authenticated using(true) with check(false);
   set role authenticated;`);
  await assert.rejects(f.rpc('payment',[payment(f.entry,0)]),/row-level security/);
  await f.db.exec('reset role');assert.equal(JSON.parse(await f.read()).Історія['2026-10-11'][0].Записи[0].Розраховано,undefined);
  await f.rpc('payment',[payment(f.entry,0)]);assert.equal(JSON.parse(await f.read()).Історія['2026-10-11'][0].Записи[0].Розраховано,'11.10.2026');
 }finally{await f.db.close();}
});

test('record ID survives reorder; legacy ambiguous/index mismatch rejects and partial request rolls back',async()=>{
 const f=await fixture();try{
  const a=payment(f.entry,0);const reversed={...f.entry,Записи:[...f.entry.Записи].reverse()};
  await f.db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-10-11,0}',$1)",[JSON.stringify(reversed)]);
  await f.rpc('payment',[a]);let saved=await f.read();assert.equal(saved.Історія['2026-10-11'][0].Записи[1].Розраховано,'11.10.2026');assert.equal(saved.Історія['2026-10-11'][0].Записи[0].Розраховано,undefined);
  await f.db.query('update slyusars set data=$1',[JSON.stringify(f.original)]);
  const bad={...payment(f.entry,1),expected:{...f.entry.Записи[1],Зарплата:999}};
  await assert.rejects(f.rpc('payment',[a,bad]),/змінено/);assert.deepEqual(await f.read(),f.original);
  const legacy={Акт:'1',Записи:[{Робота:'Same',Зарплата:20},{Робота:'Same',Зарплата:20}]};
  await f.db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-10-11,0}',$1)",[JSON.stringify(legacy)]);
  await assert.rejects(f.rpc('payment',[{...a,record_id:null,index:0,expected:legacy.Записи[0]}]),/Неоднозначна/);
  legacy.Записи[1].Зарплата=30;await f.db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-10-11,0}',$1)",[JSON.stringify(legacy)]);
  await assert.rejects(f.rpc('payment',[{...a,record_id:null,index:1,expected:legacy.Записи[0]}]),/змінено/);
  await f.rpc('payment',[{...a,record_id:null,index:0,expected:legacy.Записи[0]}]);
  saved=await f.read();assert.equal(saved.Історія['2026-10-11'][0].Записи[0].Розраховано,'11.10.2026');assert.equal(saved.Історія['2026-10-11'][0].Записи[1].Розраховано,undefined);
 }finally{await f.db.close()}
});

test('targeted employee reader excludes unrelated acts and secrets; partial baseline safely updates one act',async()=>{
 const f=await fixture();try{
  await f.db.exec(fs.readFileSync('supabase/migrations/20261011090000_traffic_payroll_employees.sql','utf8'));
  await f.db.exec(`update slyusars set data=data||'{"password":"secret","Телефон":"private"}'::jsonb`);
  const row=(await f.db.query('select traffic_payroll_employees(array[1]::bigint[],0,null,\'Worker\') r')).rows[0].r[0];
  assert.equal(row.data.Історія['2026-10-11'].length,1);assert.equal(row.data.password,undefined);assert.equal(row.data.Телефон,undefined);
  const desired=structuredClone(row.data.Історія['2026-10-11'][0]);desired.ДатаЗакриття='2026-10-11';
  await f.rpc('accrual',[{act_id:1,expected:[{date:'2026-10-11',value:f.entry}],desired:[{date:'2026-10-11',value:desired}]}]);
  const saved=await f.read();assert.equal(saved.password,'secret');assert.equal(saved.Історія['2026-10-11'].length,2);
  await f.db.exec(`insert into slyusars select i,jsonb_build_object('Name','Worker '||i,'Історія','{}'::jsonb) from generate_series(2,205)i`);
  const first=(await f.db.query('select traffic_payroll_employees(array[1]::bigint[],0) r')).rows[0].r;
  const second=(await f.db.query('select traffic_payroll_employees(array[1]::bigint[],200) r')).rows[0].r;
  assert.equal(first.length,200);assert.equal(second.length,5);assert.equal(new Set([...first,...second].map(r=>r.slyusar_id)).size,205);
 }finally{await f.db.close();}
});
