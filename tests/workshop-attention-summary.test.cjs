const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function compile(file,require=()=>({})){const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require,structuredClone});return api;}
const act=compile('src/ts/utils/actSafeWrite.ts'),frozen=compile('src/ts/utils/actFrozenState.ts'),workshop=compile('src/ts/roboha/workshop/model.ts');
const model=compile('src/ts/roboha/workshop/attentionModel.ts',name=>name.includes('actSafeWrite')?act:name.includes('actFrozen')?frozen:workshop);
test('attention SQL rules match current JS scope, prices, frozen and malformed workshop cases',async()=>{
 const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();
 try{
 await db.exec('create role anon;create role authenticated');await db.exec(fs.readFileSync('supabase/migrations/20261011090000_traffic_attention_overview.sql','utf8'));
 const sections=[undefined,{version:1,defects:[],recommendations:[{id:'a',state:'proposed'},{id:'b',state:'approved'},{id:'c',state:'completed'}]},{version:2,defects:[],recommendations:[]},{version:1,defects:[{id:'a'},{id:'a'}],recommendations:[]}];
 let id=0;
 for(const role of ['Адміністратор','Приймальник','Слюсар','Запчастист','Складовщик'])for(const section of sections)for(const closed of [false,true]){
 const row={act_id:++id,date_off:closed?'2026-10-01':null,pruimalnyk:'me',slusarsOn:true,data:{Роботи:[{Робота:'Repair',Слюсар:'me',Ціна:'12,50'},{Робота:'Other',Слюсар:'',Ціна:0},{Робота:'',Ціна:null}],Деталі:[{Деталь:'Part',Ціна:'no'}],__payroll_pending:true,...(section?{__workshop_v1:section}:{})}};
 const scope={role,name:'me',prices:true};let expected,warning=false,permitted=false;
 try{permitted=model.isActInAttentionScope(row,scope);expected=model.inspectActAttention(row,scope)}catch{expected=[];warning=true}
 const actual=(await db.query('select traffic_attention_act_rules($1,$2,$3,true) v',[JSON.stringify(row),role,'me'])).rows[0].v;
 assert.deepEqual(actual.items,JSON.parse(JSON.stringify(expected)),JSON.stringify({role,closed,section}));assert.equal(!!actual.warning,warning);assert.equal(actual.permitted,permitted);
 }
 const unusual=[null,[],"bad JSON",{Заморожений:true,__workshop_v1:{version:99}},{Роботи:[{Робота:'X',Слюсар:'me',Ціна:1},null]},{Роботи:[null,{Робота:'X',Слюсар:'me',Ціна:1}]},{Роботи:[{Робота:'\u00a0',Слюсар:'',Ціна:0}]},JSON.stringify({Роботи:[{Робота:'Legacy',Ціна:0}]})];
 for(const body of unusual)for(const role of ['Адміністратор','Слюсар','Приймальник']){
   const row={act_id:999,pruimalnyk:'me',date_off:null,data:body},scope={role,name:'me',prices:true};let expected=[],warning=false,permitted=false;
   try{permitted=model.isActInAttentionScope(row,scope);expected=model.inspectActAttention(row,scope)}catch{warning=true}
   const actual=(await db.query('select traffic_attention_act_rules($1,$2,$3,true) v',[JSON.stringify(row),role,'me'])).rows[0].v;
   assert.deepEqual(actual.items,JSON.parse(JSON.stringify(expected)),JSON.stringify({body,role}));assert.equal(!!actual.warning,warning,JSON.stringify({body,role}));assert.equal(actual.permitted,permitted,JSON.stringify({body,role}));
 }
 for(const price of ['',null,0,false,true,' 12,5 ','0x10','0b11','0o17','1e2','1e999','NaN','Infinity',-1,[2],[],{},'1,2,3','1\u00a0234']){
 const expected=Number(String(price??'').replace(/\s/g,'').replace(',','.'));const actual=(await db.query('select traffic_attention_positive_price($1) v',[JSON.stringify(price)])).rows[0].v;assert.equal(actual,Number.isFinite(expected)&&expected>0,JSON.stringify(price));
 }
 }finally{await db.close()}
});
test('attention overview returns counts and reason pages without full act documents and honors RLS',async()=>{
 const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create table acts(act_id bigint primary key,data jsonb,pruimalnyk text,date_off timestamptz,"slusarsOn" boolean);create table sclad(sclad_id bigint,name text,akt integer,statys text);create table post_arxiv(post_arxiv_id bigint,name_post bigint,data_on timestamptz,status text,xto_zapusav text);
 insert into acts select n,jsonb_build_object('Роботи',jsonb_build_array(jsonb_build_object('Робота','work','Ціна',1)),'private',repeat('X',10000)),'me',null,false from generate_series(1,205)n;
 insert into sclad values(1,'Part',1,'Замовлено');insert into post_arxiv values(1,1,'2026-10-11 10:00Z','Запланований','me');`);
 await db.exec(fs.readFileSync('supabase/migrations/20261011090000_traffic_attention_overview.sql','utf8'));
 const read=async(category='',offset=0)=>(await db.query("select traffic_attention_overview('Адміністратор','me',true,true,true,true,'2026-10-11','2026-10-13',$1,$2) v",[category,offset])).rows[0].v;
 let page=await read();assert.equal(page.total,207);assert.equal(page.items.length,200);assert.equal(page.has_more,true);assert.equal(page.counts.Виконавці,205);assert.ok(!JSON.stringify(page).includes('private'));
 page=await read('Деталі');assert.equal(page.items.length,1);assert.equal(page.items[0].actId,1);page=await read('',200);assert.equal(page.items.length,7);assert.equal(page.has_more,false);
 await db.exec('alter table acts enable row level security;grant select on acts,sclad,post_arxiv to authenticated;create policy one on acts for select to authenticated using(act_id=1);set role authenticated');assert.equal((await read()).total,3);
 }finally{await db.close()}
});
test('workshop cache coalesces, expires, clones and rejects invalidated pending data',async()=>{
 const cache=compile('src/ts/roboha/workshop/resourceCache.ts').createWorkshopResourceCache(()=>clock);let clock=0,reads=0,release;
 const load=async()=>{reads++;return {value:1}};const [a,b]=await Promise.all([cache.read('car',load),cache.read('car',load)]);assert.equal(reads,1);a.value=2;assert.equal(b.value,1);assert.equal((await cache.read('car',load)).value,1);clock=15001;await cache.read('car',load);assert.equal(reads,2);
 const pending=cache.read('other',()=>new Promise(r=>release=r));cache.invalidate();release({value:1});await assert.rejects(pending,/Дані змінилися/);
});
