const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
const migration=fs.readFileSync('supabase/migrations/20261021170138_planner_post_modal_integrity.sql','utf8');
async function fixture(){
 const db=new PGlite();
 await db.exec(`create role authenticated;create role anon;
 create table post_category(category_id integer primary key,category text not null);
 create table post_name(post_id integer primary key,name text not null,category bigint not null);
 create table slyusars(slyusar_id serial primary key,data jsonb not null,post_sluysar text,namber double precision);
 create table post_arxiv(post_arxiv_id bigint primary key,name_post double precision not null,status text);
 create table writes(table_name text,operation text);
 create function record_write() returns trigger language plpgsql as $$begin insert into writes values(TG_TABLE_NAME,TG_OP);return coalesce(new,old);end$$;
 create trigger category_write after insert or update or delete on post_category for each row execute function record_write();
 create trigger post_write after insert or update or delete on post_name for each row execute function record_write();
 create trigger staff_write after insert or update or delete on slyusars for each row execute function record_write();`);
 await db.exec(migration);
 const call=async(sql,args)=>(await db.query(sql,args)).rows[0].v;
 return {db,write:(action,c=null,p=null,patch={},expected={})=>call('select traffic_planner_directory_write($1,$2,$3,$4,$5) v',[action,c,p,JSON.stringify(patch),JSON.stringify(expected)]),
  assign:(c,p,name,id=null,order=1.1,categoryId=null,postId=null)=>call('select traffic_planner_post_assign($1,$2,$3,$4,$5,$6,$7) v',[c,p,name,id,order,categoryId,postId]),
  read:(kind,c=null,q='',after=null,limit=30)=>call('select traffic_planner_post_options($1,$2,$3,$4,$5) v',[kind,c,q,after,limit]),
  count:async(table)=>(await db.query('select count(*)::integer n from '+table)).rows[0].n};
}
test('complete migration installs twice without dependencies or changed policies',async()=>{
 const f=await fixture();try{await f.db.exec(migration);assert.deepEqual(await f.read('category'),{items:[],has_more:false,next_cursor:null});
 const procs=await f.db.query("select prosecdef from pg_proc where proname like 'traffic_planner_%'");assert.ok(procs.rows.every(r=>r.prosecdef===false));
 assert.equal((await f.db.query("select has_function_privilege('anon','traffic_planner_post_assign(text,text,text,bigint,double precision,bigint,bigint)','execute') yes")).rows[0].yes,false);
 assert.equal((await f.db.query("select has_function_privilege('authenticated','traffic_planner_post_options(text,bigint,text,bigint,integer)','execute') yes")).rows[0].yes,true);
 }finally{await f.db.close();}
});
test('add creates one category and post, repeat emits no writes',async()=>{
 const f=await fixture();try{const a=await f.write('add',null,null,{category:' Цех ',name:' Пост '});
 assert.deepEqual(a,{status:'created',category:{category_id:1,category:'Цех'},post:{post_id:1,name:'Пост',category:1}});
 const writes=await f.count('writes');assert.equal((await f.write('add',null,null,{category:'цЕХ',name:'пОСТ'})).status,'unchanged');assert.equal(await f.count('writes'),writes);
 }finally{await f.db.close();}
});
test('same post name belongs independently to different categories and typed wildcards are literal',async()=>{
 const f=await fixture();try{await f.write('add',null,null,{category:'Цех_1',name:'Пост 100%'});await f.write('add',null,null,{category:'ЦехA1',name:'Пост 100%'});
 assert.equal(await f.count('post_category'),2);assert.equal(await f.count('post_name'),2);
 assert.equal((await f.read('category',null,'_')).items.length,1);assert.equal((await f.read('post',1,'%')).items.length,1);
 }finally{await f.db.close();}
});
test('edit patches only requested fields and does not rewrite unchanged rows',async()=>{
 const f=await fixture();try{await f.write('add',null,null,{category:'Цех',name:'Пост'});
 const a=await f.write('edit',1,1,{name:'Другий'},{name:'Пост',post_category:1});assert.equal(a.category.category,'Цех');assert.equal(a.post.name,'Другий');
 const n=await f.count('writes');assert.equal((await f.write('edit',1,1,{name:'Другий'},{name:'Пост',post_category:1})).status,'unchanged');assert.equal(await f.count('writes'),n);
 await f.write('edit',1,null,{category:'Новий цех'},{category:'Цех'});assert.equal((await f.read('post',1)).items[0].name,'Другий');
 }finally{await f.db.close();}
});
test('stale snapshots, missing baselines, wrong parent and missing explicit post fail closed',async()=>{
 const f=await fixture();try{await f.write('add',null,null,{category:'Цех',name:'Пост'});
 await assert.rejects(f.write('edit',1,1,{name:'Нове'},{name:'Старе',post_category:1}),/іншим/);
 await assert.rejects(f.write('edit',1,1,{name:'Нове'},{post_category:1}),/початкова/);
 await assert.rejects(f.write('edit',1,1,{name:'Нове'},{name:'Пост'}),/Прив’язка/);
 await assert.rejects(f.write('edit',2,1,{name:'Нове'},{name:'Пост',post_category:1}),/іншому/);
 await assert.rejects(f.write('edit',1,null,{name:'Нове'},{name:'Пост'}),/конкретний пост/);
 assert.equal((await f.read('post',1)).items[0].name,'Пост');
 }finally{await f.db.close();}
});
test('atomic category and post edit rolls category back when post conflicts',async()=>{
 const f=await fixture();try{await f.write('add',null,null,{category:'Цех',name:'Пост'});await f.write('add',1,null,{name:'Другий'});
 await assert.rejects(f.write('edit',1,1,{category:'Нове',name:'Другий'},{category:'Цех',name:'Пост',post_category:1}),/вже існує/);
 assert.equal((await f.read('category')).items[0].name,'Цех');assert.equal((await f.read('post',1)).items[0].name,'Пост');
 }finally{await f.db.close();}
});
test('duplicate legacy category/post names reject add instead of guessing first record',async()=>{
 const f=await fixture();try{await f.db.exec("insert into post_category values(1,'Цех'),(2,' цех ');insert into post_name values(1,'Пост',1),(2,' пост ',1);");
 await assert.rejects(f.write('add',null,null,{category:'Цех',name:'Пост'}),/Неоднозначна/);
 await assert.rejects(f.write('add',1,null,{name:'Пост'}),/Неоднозначна/);
 assert.equal((await f.read('post',1)).items.length,2);
 }finally{await f.db.close();}
});
test('deleting selected post preserves sibling and category, category with posts is blocked',async()=>{
 const f=await fixture();try{await f.write('add',null,null,{category:'Цех',name:'Пост'});await f.write('add',1,null,{name:'Другий'});
 await assert.rejects(f.write('delete',1,null,{}, {category:'Цех'}),/містить пости/);
 const r=await f.write('delete',1,1,{}, {name:'Пост',post_category:1});assert.equal(r.status,'deleted');assert.equal(r.post.post_id,1);
 assert.deepEqual((await f.read('post',1)).items,[{id:2,name:'Другий',category:1}]);assert.equal(await f.count('post_category'),1);
 await assert.rejects(f.write('delete',1,1,{}, {name:'Пост',post_category:1}),/не знайдено/);
 }finally{await f.db.close();}
});
test('post deletion respects any historical booking and assigned staff including legacy numeric formatting',async()=>{
 const f=await fixture();try{await f.write('add',null,null,{category:'Цех',name:'Пост'});
 await f.db.exec("insert into post_arxiv values(1,1,'Відремонтований');");await assert.rejects(f.write('delete',1,1,{}, {name:'Пост',post_category:1}),/історію/);
 await f.db.exec("delete from post_arxiv;insert into slyusars(data,post_sluysar) values('{\"Name\":\"Worker\"}','001');");
 await assert.rejects(f.write('delete',1,1,{}, {name:'Пост',post_category:1}),/працівником/);assert.equal(await f.count('post_name'),1);
 }finally{await f.db.close();}
});
test('delete refuses renamed snapshots and empty categories can be removed explicitly',async()=>{
 const f=await fixture();try{await f.write('add',null,null,{category:'Цех'});
 await assert.rejects(f.write('delete',1,null,{},{}),/Назва цеху/);await assert.rejects(f.write('delete',1,null,{}, {category:'Нове'}),/Назва цеху/);
 assert.equal((await f.write('delete',1,null,{}, {category:'Цех'})).status,'deleted');assert.equal(await f.count('post_category'),0);
 }finally{await f.db.close();}
});
test('assignment creates all three records in one RPC and exact retry writes nothing',async()=>{
 const f=await fixture();try{const a=await f.assign('Цех','Пост','Іван');assert.equal(a.status,'created');assert.equal(a.staff.name,'Іван');assert.equal(a.staff.post_sluysar,'1');
 const n=await f.count('writes');const again=await f.assign('Цех','Пост','Іван',a.staff.slyusar_id,9.9);assert.equal(again.status,'unchanged');assert.equal(again.staff.namber,1.1);assert.equal(await f.count('writes'),n);
 assert.equal(await f.count('post_category'),1);assert.equal(await f.count('slyusars'),1);
 }finally{await f.db.close();}
});
test('existing worker assignment touches only planner fields and returns no profile/history',async()=>{
 const f=await fixture();try{const original={Name:'Іван',Пароль:'secret',ПроцентРоботи:50,Історія:{old:'keep'},Опис:{large:'x'.repeat(10000)}};
 await f.db.query('insert into slyusars(slyusar_id,data) values(7,$1)',[JSON.stringify(original)]);
 const a=await f.assign('Цех','Пост','Іван',7);assert.equal(a.status,'updated');assert.deepEqual(a.staff,{slyusar_id:7,name:'Іван',namber:1.1,post_sluysar:'1'});
 assert.deepEqual((await f.db.query('select data from slyusars where slyusar_id=7')).rows[0].data,original);assert.ok(JSON.stringify(a).length<350);
 }finally{await f.db.close();}
});
test('assignment fails atomically for worker on another post, with no orphan category or post',async()=>{
 const f=await fixture();try{const a=await f.assign('Цех','Пост','Іван');
 await assert.rejects(f.assign('Інший цех','Інший пост','Іван',a.staff.slyusar_id),/іншого поста/);
 assert.equal(await f.count('post_category'),1);assert.equal(await f.count('post_name'),1);assert.equal(await f.count('slyusars'),1);
 }finally{await f.db.close();}
});
test('staff with identical names requires explicit ID; renamed ID cannot be silently reassigned',async()=>{
 const f=await fixture();try{await f.db.exec("insert into slyusars(slyusar_id,data) values(1,'{\"Name\":\"Іван\"}'),(2,'{\"Name\":\"Іван\"}');");
 await assert.rejects(f.assign('Цех','Пост','Іван'),/Неоднозначне/);
 assert.equal((await f.assign('Цех','Пост','Іван',2)).staff.slyusar_id,2);
 await assert.rejects(f.assign('Цех','Пост','Петро',1),/ПІБ/);await assert.rejects(f.assign('Цех','Пост','Іван',999),/не знайдено/);
 }finally{await f.db.close();}
});
test('legacy text staff JSON remains untouched and sequence is aligned for future direct inserts',async()=>{
 const f=await fixture();try{await f.db.exec("alter table slyusars alter data type text using data::text;insert into slyusars(slyusar_id,data) values(50,'{\"Name\":\"Old\",\"Історія\":{\"keep\":1}}');");
 const a=await f.assign('Цех','Пост','New');assert.equal(a.staff.slyusar_id,51);
 const next=(await f.db.query("insert into slyusars(data) values('{\"Name\":\"Direct\"}') returning slyusar_id")).rows[0].slyusar_id;assert.equal(next,52);
 await f.assign('Цех','Пост','Old',50,1.2);assert.equal((await f.db.query('select data from slyusars where slyusar_id=50')).rows[0].data,'{"Name":"Old","Історія":{"keep":1}}');
 }finally{await f.db.close();}
});
test('lazy options have bounded ID-keyset pages and never serialize staff secrets/history',async()=>{
 const f=await fixture();try{await f.db.exec("insert into slyusars(slyusar_id,data) select n,jsonb_build_object('Name','Worker '||n,'Пароль','secret','Історія',repeat('X',10000)) from generate_series(1,80)n;");
 const a=await f.read('staff');assert.equal(a.items.length,30);assert.equal(a.next_cursor,30);assert.equal(a.has_more,true);
 assert.deepEqual(Object.keys(a.items[0]).sort(),['id','name']);assert.ok(JSON.stringify(a).length<1500);
 const b=await f.read('staff',null,'',a.next_cursor);assert.equal(b.items[0].id,31);assert.equal(b.next_cursor,60);
 const c=await f.read('staff',null,'',b.next_cursor);assert.equal(c.items.length,20);assert.equal(c.has_more,false);assert.equal(c.next_cursor,null);
 assert.equal((await f.read('staff',null,'',null,10000)).items.length,50);await assert.rejects(f.read('post'),/виберіть цех/);
 }finally{await f.db.close();}
});
test('concurrent queued create requests resolve to one record and stale competing edit fails',async()=>{
 const f=await fixture();try{const results=await Promise.all(Array.from({length:6},()=>f.write('add',null,null,{category:'Цех',name:'Пост'})));
 assert.equal(results.filter(r=>r.status==='created').length,1);assert.equal(await f.count('post_name'),1);
 const changes=await Promise.allSettled([f.write('edit',1,1,{name:'A'},{name:'Пост',post_category:1}),f.write('edit',1,1,{name:'B'},{name:'Пост',post_category:1})]);assert.equal(changes.filter(r=>r.status==='fulfilled').length,1);
 }finally{await f.db.close();}
});
test('RLS denied writes do not report success and assignment failure rolls back new directories',async()=>{
 const f=await fixture();try{await f.write('add',null,null,{category:'Цех',name:'Пост'});
 await f.db.exec(`grant select,insert,update,delete on post_category,post_name,slyusars,post_arxiv,writes to authenticated;grant usage,select,update on sequence slyusars_slyusar_id_seq to authenticated;
 alter table post_category enable row level security;alter table post_name enable row level security;alter table slyusars enable row level security;
 create policy c_all on post_category for all to authenticated using(true) with check(true);
 create policy p_read on post_name for select to authenticated using(true);
 create policy s_read on slyusars for select to authenticated using(true);set role authenticated;`);
 await assert.rejects(f.write('edit',1,1,{name:'Changed'},{name:'Пост',post_category:1}),/підтвердила|доступу|policy|permission/i);
 await assert.rejects(f.write('delete',1,1,{}, {name:'Пост',post_category:1}),/підтвердила|доступу|policy|permission/i);
 await assert.rejects(f.assign('New','Post','Іван'),/policy|permission/i);
 await f.db.exec('reset role');assert.equal(await f.count('post_category'),1);assert.equal((await f.read('post',1)).items[0].name,'Пост');
 }finally{await f.db.close();}
});
test('invalid actions, patch metadata and invalid numeric order cannot mutate data',async()=>{
 const f=await fixture();try{
 await assert.rejects(f.write('edit',1,null,{category:'X',data:{history:0}}),/лише назви/);
 await assert.rejects(f.write('invalid'),/Некоректна/);await assert.rejects(f.write('add',null,null,{category:''}),/Назва/);
 for(const n of [null,0,-1,Infinity,NaN])await assert.rejects(f.assign('C','P','S',null,n),/Заповніть|double precision|invalid/);
 assert.equal(await f.count('post_category'),0);
 }finally{await f.db.close();}
});
test('explicit category/post IDs disambiguate names and stale selected labels cannot create replacements',async()=>{
 const f=await fixture();try{
 await f.db.exec("insert into post_category values(1,'Цех'),(2,'Цех');insert into post_name values(1,'Пост',2),(2,'Пост',2),(3,'Інший',1);");
 const a=await f.assign('Цех','Пост','Іван',null,1.1,2,2);assert.equal(a.category.category_id,2);assert.equal(a.post.post_id,2);
 await assert.rejects(f.assign('Цех','Старе ім’я','Петро',null,1.2,2,2),/пост змінився/);
 await assert.rejects(f.assign('Цех','Пост','Петро',null,1.2,1,2),/пост змінився/);
 await assert.rejects(f.assign('Старий цех','Пост','Петро',null,1.2,2,2),/цех змінився/);
 assert.equal(await f.count('post_name'),3);assert.equal(await f.count('slyusars'),1);
 }finally{await f.db.close();}
});
test('authenticated assignment catches up stale staff sequence with USAGE SELECT and no UPDATE privilege',async()=>{
 const f=await fixture();try{
 await f.db.exec(`insert into slyusars(slyusar_id,data) values(50,'{"Name":"Imported"}');
 grant select,insert,update,delete on post_category,post_name,slyusars,post_arxiv,writes to authenticated;
 grant usage,select on sequence slyusars_slyusar_id_seq to authenticated;set role authenticated;`);
 assert.equal((await f.db.query("select has_sequence_privilege(current_user,'slyusars_slyusar_id_seq','UPDATE') yes")).rows[0].yes,false);
 const a=await f.assign('C','P','New');assert.equal(a.staff.slyusar_id,51);
 assert.equal((await f.db.query("insert into slyusars(data) values('{\"Name\":\"Direct\"}') returning slyusar_id")).rows[0].slyusar_id,52);
 }finally{await f.db.close();}
});
test('large stale sequence gap is bounded and rerunning migration repairs counter without row changes',async()=>{
 const f=await fixture();try{
 await f.db.exec("insert into slyusars(slyusar_id,data) values(50000,'{\"Name\":\"Imported\"}');");
 await assert.rejects(f.assign('C','P','New'),/Повторно виконайте SQL/);assert.equal(await f.count('post_name'),0);assert.equal(await f.count('post_category'),0);
 await f.db.exec(migration);assert.equal(await f.count('slyusars'),1);assert.equal((await f.assign('C','P','New')).staff.slyusar_id,50001);
 }finally{await f.db.close();}
});
