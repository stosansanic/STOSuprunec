const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
const migration=fs.readFileSync('supabase/migrations/20261021154545_traffic_directory_modal_read.sql','utf8')+'\n'+fs.readFileSync('supabase/migrations/20261021153336_directory_modal_integrity.sql','utf8');
async function fixture({installNew=true}={}){
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated;
 create table slyusars(slyusar_id bigint primary key,data jsonb);
 create table incomes(income_id bigint primary key,data jsonb);
 create table receivers(receiver_id bigint primary key,data jsonb);
 create table shops(shop_id bigint primary key,data jsonb);
 create table works(work_id bigint primary key,data text);
 create table details(detail_id bigint primary key,data text);
 create table faktura(faktura_id bigint primary key,name text,oderjyvach text,prumitka text,data date,namber integer);
 create table sclad(sclad_id bigint primary key,time_on date,shops text,part_number text,name text,kilkist_on numeric,price numeric,rahunok text,unit_measurement text,"scladNomer" integer,xto_zamovuv bigint,kilkist_off numeric,akt text,statys text,prumitka text);`);
 await db.exec(fs.readFileSync('supabase/migrations/20261005010000_traffic_detail_suggestions.sql','utf8'));
 const helper=fs.readFileSync('supabase/migrations/20261005100000_traffic_service_book.sql','utf8');
 await db.exec(helper.slice(0,helper.indexOf('create or replace function public.sto_service_book_search_v1'))+'commit;');
 await db.exec(fs.readFileSync('supabase/migrations/20261011140000_traffic_directories.sql','utf8'));
 const catalog=fs.readFileSync('supabase/migrations/20261007110000_traffic_stock_pages.sql','utf8');
 await db.exec(catalog.slice(0,catalog.indexOf('create or replace function public.traffic_stock_page(')));
 if(installNew)await db.exec(migration);
 const call=async(sql,args)=>(await db.query(sql,args)).rows[0].v;
 return {db,
 read:(kind,q='',offset=0,exact=false,id=null)=>call('select traffic_directory_page($1,$2,$3,$4,$5) v',[kind,q,offset,exact,id]),
 write:(kind,id,patch,expected=null)=>call('select traffic_directory_write($1,$2,$3,$4) v',[kind,id,JSON.stringify(patch),expected===null?null:JSON.stringify(expected)]),
 remove:(kind,id,expected)=>call('select traffic_directory_delete($1,$2,$3) v',[kind,id,JSON.stringify(expected)]),
 counter:(id,patch,expected=null)=>call('select traffic_contragent_write($1,$2,$3) v',[id,JSON.stringify(patch),expected===null?null:JSON.stringify(expected)])};
}

test('standalone work repair upgrades the old writer without replacing work search',async()=>{
 const f=await fixture({installNew:false});try{
 await f.db.exec(fs.readFileSync('supabase/migrations/20261011170000_directory_writes.sql','utf8'));
 await f.db.exec(fs.readFileSync('supabase/migrations/20261021154545_traffic_directory_modal_read.sql','utf8'));
 await assert.rejects(f.write('works',null,{data:'Repair work'}),/Invalid directory patch/);
 await assert.rejects(f.remove('works',1,{data:'Repair work'}),error=>error.code==='42883');
 const before=(await f.db.query("select pg_get_functiondef('traffic_directory_page(text,text,integer,boolean,bigint)'::regprocedure) definition")).rows[0].definition;
 const repair=fs.readFileSync('supabase/setup/traffic-optimization/directory-work-write-repair.sql','utf8');
 await f.db.exec(repair);await f.db.exec(repair);
 const created=await f.write('works',null,{data:'Repair work'});
 assert.equal(created.status,'created');assert.equal(created.row.data,'Repair work');
 assert.equal((await f.write('works',null,{data:'Repair work'})).status,'existing');
 assert.equal((await f.write('works',created.row.work_id,{data:'Updated work'},{data:'Repair work'})).status,'updated');
 const kept=await f.write('works',null,{data:'Keep this work'});
 await assert.rejects(f.remove('works',created.row.work_id,{data:'Repair work'}),/змінився/);
 assert.deepEqual(await f.remove('works',created.row.work_id,{data:'Updated work'}),{status:'deleted',id:created.row.work_id});
 assert.equal((await f.read('works','',0,false,created.row.work_id)).items.length,0);
 assert.equal((await f.read('works','',0,false,kept.row.work_id)).items[0].data,'Keep this work');
 await assert.rejects(f.remove('works',created.row.work_id,{data:'Updated work'}),/уже видалено/);
 const after=(await f.db.query("select pg_get_functiondef('traffic_directory_page(text,text,integer,boolean,bigint)'::regprocedure) definition")).rows[0].definition;
 assert.equal(after,before);
 }finally{await f.db.close();}
});

test('work names add atomically, deduplicate, patch selected ID and reject stale/duplicate rename',async()=>{
 const f=await fixture();try{
 const first=await f.write('works',null,{data:'Brake repair'});assert.equal(first.status,'created');assert.equal(first.row.data,'Brake repair');
 assert.equal((await f.write('works',null,{data:'  BRAKE   REPAIR '})).status,'existing');
 const next=await f.write('works',first.row.work_id,{data:'Engine repair'},{data:'Brake repair'});assert.equal(next.status,'updated');
 assert.equal((await f.write('works',first.row.work_id,{data:'Engine repair'},{data:'Brake repair'})).status,'unchanged');
 await assert.rejects(f.write('works',first.row.work_id,{data:'Wrong'},{data:'Brake repair'}),/змінено/);
 await f.write('works',null,{data:'Another'});
 await assert.rejects(f.write('works',first.row.work_id,{data:'ANOTHER'},{data:'Engine repair'}),/вже існує/);
 assert.equal((await f.read('works')).total,2);
 }finally{await f.db.close();}
});
test('work search preserves IDs for duplicate names and bounded pages after filtering',async()=>{
 const f=await fixture();try{
 await f.db.exec("insert into works select i,'Service '||i from generate_series(1,105)i; insert into works values(106,'Service 1');");
 const page=await f.read('works','Service');assert.equal(page.items.length,50);assert.equal(page.total,106);
 assert.equal((await f.read('works','Service',100)).items.length,6);
 assert.equal((await f.read('works','Service 1',0,true)).total,2);
 await assert.rejects(f.write('works',null,{data:'Service 1'}),/Неоднозначна/);
 }finally{await f.db.close();}
});
test('shop rename changes only Name and retains inventory/history; deleting used shop is refused',async()=>{
 const f=await fixture();try{
 const original={Name:'Old',Історія:{act:99},Склад:{a:1},'Про магазин':'keep'};
 await f.db.query('insert into shops values(8,$1)',[JSON.stringify(original)]);
 const row=(await f.write('shops',8,{Name:'New'},{Name:'Old'})).row;
 assert.deepEqual(row,{shop_id:8,data:{Name:'New'}});
 assert.deepEqual((await f.db.query('select data from shops')).rows[0].data,{...original,Name:'New'});
 await assert.rejects(f.remove('shops',8,{Name:'New'}),/історію|складські/);
 await assert.rejects(f.write('shops',8,{Історія:{}},{Name:'New'}),/metadata/);
 }finally{await f.db.close();}
});
test('delete confirms one actual row, rejects stale baseline and protects admin/payroll history',async()=>{
 const f=await fixture();try{
 await f.db.exec(`insert into slyusars values(1,'{"Name":"Admin"}'),(2,'{"Name":"Paid","Історія":{"act":1}}');insert into incomes values(1,'{"Name":"Old"}');`);
 await assert.rejects(f.remove('slyusars',1,{Name:'Admin'}),/заборонено/);
 await assert.rejects(f.remove('slyusars',2,{Name:'Paid'}),/історію/);
 await assert.rejects(f.remove('incomes',1,{Name:'Other'}),/змінився/);
 assert.deepEqual(await f.remove('incomes',1,{Name:'Old'}),{status:'deleted',id:1});
 await assert.rejects(f.remove('incomes',1,{Name:'Old'}),/видалено|доступу/);
 }finally{await f.db.close();}
});
test('RLS blocked update/delete never reports success for directory or contractor',async()=>{
 const f=await fixture();try{
 await f.db.exec(`insert into incomes values(1,'{"Name":"Old"}');insert into faktura values(1,'Company','Recipient',null,null,0);
 grant select,update,delete on incomes,faktura to authenticated;alter table incomes enable row level security;alter table faktura enable row level security;
 create policy income_read on incomes for select to authenticated using(true);create policy faktura_read on faktura for select to authenticated using(true);set role authenticated;`);
 await assert.rejects(f.write('incomes',1,{Name:'New'},{Name:'Old'}),/доступ|підтвердила|знайдено/);
 await assert.rejects(f.remove('incomes',1,{Name:'Old'}),/доступ|підтвердила|видалено/);
 await assert.rejects(f.counter(1,{name:'New'},{name:'Company'}),/доступ|підтвердила|Оновіть/);
 await f.db.exec('reset role');assert.equal((await f.read('incomes')).items[0].data.Name,'Old');
 }finally{await f.db.close();}
});
test('legacy text employee JSON and JSON scalar detail names stay compatible without history in response',async()=>{
 const f=await fixture();try{
 await f.db.exec('alter table slyusars alter column data type text using data::text;alter table details alter column data type jsonb using to_jsonb(data);');
 await f.db.query('insert into slyusars values(2,$1)',[JSON.stringify({Name:'Worker',Пароль:'hash',Доступ:'Слюсар',Історія:{keep:1},ПроцентРоботи:50})]);
 const result=await f.write('slyusars',2,{ПроцентРоботи:55},{ПроцентРоботи:50});assert.equal(result.row.data.ПроцентРоботи,55);assert.equal(result.row.data.Історія,undefined);
 const listing=await f.read('slyusars');assert.deepEqual(listing.items[0].data,{Name:'Worker',Доступ:'Слюсар'});
 const created=await f.write('details',null,{data:'Washer'});assert.equal(created.row.data,'Washer');
 await f.write('details',created.row.detail_id,{data:'Bolt'},{data:'Washer'});assert.equal((await f.read('details')).items[0].data,'Bolt');
 }finally{await f.db.close();}
});
test('staff patch validation and protected admin fields preserve existing data',async()=>{
 const f=await fixture();try{
 await f.db.exec(`insert into slyusars values(1,'{"Name":"Admin","Доступ":"Адміністратор","ПроцентРоботи":20}');`);
 const row=(await f.write('slyusars',1,{Name:'Changed',Доступ:'Слюсар',ПроцентРоботи:25},{Name:'Admin',Доступ:'Адміністратор',ПроцентРоботи:20})).row;
 assert.equal(row.data.Name,'Admin');assert.equal(row.data.Доступ,'Адміністратор');assert.equal(row.data.ПроцентРоботи,25);
 for(const value of [-1,101,'20',null])await assert.rejects(f.write('slyusars',1,{ПроцентРоботи:value},{ПроцентРоботи:25}),/Некорект/);
 }finally{await f.db.close();}
});
test('counterparty delta preserves concurrent untouched fields and returns actual row',async()=>{
 const f=await fixture();try{
 const first=await f.counter(null,{name:'Company',oderjyvach:'Recipient',namber:1,data:'2026-10-21',prumitka:'UA'+'1'.repeat(27)});
 await f.db.exec("update faktura set namber=0 where faktura_id=1");
 const saved=await f.counter(1,{oderjyvach:'New Recipient'},first);assert.equal(saved.namber,0);assert.equal(saved.name,'Company');
 await assert.rejects(f.counter(1,{oderjyvach:'Stale'},first),/змінений/);
 assert.equal((await f.remove('faktura',1,saved)).status,'deleted');
 }finally{await f.db.close();}
});
test('contractor supports create, edit and delete while preserving other contractors',async()=>{
 const f=await fixture();try{
 const created=await f.counter(null,{name:'Company',oderjyvach:'Receiver',prumitka:'',data:null,namber:0});
 assert.ok(created.faktura_id>0);assert.equal(created.namber,0);
 const kept=await f.counter(null,{name:'Other company',oderjyvach:'Other receiver',prumitka:'',data:null,namber:null});
 const edited=await f.counter(created.faktura_id,{name:'Renamed company'},{name:created.name});
 assert.equal(edited.name,'Renamed company');
 await assert.rejects(f.remove('faktura',created.faktura_id,created),/змінився/);
 assert.deepEqual(await f.remove('faktura',created.faktura_id,edited),{status:'deleted',id:created.faktura_id});
 assert.equal((await f.read('faktura','',0,false,kept.faktura_id)).items[0].name,'Other company');
 }finally{await f.db.close();}
});

test('selected stock read includes only one baseline and optional safety fields without requiring client_price',async()=>{
 const f=await fixture();try{
 await f.db.exec("insert into sclad(sclad_id,name,akt,kilkist_on,kilkist_off,prumitka,statys) values(1,'Bolt','1539',5,2,'keep','Paid');");
 const row=(await f.db.query('select traffic_stock_position(1) v')).rows[0].v;
 assert.equal(row.akt,'1539');assert.equal(row.kilkist_off,2);assert.equal(row.prumitka,'keep');assert.equal(row.statys,'Paid');assert.equal(row.client_price,undefined);
 await f.db.exec(migration);assert.equal((await f.db.query('select traffic_stock_position(1) v')).rows[0].v.akt,'1539');
 }finally{await f.db.close();}
});

test('serialized payroll history prevents deletion while empty dated shop history does not',async()=>{
 const f=await fixture();try{
 await f.db.query('insert into slyusars values(2,$1)',[JSON.stringify({Name:'Legacy',Склад:1,Історія:JSON.stringify({'2026-10-21':[{Акт:'1274'}]})})]);
 await assert.rejects(f.remove('slyusars',2,{Name:'Legacy'}),/історію/);
 await f.db.query('insert into shops values(3,$1)',[JSON.stringify({Name:'Empty',Історія:{'2026-10-21':[]},Склад:{}})]);
 assert.equal((await f.remove('shops',3,{Name:'Empty'})).status,'deleted');
 }finally{await f.db.close();}
});
test('two reference edits are atomic; failed second operation rolls back the first',async()=>{
 const f=await fixture();try{
 await f.db.exec(`insert into shops values(8,'{"Name":"Old Shop"}');insert into details values(5,'Old Detail');`);
 const changes=[{kind:'details',mode:'edit',id:5,patch:{data:'New Detail'},expected:{data:'Old Detail'}},{kind:'shops',mode:'edit',id:8,patch:{Name:'New Shop'},expected:{Name:'stale'}}];
 const call=()=>f.db.query('select traffic_directory_reference_batch($1) v',[JSON.stringify(changes)]);
 await assert.rejects(call(),/змінено/);assert.equal((await f.read('details')).items[0].data,'Old Detail');
 changes[1].expected.Name='Old Shop';const result=(await call()).rows[0].v;assert.equal(result.length,2);assert.equal((await f.read('details')).items[0].data,'New Detail');
 assert.equal((await call()).rows[0].v.every(row=>row.status==='unchanged'),true);
 }finally{await f.db.close();}
});

test('complete repair bundle installs twice without touching existing records',async()=>{
 const f=await fixture({installNew:false});try{
 await f.db.exec(`insert into shops values(7,'{"Name":"Keep","Історія":{"paid":25}}');`);
 const repair=fs.readFileSync('supabase/setup/traffic-optimization/directory-modal-repair.sql','utf8');
 await f.db.exec(repair);await f.db.exec(repair);
 assert.deepEqual((await f.db.query('select data from shops')).rows[0].data,{Name:'Keep',Історія:{paid:25}});
 assert.equal((await f.write('works',null,{data:'Repair'})).status,'created');
 }finally{await f.db.close();}
});

test('every modal directory supports create, edit, unchanged save and confirmed delete with compact receipts',async()=>{
 const f=await fixture();try{
 await f.db.exec(`insert into slyusars values(1,'{"Name":"Admin","Доступ":"Адміністратор"}');`);
 for(const [kind,key] of [['works','work_id'],['details','detail_id'],['shops','shop_id'],['incomes','income_id'],['receivers','receiver_id'],['slyusars','slyusar_id']]){
  const field=['works','details'].includes(kind)?'data':'Name';
  const first=await f.write(kind,null,{[field]:'Initial '+kind});assert.equal(first.status,'created',kind);
  const id=first.row[key];const initial={[field]:'Initial '+kind};const next={[field]:'Edited '+kind};
  const updated=await f.write(kind,id,next,initial);assert.equal(updated.status,'updated',kind);
  assert.equal((await f.write(kind,id,next,next)).status,'unchanged',kind);
  const found=await f.read(kind,'Edited '+kind,0,true);assert.equal(found.items.length,1);assert.equal(found.items[0][key],id);
  assert.deepEqual(await f.remove(kind,id,next),{status:'deleted',id});
  assert.equal((await f.read(kind,'Edited '+kind)).items.length,0);
 }
 }finally{await f.db.close();}
});

test('paged employee results keep totals and hide large history while selected metadata stays bounded',async()=>{
 const f=await fixture();try{
 await f.db.exec(`insert into slyusars select i,jsonb_build_object('Name','Worker '||lpad(i::text,3,'0'),'Доступ','Слюсар','Пароль','secret-hash','ПроцентРоботи',50,'Історія',jsonb_build_object('large',repeat('x',20000))) from generate_series(1,125)i;`);
 const first=await f.read('slyusars','Worker');const second=await f.read('slyusars','Worker',50);const last=await f.read('slyusars','Worker',100);
 assert.equal(first.total,125);assert.equal(first.items.length,50);assert.equal(second.items.length,50);assert.equal(last.items.length,25);
 assert.equal(new Set([...first.items,...second.items,...last.items].map(row=>row.slyusar_id)).size,125);
 assert.ok(JSON.stringify(first).length<10000);assert.equal(first.items.some(row=>'Пароль' in row.data||'Історія' in row.data),false);
 const selected=(await f.read('slyusars','',0,false,75)).items[0];assert.equal(selected.data.ПроцентРоботи,50);assert.equal(selected.data.Пароль,'secret-hash');assert.equal(selected.data.Історія,undefined);
 }finally{await f.db.close();}
});

test('stock lazy pages keep bounded cursor pagination and include consumed quantity for guarded deletion',async()=>{
 const f=await fixture();try{
 await f.db.exec("insert into sclad(sclad_id,part_number,kilkist_on,kilkist_off) select i,'AB-12',10,2 from generate_series(1,27)i;");
 const read=async cursor=>(await f.db.query("select traffic_stock_page_v2('Прибула',null,null,'AB12',$1,20) v",[cursor])).rows[0].v;
 const first=await read(null);assert.equal(first.items.length,20);assert.equal(first.has_more,true);assert.equal(first.next_cursor,8);
 assert.equal(first.items[0].kilkist_off,2);assert.equal(first.items[0].client_price,null);
 const next=await read(first.next_cursor);assert.equal(next.items.length,7);assert.equal(next.has_more,false);
 await f.db.exec('alter table sclad add column client_price numeric;update sclad set client_price=35.5 where sclad_id=27;');
 assert.equal((await read(null)).items[0].client_price,35.5);
 }finally{await f.db.close();}
});

test('legacy catalog object rename preserves metadata, name key and concurrent untouched fields',async()=>{
 const f=await fixture();try{
 await f.db.exec('alter table details alter column data type jsonb using to_jsonb(data)');
 const original={Назва:'Legacy part',keep:{price:17,notes:['keep']},Name:'',name:null};
 await f.db.query('insert into details values(5,$1)',[JSON.stringify(original)]);
 assert.deepEqual((await f.read('details','legacy')).items,[{detail_id:5,data:'Legacy part'}]);
 assert.equal((await f.write('details',null,{data:' LEGACY part '})).status,'existing');
 await f.db.query("update details set data=jsonb_set(data,'{keep,price}','19') where detail_id=5");
 const result=await f.write('details',5,{data:'Renamed part'},{data:'Legacy part'});
 assert.deepEqual(result.row,{detail_id:5,data:'Renamed part'});
 assert.deepEqual((await f.db.query('select data from details where detail_id=5')).rows[0].data,{...original,Назва:'Renamed part',keep:{price:19,notes:['keep']}});
 assert.equal((await f.write('details',5,{data:'Renamed part'},{data:'Legacy part'})).status,'unchanged');
 await assert.rejects(f.remove('details',5,{data:'Legacy part'}),/змінився/);
 assert.equal((await f.remove('details',5,{data:'Renamed part'})).status,'deleted');
 }finally{await f.db.close();}
});

test('text serialized catalog objects retain their original shape and non-name metadata',async()=>{
 const f=await fixture();try{
 const original={text:'Legacy work',keep:{catalog:7},ПІБ:'Secondary label'};
 await f.db.query('insert into works values(8,$1)',[JSON.stringify(original)]);
 assert.equal((await f.read('works','Legacy work',0,true)).items[0].data,'Legacy work');
 const saved=await f.write('works',8,{data:'Updated work'},{data:'Legacy work'});
 assert.equal(saved.row.data,'Updated work');
 const stored=(await f.db.query('select data from works where work_id=8')).rows[0].data;
 assert.equal(typeof stored,'string');assert.deepEqual(JSON.parse(stored),{...original,text:'Updated work'});
 }finally{await f.db.close();}
});

test('JSON scalar and serialized JSON catalog objects preserve their storage representations',async()=>{
 const f=await fixture();try{
 await f.db.exec('alter table works alter column data type jsonb using to_jsonb(data);alter table details alter column data type jsonb using to_jsonb(data)');
 await f.db.query('insert into works values(3,$1)',[JSON.stringify('Scalar work')]);
 const object={Name:'Encoded part',name:'Alias',keep:[1,2]};
 await f.db.query('insert into details values(4,$1)',[JSON.stringify(JSON.stringify(object))]);
 assert.equal((await f.read('details')).items[0].data,'Encoded part');
 await f.write('works',3,{data:'Scalar renamed'},{data:'Scalar work'});
 await f.write('details',4,{data:'Encoded renamed'},{data:'Encoded part'});
 assert.equal((await f.db.query('select data from works where work_id=3')).rows[0].data,'Scalar renamed');
 const encoded=(await f.db.query('select data from details where detail_id=4')).rows[0].data;
 assert.equal(typeof encoded,'string');assert.deepEqual(JSON.parse(encoded),{...object,Name:'Encoded renamed'});
 assert.equal((await f.read('details','encoded renamed',0,true)).items[0].detail_id,4);
 }finally{await f.db.close();}
});

test('legacy JSON name aliases use the resolver priority and keep alternate labels unchanged',async()=>{
 const f=await fixture();try{
 await f.db.exec('alter table details alter column data type json using to_json(data)');
 const object={Name:'Primary',Назва:'Alternate',Текст:'More',keep:1};
 await f.db.query('insert into details values(2,$1)',[JSON.stringify(object)]);
 await f.write('details',2,{data:'Changed primary'},{data:'Primary'});
 assert.deepEqual((await f.db.query('select data from details')).rows[0].data,{...object,Name:'Changed primary'});
 await f.db.query('insert into details values(3,$1)',[JSON.stringify({name:'Duplicate',keep:2})]);
 await assert.rejects(f.write('details',2,{data:' DUPLICATE '},{data:'Changed primary'}),/вже існує/);
 assert.equal((await f.read('details','Changed primary',0,true)).items[0].detail_id,2);
 }finally{await f.db.close();}
});


test('file 8 contains the tested CRUD functions and their supporting RPCs', {skip:!process.env.STO_DIRECTORY_TEMPLATE}, async()=>{
 const template=fs.readFileSync(process.env.STO_DIRECTORY_TEMPLATE,'utf8').replace(/\r\n/g,'\n');
 const source=fs.readFileSync('supabase/migrations/20261021153336_directory_modal_integrity.sql','utf8').replace(/\r\n/g,'\n');
 const extract=(text,name)=>{
  const start=text.toLowerCase().lastIndexOf('create or replace function public.'+name+'(');
  assert.ok(start>=0,'missing '+name);
  const open=text.indexOf('$$',start),end=text.indexOf('$$;',open+2);
  assert.ok(end>open,'incomplete '+name);return text.slice(start,end+3);
 };
 for(const name of ['traffic_directory_rename_reference','traffic_directory_write','traffic_directory_has_history','traffic_directory_delete','traffic_contragent_write','traffic_directory_reference_batch']){
  assert.equal(extract(template,name),extract(source,name),'final definition of '+name);
 }
 for(const name of ['traffic_directory_page','traffic_stock_position','traffic_stock_page_v2','traffic_employee_counts','stock_insert_invoice','write_batch_stock_cells']) extract(template,name);
 assert.match(template,/grant execute on function[^;]*public\.traffic_directory_delete\(text,bigint,jsonb\)[^;]*to anon,authenticated;/i);
});
