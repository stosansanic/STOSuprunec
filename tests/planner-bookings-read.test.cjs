const {test}=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function readers(){
 const store={},api={};
 const load=(file,exports,require)=>vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,require,setTimeout,clearTimeout});
 load('src/ts/roboha/planyvannya/plannerRecordStore.ts',store,()=>({supabase:{}}));
 load('src/ts/roboha/planyvannya/plannerBookingsRead.ts',api,name=>name.endsWith('plannerRecordStore')?store:{supabase:{}});
 return{api,store};
}
test('planner readers share pending range and page all bookings',async()=>{
 const {api,store}=readers();
 let calls=0;const client={rpc:async(_name,args)=>{calls++;await new Promise(r=>setTimeout(r,5));return {data:{items:Array.from({length:args.p_offset===0?200:5},(_,i)=>({post_arxiv_id:args.p_offset+i+1,data_on:'2026-10-01T09:00:00Z',client_data:{ПІБ:'Client'},car_data:{Авто:'Car'}})),has_more:args.p_offset===0}}}};
 const args=['2026-10-01','2026-10-07',null,client];const [a,b]=await Promise.all([api.readPlannerBookings(...args),api.readPlannerBookings(...args)]);assert.equal(a,b);assert.equal(a.length,205);assert.equal(calls,2);
 await api.readPlannerBookings(...args);assert.equal(calls,4);
 assert.equal(store.getPlannerRecord(205).client_data.ПІБ,'Client');
});
test('planner booking errors do not produce empty successful calendar',async()=>{
 const {api}=readers();
 await assert.rejects(api.readPlannerBookings('a','b',null,{rpc:async()=>({error:{code:'42501'}})}),e=>e.code==='42501');
});
test('planner booking SQL projects labels, pages and applies table RLS',async()=>{
 const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();
 try {
 await db.exec(`create role anon;create role authenticated;
 create table clients(client_id bigint primary key,data jsonb);
 create table cars(cars_id bigint primary key,data jsonb,is_deleted boolean);
 create table post_arxiv(post_arxiv_id bigint primary key,slyusar_id bigint,name_post bigint,client_id text,cars_id text,status text,data_on timestamptz,data_off timestamptz,komentar text,act_id bigint,xto_zapusav text);
 insert into clients values(1,'{"ПІБ":"Клієнт","Телефон 2":"0500","secret":"large"}');
 insert into cars values(1,'{"Авто":"Ford","Номер авто":"AA1","history":"large"}',false);
 insert into post_arxiv select n,1,1,'1','1','Запланований','2026-10-01 09:00Z','2026-10-01 10:00Z','test',null,'user' from generate_series(1,205) n;`);
 const sql=fs.readFileSync('supabase/migrations/20261011050000_traffic_planner_bookings.sql','utf8');await db.exec(sql);await db.exec(sql);
 const run=async(offset=0)=>(await db.query("select traffic_planner_bookings('2026-10-01','2026-10-07',null,$1) v",[offset])).rows[0].v;
 const page=await run();assert.equal(page.items.length,200);assert.equal(page.has_more,true);assert.equal(page.items[0].client_data.secret,undefined);assert.equal(page.items[0].client_data['Телефон 2'],'0500');assert.equal(page.items[0].car_data.history,undefined);assert.equal(page.items[0].version.length,32);assert.equal((await run(200)).items.length,5);
 await db.exec('alter table post_arxiv enable row level security;grant select on post_arxiv,clients,cars to authenticated;create policy own on post_arxiv for select to authenticated using(post_arxiv_id=1);set role authenticated');
 assert.equal((await run()).items.length,1);
 } finally { await db.close() }
});
test('planner changes outside visible dates only refresh affected calendar months',async()=>{
 const source=fs.readFileSync('src/ts/roboha/planyvannya/planyvannya.ts','utf8');const ast=ts.createSourceFile('planner.ts',source,ts.ScriptTarget.Latest,true);let method;
 function visit(node){if(ts.isMethodDeclaration(node)&&node.name.getText(ast)==='refreshChangedPlannerDates')method=node.getText(ast);ts.forEachChild(node,visit)}visit(ast);assert.ok(method);
 const exports={};vm.runInNewContext(ts.transpileModule('export class Probe {'+method+'}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Date,Set});
 const app=new exports.Probe(),calls=[];Object.assign(app,{isWeekView:false,selectedDate:new Date(2026,9,10),viewYear:2026,viewMonth:9,postArxiv:{clearAllBlocks:()=>calls.push('clear'),loadArxivDataForCurrentDate:async()=>calls.push('day')},refreshOccupancyIndicatorsForDates:async dates=>calls.push(dates.join(','))});
 await app.refreshChangedPlannerDates(['2026-12-10']);assert.equal(calls.length,0);
 await app.refreshChangedPlannerDates(['2026-10-20']);assert.deepEqual(calls,['2026-10-20']);calls.length=0;
 await app.refreshChangedPlannerDates(['2026-10-10','2026-11-01']);assert.deepEqual(calls,['clear','day','2026-10-10,2026-11-01']);
});
