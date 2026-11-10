const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const api={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/planyvannya/plannerOccupancyRead.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:()=>({supabase:{}}),Intl,Date,Map});
const start=new Date('2026-10-01T00:00:00Z'),end=new Date('2026-11-01T00:00:00Z');
test('planner aggregate uses one RPC and no booking rows',async()=>{
 let calls=0;const rows=await api.readPlannerOccupancy(start,end,{rpc:async(name,args)=>{calls++;assert.equal(name,'traffic_planner_occupancy');assert.equal(args.p_start,start.toISOString());return {data:[{day:'2026-10-02',post:1,minutes:60}]}}});
 assert.equal(calls,1);assert.equal(rows[0].minutes,60);
});
test('planner permissions fail without broad fallback',async()=>{
 await assert.rejects(api.readPlannerOccupancy(start,end,{rpc:async()=>({error:{code:'42501'}})}),e=>e.code==='42501');
});
test('planner SQL aggregates same per-booking rounding and respects RLS',async()=>{
 const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();
 try{
 await db.exec(`create role anon; create role authenticated;
 create table post_arxiv (name_post bigint,data_on timestamptz,data_off timestamptz);
 insert into post_arxiv values (1,'2026-10-02 09:00Z','2026-10-02 09:10:30Z'),(1,'2026-10-02 09:05Z','2026-10-02 09:20Z'),(2,'2026-10-02 09:00Z','2026-10-02 10:00Z'),(1,'2026-09-02 09:00Z','2026-09-02 10:00Z');`);
 const sql=fs.readFileSync('supabase/migrations/20261011040000_traffic_planner_occupancy.sql','utf8');await db.exec(sql);await db.exec(sql);
 const run=async()=> (await db.query("select traffic_planner_occupancy('2026-10-01','2026-11-01','Europe/Kyiv') v")).rows[0].v;
 const rows=await run();assert.equal(rows.length,2);assert.equal(rows[0].minutes,26);assert.equal(rows[1].minutes,60);
 await db.exec('alter table post_arxiv enable row level security; grant select on post_arxiv to authenticated; create policy only_one on post_arxiv for select to authenticated using(name_post=2); set role authenticated');
 assert.equal((await run()).length,1);
 await assert.rejects(db.query("select traffic_planner_occupancy('2026-01-01','2026-11-01','Europe/Kyiv')"));
 }finally{await db.close()}
});

function realtimeFixture() {
 const handlers = {}, events = {}, timers = new Map(), statuses = [], refreshes = [], changes = [];
 let created = 0, removed = 0, active = 0, timerId = 0;
 const addEventListener = (name, fn) => (handlers[name] ||= []).push(fn);
 const runEvent = (name, value = {}) => (handlers[name] || []).forEach(fn => fn(value));
 const setTimer = fn => { timers.set(++timerId, fn); return timerId; };
 const clearTimer = id => timers.delete(id);
 const sb = {
  channel() { created++; active++; return {
   on(_type, filter, cb) { events[filter.event] = cb; return this; },
   subscribe(cb) { statuses.push(cb); return this; },
  }; },
  removeChannel() { removed++; active--; },
  from() { throw Error('Realtime fixture unexpectedly requested full record data'); },
 };
 const document = { hidden:false, addEventListener, getElementById:id=>id==='postSchedulerWrapper'?{}:null, querySelector:()=>null, querySelectorAll:()=>[] };
 const window = { addEventListener, setTimeout:setTimer, clearTimeout:clearTimer,
  parseCurrentDate:()=> '2026-11-01',
  refreshPlannerCalendar:async dates=>refreshes.push(dates),
  applyPlannerRecordChanges:async records=>changes.push(records),
 };
 const context = { document, window, localStorage:{getItem:()=>'{"Name":"me"}'}, setTimeout:setTimer, clearTimeout:clearTimer };
 const load = (file, exports, require) => vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{...context,exports,require});
 const registry={subscribe(resource,listener,status){
  const channel=sb.channel().on('postgres_changes',{event:'*'},listener).subscribe(status);
  for(const type of ['INSERT','UPDATE','DELETE'])events[type]=payload=>listener({...payload,eventType:type});
  return {unsubscribe:()=>sb.removeChannel(channel)};
 }};
 const store = {}, api = {};
 load('src/ts/roboha/planyvannya/plannerRecordStore.ts',store,()=>({supabase:sb}));
 load('src/ts/roboha/planyvannya/planyvannya_realtime.ts',api,name=>name.endsWith('plannerRecordStore')?store:name.endsWith('databaseSubscriptions')?{databaseSubscriptions:registry}:{supabase:sb});
 return {api,store,events,timers,statuses,refreshes,changes,runEvent,document,
  get created(){return created;}, get removed(){return removed;}, get active(){return active;},
  async flush(){const pending=[...timers.values()];timers.clear();for(const fn of pending)fn();for(let i=0;i<30;i++)await Promise.resolve();},
 };
}

