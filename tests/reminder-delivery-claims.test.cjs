// Isolated SQL and transport mocks only. Never sends real notifications.
const { test }=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const {webcrypto}=require('node:crypto');
function helper(){const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('supabase/functions/_shared/reminderDelivery.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,crypto:webcrypto,TextEncoder,Uint8Array});return api;}
function edge(fetch,client){const api={};const source=fs.readFileSync('supabase/functions/check-reminders/index.ts','utf8')+'\nexport {sendTelegramReminder,executeConditionQuery};';vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:name=>name.includes('reminderDelivery')?helper():name.includes('operationalLog')?{operationalLog(){}}:name.includes('resultDigest')?digest():{createClient:()=>client},Deno:{serve(handler){api.run=handler},env:{get(key){return key==='SUPABASE_URL'?'https://fixture.invalid':key==='SUPABASE_SERVICE_ROLE_KEY'?'fixture-service':''}}},fetch,console:{log(){},error(){}},Date,JSON,Request,Response});return api;}
function digest(){const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('supabase/functions/check-reminders/resultDigest.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,crypto:webcrypto,TextEncoder,Uint8Array});return api;}
async function fixture(){
 const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table slyusars(slyusar_id bigint primary key,data jsonb);
 insert into slyusars values(1,'{"Посада":"Слюсар"}'),(2,'{}'),(3,'{}');
 create table atlas_reminders(reminder_id bigint primary key,title text,status text,trigger_count integer,created_by bigint,channel text,recipients jsonb,condition_query text,schedule jsonb,meta jsonb,last_triggered_at timestamptz);
 create table atlas_reminder_logs(log_id bigserial primary key,reminder_id bigint references atlas_reminders on delete cascade,recipient_id bigint,channel text,message_text text,delivery_status text check(delivery_status in ('sent','delivered','read','failed','dismissed','callback')),error_message text,sent_at timestamptz default now(),delivered_at timestamptz);
 create function trigger_reminder(p_reminder_id bigint) returns void language sql as $$update atlas_reminders set trigger_count=trigger_count+1 where reminder_id=p_reminder_id$$;
 insert into atlas_reminders values(1,'Reminder','active',0,1,'both','[1,2]',null,'{"type":"interval","minutes":5}','{}',null);`);
 await db.exec(fs.readFileSync('supabase/migrations/20261011100000_reminder_delivery_claims.sql','utf8'));
 const reminder={reminder_id:1,trigger_count:0,condition_query:null,schedule:{type:'interval',minutes:5},recipients:[1,2],channel:'both'};
 const rpc={async rpc(name,args){try{const keys=Object.keys(args);const values=keys.map(k=>args[k]&&typeof args[k]==='object'?JSON.stringify(args[k]):args[k]);return {data:(await db.query(`select ${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) v`,values)).rows[0].v,error:null}}catch(error){return {data:null,error}}}};
 return {db,reminder,rpc};
}
test('20 concurrent callers send once, recipients and app/telegram remain independent',async()=>{
 const {db,reminder,rpc}=await fixture(),h=helper();try{
 let sends=0;const send=async()=>{sends++;return 'delivered'};
 const results=await Promise.all(Array.from({length:20},()=>h.deliverReminderOnce(rpc,reminder,1,'telegram',send)));
 assert.equal(sends,1);assert.equal(results.filter(v=>v==='delivered').length,1);
 await h.deliverReminderOnce(rpc,reminder,2,'telegram',send);await h.deliverReminderOnce(rpc,reminder,1,'app',send);assert.equal(sends,3);
 assert.equal(await h.deliverReminderOnce(rpc,reminder,3,'telegram',send),'skipped');
 const advances=await Promise.all(Array.from({length:20},()=>rpc.rpc('trigger_reminder_generation',{p_reminder_id:1,p_expected_trigger:0})));
 assert.equal(advances.filter(r=>r.data===true).length,1);
 // Same occurrence can finish a recipient/channel fan-out after advancement.
 assert.equal(await h.deliverReminderOnce(rpc,reminder,2,'app',send),'delivered');
 const fresh={...reminder,trigger_count:1};assert.equal(await h.deliverReminderOnce(rpc,fresh,1,'app',send),'delivered');
 assert.equal(await h.deliverReminderOnce(rpc,{...reminder,trigger_count:99},1,'app',send),'skipped');
 assert.equal((await db.query('select count(*)::int n from atlas_reminder_logs')).rows[0].n,5);
 }finally{await db.close()}
});
test('lease recovery rejects stale tokens; ambiguous started sends are never auto-retried',async()=>{
 const {db,reminder,rpc}=await fixture(),h=helper();try{
 const args={...h.occurrenceArgs(reminder),p_recipient_id:1,p_channel:'telegram'};
 const first=(await rpc.rpc('claim_reminder_delivery',args)).data;
 await db.exec("update atlas_reminders set meta='{\"overwritten\":true}';update atlas_reminder_logs set delivery_lease_until=now()-interval '1 second'");
 const second=(await rpc.rpc('claim_reminder_delivery',args)).data;assert.notEqual(first.token,second.token);
 assert.equal((await rpc.rpc('start_reminder_delivery',{p_reminder_id:1,p_token:first.token})).data,false);
 assert.equal((await rpc.rpc('finish_reminder_delivery',{p_reminder_id:1,p_token:first.token,p_outcome:'delivered'})).data,false);
 assert.equal((await rpc.rpc('start_reminder_delivery',{p_reminder_id:1,p_token:second.token})).data,true);
 await db.exec("update atlas_reminder_logs set delivery_lease_until=now()-interval '1 second'");
 assert.equal((await rpc.rpc('claim_reminder_delivery',args)).data,null);
 assert.equal((await db.query('select delivery_phase from atlas_reminder_logs')).rows[0].delivery_phase,'unknown');
 // A late explicit provider confirmation can reconcile its own token only.
 assert.equal((await rpc.rpc('finish_reminder_delivery',{p_reminder_id:1,p_token:second.token,p_outcome:'delivered'})).data,true);
 assert.equal((await rpc.rpc('claim_reminder_delivery',args)).data,null);
 let attempts=0;assert.equal(await h.deliverReminderOnce(rpc,reminder,2,'telegram',async()=>{attempts++;throw Error('timeout')}),'unknown');
 assert.equal(await h.deliverReminderOnce(rpc,reminder,2,'telegram',async()=>{attempts++;return 'delivered'}),'skipped');assert.equal(attempts,1);
 assert.equal(await h.deliverReminderOnce(rpc,reminder,1,'app',async()=>'failed'),'failed');
 const pending=(await db.query("select log_id,delivery_token from atlas_reminder_logs where delivery_phase='unknown'")).rows[0];
 assert.ok((await rpc.rpc('allow_reminder_delivery_retry',{p_log_id:pending.log_id,p_expected_token:pending.delivery_token,p_confirm_not_delivered:false})).error);
 assert.equal((await rpc.rpc('allow_reminder_delivery_retry',{p_log_id:pending.log_id,p_expected_token:pending.delivery_token,p_confirm_not_delivered:true})).data,true);
 assert.equal((await rpc.rpc('finish_reminder_delivery',{p_reminder_id:1,p_token:pending.delivery_token,p_outcome:'delivered'})).data,false);
 assert.equal(await h.deliverReminderOnce(rpc,reminder,2,'telegram',async()=>{attempts++;return 'delivered'}),'delivered');assert.equal(attempts,2);
 }finally{await db.close()}
});
test('actual Edge sender uses atomic claims and validates Telegram JSON; SQL errors do not advance as false conditions',async()=>{
 const {db,reminder,rpc}=await fixture();try{
 let sends=0;const api=edge(async()=>{sends++;return {ok:true,json:async()=>({ok:true})}});
 const client={...rpc,from(table){assert.equal(table,'atlas_telegram_users');return {select(){return this},in(){return this},async eq(){return {data:[{slyusar_id:1,telegram_chat_id:100},{slyusar_id:2,telegram_chat_id:200}],error:null}}}}};
 const payload={...reminder,title:'Test',description:null,priority:'normal',reminder_type:'recurring',created_by:1,creator_name:'Creator',meta:{}};
 await Promise.all(Array.from({length:20},()=>api.sendTelegramReminder(client,'FAKE',payload)));assert.equal(sends,2);
 assert.equal((await db.query("select count(*)::int n from atlas_reminder_logs where delivery_phase='delivered' and message_text like '%Test%'")).rows[0].n,2);
 await assert.rejects(api.executeConditionQuery({rpc:async()=>({data:null,error:Error('database unavailable')})},'select 1'),/database unavailable/);
 assert.equal(await api.executeConditionQuery({rpc:async()=>({data:{unchanged:false,hash:"pg-md5:empty",rows:[]},error:null})},'select 1'),null);
 }finally{await db.close()}
});
test('realtime generations count once; cleanup retains live identities, parent cascade still works',async()=>{
 const {db,reminder,rpc}=await fixture(),h=helper();try{
 reminder.schedule={type:'realtime'};await db.exec("update atlas_reminders set schedule='{\"type\":\"realtime\"}'");
 const generation=await h.eventGeneration(['2026-10-11T10:00Z','UPDATE',{id:5,value:2}]);
 await h.deliverReminderOnce(rpc,reminder,1,'app',async()=>'delivered',generation);
 await h.deliverReminderOnce(rpc,reminder,2,'telegram',async()=>'delivered',generation);
 assert.equal((await db.query('select trigger_count from atlas_reminders')).rows[0].trigger_count,1);
 const next=await h.eventGeneration(['2026-10-11T10:00:01Z','UPDATE',{id:5,value:3}]);
 assert.notEqual(generation,next);await h.deliverReminderOnce(rpc,reminder,1,'app',async()=>'delivered',next);
 assert.equal((await db.query('select trigger_count from atlas_reminders')).rows[0].trigger_count,2);
 await db.exec('delete from atlas_reminder_logs');assert.equal((await db.query('select count(*)::int n from atlas_reminder_logs')).rows[0].n,3);
 await db.exec("update atlas_reminder_logs set delivery_lease_until=now()-interval '1 day';delete from atlas_reminder_logs");assert.equal((await db.query('select count(*)::int n from atlas_reminder_logs')).rows[0].n,0);
 await h.deliverReminderOnce(rpc,reminder,1,'app',async()=>'delivered',await h.eventGeneration(['another event']));
 await db.exec('delete from atlas_reminders');assert.equal((await db.query('select count(*)::int n from atlas_reminder_logs')).rows[0].n,0);
 }finally{await db.close()}
});
test('recipient resolver forms and changed rule guard preserve intended recipients',async()=>{
 const {db,reminder,rpc}=await fixture(),h=helper();try{
 for(const [recipients,id,yes] of [['self',1,true],['self',2,false],['all',2,true],['"all"',2,true],['mechanics',1,true],['mechanics',2,false],[[1,2],2,true],['[1,2]',2,true],['broken',1,true]]){
  assert.equal((await db.query('select reminder_recipient_matches($1,1,$2) v',[JSON.stringify(recipients),id])).rows[0].v,yes);
 }
 await db.exec("update atlas_reminders set recipients='[2]'");assert.equal(await h.deliverReminderOnce(rpc,reminder,1,'app',async()=>'delivered'),'skipped');
 await assert.rejects(h.deliverReminderOnce({rpc:async()=>({data:null,error:Error('RPC missing')})},reminder,1,'app',async()=>{throw Error('must not send')}),/RPC missing/);
 }finally{await db.close()}
});
test('server evaluation lease coalesces 20 checks and recovers after crash without claiming app delivery',async()=>{
 const {db,reminder,rpc}=await fixture(),h=helper();try{
 const claims=await Promise.all(Array.from({length:20},()=>rpc.rpc('claim_reminder_evaluation',{p_reminder_id:1,p_expected_trigger:0})));
 const winners=claims.filter(r=>r.data);assert.equal(winners.length,1);
 assert.equal(await h.deliverReminderOnce(rpc,reminder,1,'app',async()=>'delivered'),'delivered');
 await db.exec("update atlas_reminders set evaluation_lease_until=now()-interval '1 second'");
 const next=(await rpc.rpc('claim_reminder_evaluation',{p_reminder_id:1,p_expected_trigger:0})).data;assert.ok(next);assert.notEqual(next,winners[0].data);
 assert.equal((await rpc.rpc('finish_reminder_evaluation',{p_reminder_id:1,p_token:winners[0].data,p_success:true})).data,false);
 assert.equal((await rpc.rpc('finish_reminder_evaluation',{p_reminder_id:1,p_token:next,p_success:true})).data,true);
 assert.equal((await rpc.rpc('claim_reminder_evaluation',{p_reminder_id:1,p_expected_trigger:0})).data,null);
 }finally{await db.close()}
});
test('actual Edge handler: empty exits after candidate page; 20 active requests evaluate a rule once',async()=>{
 const {db,reminder,rpc}=await fixture();try{
 let active=false,reads=0,evaluations=0,sends=0;
 reminder.condition_query='select 1';await db.exec("update atlas_reminders set condition_query='select 1'");
 const payload={...reminder,title:'Rule',description:null,priority:'normal',reminder_type:'conditional',created_by:1,creator_name:'Creator',meta:{}};
 const client={async rpc(name,args){if(name==='traffic_reminder_candidates')return {data:{items:active?[payload]:[],has_more:false,next_cursor:null},error:null};if(name==='traffic_reminder_complete')return rpc.rpc('trigger_reminder_generation',{p_reminder_id:args.p_reminder_id,p_expected_trigger:args.p_expected_trigger});if(name==='traffic_reminder_queue_app'||name==='traffic_reminder_checkpoint')return {data:true,error:null};if(name==='traffic_reminder_condition'){evaluations++;return {data:{unchanged:false,hash:'pg-md5:first',rows:[{count:1}]},error:null}}return rpc.rpc(name,args)},from(table){let head=false;return {select(_columns,options){head=!!options?.head;return this},eq(){return this},in(){return this},not(){return this},update(){return this},maybeSingle(){return this},then(resolve,reject){reads++;let result={error:null};if(head)result.count=active?1:0;else if(table==='settings')result.data={'Загальні':'FAKE'};else if(table==='atlas_reminders')result.data=[];else if(table==='atlas_telegram_users')result.data=[{slyusar_id:1,telegram_chat_id:100},{slyusar_id:2,telegram_chat_id:200}];return Promise.resolve(result).then(resolve,reject)}}}};
 const api=edge(async()=>{sends++;return {ok:true,json:async()=>({ok:true})}},client);
 const request=()=>new Request('https://edge.invalid',{headers:{authorization:'Bearer fixture'}});
 assert.equal((await api.run(request())).status,200);assert.equal(reads,0);assert.equal(evaluations,0);assert.equal(sends,0);
 active=true;const responses=await Promise.all(Array.from({length:20},()=>api.run(request())));for(const response of responses)assert.equal(response.status,200,await response.text());
 assert.equal(evaluations,1);assert.equal(sends,2);assert.equal((await db.query('select trigger_count from atlas_reminders')).rows[0].trigger_count,1);
 }finally{await db.close()}
});


test('public browser reminder entry points do not start dormant scheduled SQL polling',()=>{
 const ts=require('typescript');const source=fs.readFileSync('src/ts/roboha/ai/aiReminderChecker.ts','utf8');
 const ast=ts.createSourceFile('aiReminderChecker.ts',source,99,true);
 const functions=new Map(ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name).map(n=>[n.name.text,n]));
 const roots=[...functions].filter(([,n])=>n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).map(([name])=>name);
 const seen=new Set();const walk=name=>{if(seen.has(name))return;seen.add(name);const fn=functions.get(name);if(!fn?.body)return;const visit=n=>{if(ts.isIdentifier(n)&&functions.has(n.text))walk(n.text);ts.forEachChild(n,visit)};visit(fn.body)};roots.forEach(walk);
 assert.ok(seen.has('performServerReminderCheck'),'scheduled checks use Edge transport');
 assert.ok(!seen.has('checkDueReminders'),'no browser due-query polling can be reintroduced silently');
 assert.ok(!seen.has('checkCondition'),'SQL condition evaluation remains on server');
});
