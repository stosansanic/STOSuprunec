// Isolated database + mocked transports. No production connection or messages.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const {webcrypto}=require('node:crypto');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
const migration=fs.readFileSync('supabase/migrations/20261023114017_atlas_background_efficiency.sql','utf8');
function api(file,extra={}) {const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,crypto:webcrypto,TextEncoder,Uint8Array,setTimeout,clearTimeout,...extra});return exports;}
const delivery=api('supabase/functions/_shared/reminderDelivery.ts');
const digest=api('supabase/functions/check-reminders/resultDigest.ts');
async function fixture(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table slyusars(slyusar_id bigint primary key,data jsonb);
 insert into slyusars values(1,'{"Name":"A","Посада":"Слюсар"}'),(2,'{"Name":"B"}'),(3,'{"Name":"C"}');
 create table settings(setting_id bigint primary key,"Загальні" text);
 insert into settings values(18,'https://fixture.supabase.co');
 create table atlas_reminders(reminder_id bigint primary key,title text default 'Test',description text,status text default 'active',trigger_count integer default 0,created_by bigint default 1,channel text default 'both',recipients jsonb default '[1,2]',condition_query text,schedule jsonb default '{}',meta jsonb default '{}',last_triggered_at timestamptz,next_trigger_at timestamptz,reminder_type text default 'once',priority text default 'normal');
 create table atlas_reminder_logs(log_id bigserial primary key,reminder_id bigint references atlas_reminders on delete cascade,recipient_id bigint,channel text,message_text text,delivery_status text check(delivery_status in ('sent','delivered','read','failed','dismissed','callback')),error_message text,sent_at timestamptz default now(),delivered_at timestamptz);
 create function trigger_reminder(p_reminder_id bigint) returns void language sql as $$update atlas_reminders set trigger_count=trigger_count+1,status=case when reminder_type='once' then 'completed' else status end,next_trigger_at=case when reminder_type='once' then null else now()+interval '5 minutes' end where reminder_id=p_reminder_id$$;
 create function execute_condition_query(query_text text) returns jsonb language plpgsql as $$declare result jsonb;begin execute 'select jsonb_agg(q) from ('||query_text||') q' into result;return coalesce(result,'[]');end$$;
 create function traffic_atlas_object(p_value jsonb) returns jsonb language sql as $$select case when jsonb_typeof(p_value)='object' then p_value when jsonb_typeof(p_value)='string' then (p_value#>>'{}')::jsonb else '{}'::jsonb end$$;
 create schema cron; create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text);
 create function cron.schedule(job_name text,frequency text,cmd text) returns bigint language plpgsql as $$declare id bigint;begin insert into cron.job(jobname,schedule,command) values(job_name,frequency,cmd) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid into id;return id;end$$;
 create function cron.unschedule(id bigint) returns boolean language plpgsql as $$begin delete from cron.job where jobid=id;return found;end$$;
 create schema net;create table net.calls(url text,headers jsonb);
 create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin insert into net.calls values(url,headers);return 1;end$$;
 create function sync_atlas_reminder_cron_trigger() returns trigger language plpgsql as $$begin perform public.sync_atlas_reminder_cron_now();return null;end$$;
 create table updates_seen(id bigint);
 create function record_update() returns trigger language plpgsql as $$begin insert into updates_seen values(new.reminder_id);return new;end$$;
 create trigger record_update after update on atlas_reminders for each row execute function record_update();
 insert into atlas_reminders(reminder_id,next_trigger_at) values(1,now()-interval '1 minute');`);
 await db.exec(fs.readFileSync('supabase/migrations/20261011100000_reminder_delivery_claims.sql','utf8'));
 await db.exec(migration);
 const rpc={async rpc(name,args={}){try{const keys=Object.keys(args);return {data:(await db.query(`select public.${name}(${keys.map((key,i)=>`${key}=>$${i+1}`).join(',')}) v`,keys.map(key=>args[key]&&typeof args[key]==='object'?JSON.stringify(args[key]):args[key]))).rows[0].v,error:null}}catch(error){return {data:null,error}}}};
 async function call(name,args={}){const result=await rpc.rpc(name,args);if(result.error)throw result.error;return result.data;}
 async function row(){return (await call('traffic_reminder_candidates',{p_after:null})).items[0];}
 return {db,rpc,call,row};
}
function rule(r){return {condition_query:r.condition_query,schedule:r.schedule,recipients:r.recipients,channel:r.channel};}
function edge(client,send){const exports={};let handler;const source=fs.readFileSync('supabase/functions/check-reminders/index.ts','utf8');vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,require:name=>name.includes('reminderDelivery')?delivery:name.includes('resultDigest')?digest:name.includes('operationalLog')?{operationalLog(){}}:{createClient:()=>client},Deno:{serve(fn){handler=fn},env:{get:key=>key==='SUPABASE_URL'?'https://fixture.invalid':key==='SUPABASE_SERVICE_ROLE_KEY'?'fake':''}},console:{log(){},error(){}},fetch:send,Request,Response});return ()=>handler(new Request('https://fixture.invalid',{headers:{authorization:'fixture'}}));}
test('migration is repeatable; private leases do not update public reminders and only one caller wins',async()=>{
 const f=await fixture();try{
 await f.db.exec(migration);
 await f.db.exec(fs.readFileSync('supabase/setup/atlas-background/9.4 Атлас — фонові нагадування.sql','utf8'));
 const tokens=await Promise.all(Array.from({length:20},()=>f.call('claim_reminder_evaluation',{p_reminder_id:1,p_expected_trigger:0})));
 assert.equal(tokens.filter(Boolean).length,1);assert.equal((await f.db.query('select count(*)::int n from updates_seen')).rows[0].n,0);
 assert.equal(await f.call('finish_reminder_evaluation',{p_reminder_id:1,p_token:'stale',p_success:true}),false);
 await f.call('finish_reminder_evaluation',{p_reminder_id:1,p_token:tokens.find(Boolean),p_success:true});
 assert.equal((await f.db.query('select count(*)::int n from updates_seen')).rows[0].n,0);
 assert.equal((await f.call('traffic_reminder_candidates')).items.length,0);
 assert.equal((await f.db.query("select has_function_privilege('authenticated','public.traffic_reminder_candidates(bigint,timestamptz)','execute') v")).rows[0].v,false);
 }finally{await f.db.close()}
});
test('Cron makes no HTTP calls for future or paused reminders; due work dispatches to its configured project',async()=>{
 const f=await fixture();try{
 await f.db.exec("update atlas_reminders set next_trigger_at=now()+interval '1 day'");
 for(let i=0;i<10;i++)assert.equal(await f.call('traffic_dispatch_reminders'),false);
 assert.equal((await f.db.query('select count(*)::int n from net.calls')).rows[0].n,0);
 await f.db.exec("update atlas_reminders set next_trigger_at=now()-interval '1 second'");assert.equal(await f.call('traffic_dispatch_reminders'),true);
 assert.equal((await f.db.query('select url from net.calls')).rows[0].url,'https://fixture.supabase.co/functions/v1/check-reminders');
 await f.db.exec("update atlas_reminders set status='paused'");assert.equal(await f.call('traffic_dispatch_reminders'),false);
 assert.equal((await f.db.query('select count(*)::int n from cron.job')).rows[0].n,0);
 }finally{await f.db.close()}
});
test('unchanged SQL response is compact; SQL errors remain errors',async()=>{
 const f=await fixture();try{
 const first=await f.call('traffic_reminder_condition',{p_query:"select repeat('x',10000) body",p_previous_hash:null});assert.equal(first.unchanged,false);
 const again=await f.call('traffic_reminder_condition',{p_query:"select repeat('x',10000) body",p_previous_hash:first.hash});
 assert.equal(again.unchanged,true);assert.equal(again.rows,undefined);assert.ok(JSON.stringify(again).length<100);
 await assert.rejects(f.call('traffic_reminder_condition',{p_query:'select missing_column'}),/does not exist/);
 }finally{await f.db.close()}
});
test('app queue survives schedule advancement; recipients and Telegram have independent exactly-once claims',async()=>{
 const f=await fixture();try{
 const r=await f.row(),token=await f.call('claim_reminder_evaluation',{p_reminder_id:1,p_expected_trigger:0});
 const args={p_reminder_id:1,p_token:token,p_generation:'scheduled:0',p_expected_trigger:0,p_rule:rule(r),p_result_text:null};
 assert.equal(await f.call('traffic_reminder_queue_app',args),2);assert.equal(await f.call('traffic_reminder_queue_app',args),0);
 await f.call('trigger_reminder_generation',{p_reminder_id:1,p_expected_trigger:0});
 assert.equal((await f.call('traffic_reminder_app_inbox',{p_recipient_id:3})).items.length,0);
 let sends=0;
 for(const id of [1,2]){
  const item=(await f.call('traffic_reminder_app_inbox',{p_recipient_id:id})).items[0];assert.ok(item);
  const results=await Promise.all(Array.from({length:10},()=>delivery.deliverReminderOnce(f.rpc,item.app_payload,id,'app',async()=>{sends++;return 'delivered'},item.delivery_generation)));
  assert.equal(results.filter(v=>v==='delivered').length,1);
 }
 assert.equal(await delivery.deliverReminderOnce(f.rpc,r,1,'telegram',async()=>{sends++;return 'delivered'}),'delivered');
 assert.equal(sends,3);assert.equal((await f.call('traffic_reminder_app_inbox',{p_recipient_id:1})).items.length,0);
 }finally{await f.db.close()}
});
test('paused/edited rules cannot queue or checkpoint stale SQL results',async()=>{
 const f=await fixture();try{
 const r=await f.row(),token=await f.call('claim_reminder_evaluation',{p_reminder_id:1,p_expected_trigger:0});
 await f.db.exec("update atlas_reminders set recipients='[3]'");
 await assert.rejects(f.call('traffic_reminder_queue_app',{p_reminder_id:1,p_token:token,p_generation:'scheduled:0',p_expected_trigger:0,p_rule:rule(r)}),/rule changed/);
 assert.equal(await f.call('traffic_reminder_checkpoint',{p_reminder_id:1,p_token:token,p_rule:rule(r),p_patch:{last_result_hash:'stale'}}),false);
 assert.equal(await f.call('traffic_reminder_complete',{p_reminder_id:1,p_token:token,p_expected_trigger:0,p_rule:rule(r),p_patch:{}}),false);
 assert.equal((await f.db.query('select trigger_count from atlas_reminders')).rows[0].trigger_count,0);
 await f.db.exec("update atlas_reminders set reminder_type='conditional',schedule='{\"type\":\"realtime\"}',condition_query='{\"table\":\"acts\",\"events\":[\"UPDATE\"]}'");
 assert.equal((await f.call('traffic_reminder_watch_page',{p_recipient_id:1})).items.length,0);
 assert.equal((await f.call('traffic_reminder_watch_page',{p_recipient_id:3})).items.length,1);
 }finally{await f.db.close()}
});
test('actual Edge delivers both channels independently and never requires an open browser for Telegram',async()=>{
 const f=await fixture();try{
 let sent=0,settingReads=0;
 const client={...f.rpc,from(table){return {select(){return this},eq(){return this},in(){return this},maybeSingle(){return this},then(resolve,reject){if(table==='settings')settingReads++;return Promise.resolve({data:table==='settings'?{'Загальні':'fake'}:[{slyusar_id:1,telegram_chat_id:10},{slyusar_id:2,telegram_chat_id:20}],error:null}).then(resolve,reject)}}}};
 const run=edge(client,async()=>{sent++;return {ok:true,json:async()=>({ok:true})}});
 const responses=await Promise.all(Array.from({length:20},()=>run()));
 for(const response of responses)assert.equal((await response.json()).failed,0);
 assert.equal(sent,2);assert.equal(settingReads,1);
 for(const recipient of [1,2])assert.equal((await f.call('traffic_reminder_app_inbox',{p_recipient_id:recipient})).items.length,1);
 assert.equal((await f.db.query('select trigger_count from atlas_reminders')).rows[0].trigger_count,1);
 }finally{await f.db.close()}
});
test('existing Cron command and auth survive installation; app JSON event rules do not create HTTP polling',async()=>{
 const f=await fixture();try{
 const cmd="select net.http_post(url:='https://other.supabase.co/functions/v1/check-reminders',headers:='{\"Authorization\":\"fixture-only\"}'::jsonb,body:='{}',timeout_milliseconds:=5000)";
 await f.db.query('update cron.job set command=$1',[cmd]);await f.db.exec(migration);await f.call('traffic_dispatch_reminders');
 const result=(await f.db.query('select * from net.calls')).rows[0];assert.equal(result.url,'https://other.supabase.co/functions/v1/check-reminders');assert.equal(result.headers.Authorization,'fixture-only');
 await f.db.exec("update atlas_reminders set channel='app',reminder_type='conditional',schedule='{\"type\":\"realtime\"}',next_trigger_at=null,condition_query='{\"table\":\"acts\",\"events\":[\"UPDATE\"]}'");
 assert.equal((await f.call('traffic_reminder_candidates')).items.length,0);assert.equal(await f.call('traffic_dispatch_reminders'),false);
 assert.equal((await f.db.query('select count(*)::int n from cron.job')).rows[0].n,0);
 }finally{await f.db.close()}
});
test('browser snapshots contain only paged recipient JSON watches, without result metadata or scheduled reminders',async()=>{
 const f=await fixture();try{
 await f.db.exec("insert into atlas_reminders(reminder_id,recipients) select n,'[1]'::jsonb from generate_series(2,206) n");
 assert.equal((await f.call('traffic_reminder_watch_page',{p_recipient_id:1})).items.length,0);
 await f.db.exec("update atlas_reminders set reminder_type='conditional',schedule='{\"type\":\"realtime\"}',condition_query='{\"table\":\"acts\",\"events\":[\"UPDATE\"]}',meta=jsonb_build_object('last_result_hash',repeat('x',10000))");
 let after=null;const ids=[];for(;;){const page=await f.call('traffic_reminder_watch_page',{p_recipient_id:1,p_after:after});assert.ok(page.items.length<=100);ids.push(...page.items.map(x=>x.reminder_id));if(!page.has_more)break;after=page.next_cursor;}
 assert.equal(new Set(ids).size,206);const page=await f.call('traffic_reminder_watch_page',{p_recipient_id:2});assert.equal(page.items.length,1);assert.deepEqual(page.items[0].meta,{});
 }finally{await f.db.close()}
});
test('SQL watches do not allocate unconditional row-change streams',()=>{
 const {buildReminderWatchGroups}=api('src/ts/roboha/ai/reminderRealtime.ts');
 const rules=[{reminder_type:'conditional',schedule:{type:'realtime'},condition_query:'select * from acts'}];
 assert.equal(buildReminderWatchGroups(rules,()=>true).size,0);
});
test('actual Edge handles app-only without bot settings; bad SQL cannot block another reminder',async()=>{
 const f=await fixture();try{
 await f.db.exec("update atlas_reminders set channel='app';insert into atlas_reminders(reminder_id,channel,reminder_type,condition_query,next_trigger_at) values(2,'app','conditional','select nonexistent',now())");
 const client={...f.rpc,from(){throw Error('No bot settings read for app-only')}};
 const run=edge(client,async()=>{throw Error('No external send')});
 const response=await run();assert.equal(response.status,200);const result=await response.json();assert.equal(result.failed,1);
 assert.equal((await f.call('traffic_reminder_app_inbox',{p_recipient_id:1})).items.length,1);
 assert.equal((await f.db.query('select status from atlas_reminders where reminder_id=1')).rows[0].status,'completed');
 assert.equal((await f.db.query('select trigger_count from atlas_reminders where reminder_id=2')).rows[0].trigger_count,0);
 }finally{await f.db.close()}
});
test('legacy result baseline upgrades once without repeat delivery and later stays compact',async()=>{
 const f=await fixture();try{
 const previous=await digest.reminderResultDigest(JSON.stringify([{n:1}]));
 await f.db.query("update atlas_reminders set channel='app',reminder_type='conditional',schedule='{\"type\":\"realtime\"}',next_trigger_at=null,condition_query='select 1 n',meta=$1",[JSON.stringify({last_result_hash:previous})]);
 let conditions=[];const client={async rpc(name,args){const result=await f.rpc.rpc(name,args);if(name==='traffic_reminder_condition')conditions.push(result.data);return result},from(){throw Error('No bot')}};
 const run=edge(client,async()=>{throw Error('No send')});await run();
 assert.equal((await f.db.query('select count(*)::int n from atlas_reminder_logs')).rows[0].n,0);
 assert.match((await f.db.query('select meta from atlas_reminders')).rows[0].meta.last_result_hash,/^pg-md5:/);
 await f.db.exec("update sto_atlas_private.evaluations set lease_until=now()-interval '1 second'");await run();
 assert.equal(conditions.length,2);assert.equal(conditions[1].unchanged,true);assert.equal(conditions[1].rows,undefined);
 }finally{await f.db.close()}
});
test('inbox coalesces bursts, stops while hidden and reads cursor pages only on demand',async()=>{
 const {createReminderInbox}=api('src/ts/roboha/ai/reminderInbox.ts');let active=false;const reads=[],delivered=[],errors=[];
 const inbox=createReminderInbox({isActive:()=>active,read:async after=>{reads.push(after);return after===null?{items:[1,2],has_more:true,next_cursor:2}:{items:[3],has_more:false,next_cursor:3}},deliver:async item=>{delivered.push(item)},onError:e=>errors.push(e)});
 const wait=()=>new Promise(resolve=>setTimeout(resolve,200));
 inbox.wake();await wait();assert.equal(reads.length,0);
 active=true;for(let i=0;i<20;i++)inbox.wake();await wait();assert.deepEqual(reads,[null,2]);assert.deepEqual(delivered,[1,2,3]);
 await wait();assert.equal(reads.length,2);assert.equal(errors.length,0);inbox.dispose();inbox.wake();await wait();assert.equal(reads.length,2);
});