test('planner realtime repeated lifecycle removes channels and reconciliation timers',async()=>{
 const f=realtimeFixture();
 for(let i=0;i<20;i++){f.api.initPostArxivRealtimeSubscription();f.api.unsubscribeFromPostArxivRealtime();}
 assert.equal(f.created,20);assert.equal(f.removed,20);assert.equal(f.active,0);
 // A late status from a disposed channel cannot enqueue work.
 f.statuses[0]('SUBSCRIBED');assert.equal(f.timers.size,0);
 f.api.initPostArxivRealtimeSubscription();f.statuses.at(-1)('SUBSCRIBED');assert.equal(f.timers.size,1);
 f.runEvent('pagehide');assert.equal(f.active,0);assert.equal(f.timers.size,0);
 f.runEvent('pageshow',{persisted:true});assert.equal(f.active,1);
 // Reconciliation begins on a successful subscription, not on pageshow itself.
 assert.equal(f.timers.size,0);f.statuses.at(-1)('SUBSCRIBED');assert.equal(f.timers.size,1);
 await f.flush();assert.equal(f.refreshes.length,1);assert.equal(f.refreshes[0],undefined);
 f.runEvent('pagehide');assert.equal(f.active,0);assert.equal(f.timers.size,0);
});

test('planner realtime batches record patches with old/new dates and reconciles unknown deletes',async()=>{
 const f=realtimeFixture();f.api.initPostArxivRealtimeSubscription();
 const updated={post_arxiv_id:1,data_on:'2026-11-01T12:00Z',data_off:'2026-11-01T13:00Z',xto_zapusav:'me',client_id:null,cars_id:null};
 f.events.UPDATE({new:updated,old:{post_arxiv_id:1,data_on:'2026-10-31T12:00Z',data_off:'2026-10-31T13:00Z'}});
 f.events.INSERT({new:{post_arxiv_id:2,data_on:'2026-11-02T12:00Z',data_off:'2026-11-02T13:00Z',xto_zapusav:'me',client_id:null,cars_id:null}});
 assert.equal(f.timers.size,1);await f.flush();assert.equal(f.changes.length,1);assert.equal(f.refreshes.length,0);
 assert.equal(f.changes[0].length,2);
 assert.match(f.changes[0][0].previous.data_on,/^2026-10-31/);
 assert.match(f.changes[0][0].record.data_on,/^2026-11-01/);
 assert.match(f.changes[0][1].record.data_on,/^2026-11-02/);
 // The echo of the already applied local/remote row causes no second render.
 f.events.UPDATE({new:updated,old:{post_arxiv_id:1}});assert.equal(f.timers.size,0);
 f.events.DELETE({old:{post_arxiv_id:9}});assert.equal(f.timers.size,1);await f.flush();
 assert.equal(f.refreshes.length,0);assert.equal(f.changes.at(-1)[0].reconcileOccupancy,true);
});


test('planner hidden lifecycle releases transport and reconciles once after return',async()=>{
 const f=realtimeFixture();f.api.initPostArxivRealtimeSubscription();f.statuses.at(-1)('SUBSCRIBED');await f.flush();
 f.document.hidden=true;f.runEvent('visibilitychange');assert.equal(f.active,0);
 const reads=f.refreshes.length;f.document.hidden=false;f.runEvent('visibilitychange');assert.equal(f.active,1);
 f.statuses.at(-1)('SUBSCRIBED');f.statuses.at(-1)('SUBSCRIBED');await f.flush();assert.equal(f.refreshes.length,reads+1);
 f.api.unsubscribeFromPostArxivRealtime();f.runEvent('visibilitychange');assert.equal(f.active,0);
});

test('unknown planner updates use projected previous membership and legacy occupancy-only fallback',async()=>{
 const f=realtimeFixture();f.api.initPostArxivRealtimeSubscription();
 const next={post_arxiv_id:80,data_on:'2026-12-01T12:00Z',data_off:'2026-12-01T13:00Z',name_post:2,slyusar_id:2,xto_zapusav:'me',client_id:null,cars_id:null};
 f.events.UPDATE({new:{...next,traffic_previous:{data_on:'2026-11-01T12:00Z',data_off:'2026-11-01T13:00Z',name_post:1,slyusar_id:1}},old:{post_arxiv_id:80}});
 await f.flush();assert.equal(f.refreshes.length,0);assert.equal(f.changes[0][0].previous.name_post,1);assert.equal(f.changes[0][0].reconcileOccupancy,false);
 f.events.UPDATE({new:{...next,post_arxiv_id:81},old:{post_arxiv_id:81}});await f.flush();assert.equal(f.refreshes.length,0);assert.equal(f.changes[1][0].reconcileOccupancy,true);
});


test('planner applies an unknown deletion by ID and reads occupancy aggregates without booking reload',async()=>{
 const source=fs.readFileSync('src/ts/roboha/planyvannya/planyvannya.ts','utf8'),ast=ts.createSourceFile('planner.ts',source,ts.ScriptTarget.Latest,true);let method;
 function visit(node){if(ts.isMethodDeclaration(node)&&node.name.getText(ast)==='applyRecordChanges')method=node.getText(ast);ts.forEachChild(node,visit)}visit(ast);
 const exports={},calls=[];vm.runInNewContext(ts.transpileModule('export class Probe {'+method+'}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,localStorage:{getItem:()=> 'owner'},getPlannerRecord:()=>undefined,isPlannerRecordDeleted:()=>true,plannerDateKey:d=>d.toISOString().slice(0,10)});
 const app=new exports.Probe();Object.assign(app,{calendarGrid:{querySelectorAll:()=>[{remove:()=>calls.push('remove')}]},postArxiv:{isInteracting:()=>false,applyRecordChange:change=>calls.push(change.type)},invalidateOccupancy:()=>calls.push('invalidate'),refreshOccupancyIndicators:async()=>calls.push('aggregate'),refreshOccupancyIndicatorsForDates:async()=>calls.push('dates')});
 await app.applyRecordChanges([{type:'DELETE',record:{post_arxiv_id:99},reconcileOccupancy:true}]);assert.deepEqual(calls,['remove','DELETE','invalidate','aggregate']);
});
