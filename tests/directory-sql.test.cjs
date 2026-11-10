const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
async function fixture(){const db=new PGlite();await db.exec('create role anon;create role authenticated;create table slyusars(slyusar_id integer primary key,data jsonb);create table incomes(income_id integer primary key,data jsonb);create table receivers(receiver_id integer primary key,data jsonb);create table faktura(faktura_id integer primary key,name text,oderjyvach text,prumitka text,data date,namber integer);');
 const helper=fs.readFileSync('supabase/migrations/20261005100000_traffic_service_book.sql','utf8');await db.exec(helper.slice(0,helper.indexOf('create or replace function public.sto_service_book_search_v1'))+'commit;');await db.exec(fs.readFileSync('supabase/migrations/20261011140000_traffic_directories.sql','utf8'));await db.exec(fs.readFileSync('supabase/migrations/20261011170000_directory_writes.sql','utf8'));
 return {db,read:async(kind,q='',offset=0,exact=false,id=null)=>(await db.query('select traffic_directory_page($1,$2,$3,$4,$5) v',[kind,q,offset,exact,id])).rows[0].v,
 write:async(kind,id,patch,expected=null)=>(await db.query('select traffic_directory_write($1,$2,$3,$4) v',[kind,id,JSON.stringify(patch),expected===null?null:JSON.stringify(expected)])).rows[0].v};}
test('directory search precedes pages; list excludes history/password while selected metadata stays editable',async()=>{const f=await fixture();try{
 await f.db.exec(`insert into slyusars select n,jsonb_build_object('Name','Worker '||n,'Доступ','Слюсар','Пароль','hash','Історія',jsonb_build_object('secret','large')) from generate_series(1,1005)n;`);
 assert.equal((await f.read('slyusars')).items.length,50);const last=await f.read('slyusars','Worker 1005');assert.equal(last.total,1);assert.equal(last.items[0].slyusar_id,1005);assert.equal(last.items[0].data.Історія,undefined);assert.equal(last.items[0].data.Пароль,undefined);
 const detail=await f.read('slyusars','',0,false,1005);assert.equal(detail.items[0].data.Пароль,'hash');assert.equal(detail.items[0].data.Історія,undefined);
 assert.equal((await f.db.query('select traffic_employee_counts() v')).rows[0].v.Слюсар,1005);
 const ids=[];for(let o=0;o<1005;o+=50)ids.push(...(await f.read('slyusars','',o)).items.map(r=>r.slyusar_id));assert.equal(new Set(ids).size,1005);
 }finally{await f.db.close()}});
test('atomic metadata writes preserve salary history, reject same-field conflict and do not merge historical duplicates',async()=>{const f=await fixture();try{
 const created=await f.write('slyusars',null,{Name:'  Іван   Петренко ',Доступ:'Адміністратор',ПроцентРоботи:20});const id=created.row.slyusar_id;
 assert.equal((await f.write('slyusars',null,{Name:'іван петренко'})).status,'existing');
 await f.db.exec(`update slyusars set data=data||'{"Історія":{"keep":true}}'`);
 await f.write('slyusars',id,{ПроцентРоботи:30},created.row.data);assert.equal((await f.db.query('select data from slyusars')).rows[0].data.Історія.keep,true);
 await assert.rejects(f.write('slyusars',id,{ПроцентРоботи:40},created.row.data),/змінено/);
 await assert.rejects(f.write('slyusars',id,{Історія:{}},created.row.data),/metadata/);
 await f.db.exec(`insert into incomes values(1,'{"Name":" Same "}'),(2,'{"Name":"same"}')`);
 await assert.rejects(f.write('incomes',null,{Name:'SAME'}),/Неоднозначна/);
 assert.equal((await f.write('incomes',1,{Name:' Same '},{Name:' Same '})).row.income_id,1);
 await f.db.exec('alter table receivers alter column data type text using data::text');assert.equal((await f.write('receivers',null,{Name:'Receiver'})).row.data.Name,'Receiver');
 await f.db.exec('grant select on slyusars to authenticated;alter table slyusars enable row level security;create policy denied on slyusars to authenticated using(false);set role authenticated');assert.equal((await f.read('slyusars')).total,0);
 }finally{await f.db.close()}});
test('counterparty write deduplicates normalized IBAN, supports distinct accounts and protects changed fields',async()=>{const f=await fixture();try{
 const write=async(id,patch,expected=null)=>(await f.db.query('select traffic_contragent_write($1,$2,$3) v',[id,JSON.stringify(patch),expected===null?null:JSON.stringify(expected)])).rows[0].v;
 const first=await write(null,{name:'Company',oderjyvach:'Recipient',prumitka:'UA'+ '1'.repeat(27),data:'2026-10-11'});
 await assert.rejects(write(null,{name:'Other',oderjyvach:'Other',prumitka:'ua '+ '1'.repeat(27)}),/вже існує/);
 const second=await write(null,{name:'Company',oderjyvach:'Recipient',prumitka:'UA'+ '2'.repeat(27)});assert.notEqual(first.faktura_id,second.faktura_id);
 await f.db.exec(`update faktura set namber=5 where faktura_id=1`);const edited=await write(1,{name:'Renamed'},first);assert.equal(edited.namber,5);
 await assert.rejects(write(1,{name:'Stale'},first),/змінений/);
 }finally{await f.db.close()}});
