const {test}=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function load(context={}){const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/utils/databaseSubscriptions.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:()=>({supabase:{}}),setTimeout,clearTimeout,...context});return api;}
function transport(){const channels=[],removed=[];return {channels,removed,channel(){const item={bindings:[],on(kind,filter,cb){this.bindings.push({kind,filter,cb});if(kind==='postgres_changes'){this.filter=filter;this.event=cb}else if(kind==='system')this.system=cb;return this},subscribe(cb){this.status=cb;return this},ready(){this.status('SUBSCRIBED');this.system({extension:'postgres_changes',status:'ok'})}};channels.push(item);return item},removeChannel(channel){removed.push(channel)}}}
function clock(){let serial=0;const timers=new Map();return {timers,setTimeout(callback,ms){const id=++serial;timers.set(id,{callback,ms});return id},clearTimeout(id){timers.delete(id)},run(){const work=[...timers.values()];timers.clear();work.forEach(item=>item.callback())}};}
test('registry shares acts transport over twenty modal open/close cycles',()=>{
 const api=load(),client=transport(),registry=api.createDatabaseSubscriptionRegistry(client),events=[];
 const global=registry.subscribe({table:'acts',event:'UPDATE'},p=>events.push(['global',p]),undefined,'actor');
 for(let i=0;i<20;i++){const modal=registry.subscribe({table:'acts',event:'UPDATE'},p=>events.push(['modal',p]),undefined,'actor');client.channels[0].event({new:{act_id:i}});modal.unsubscribe();modal.unsubscribe()}
 assert.equal(client.channels.length,1);assert.equal(client.removed.length,0);assert.equal(events.length,40);global.unsubscribe();assert.equal(client.removed.length,1);assert.equal(registry.size(),0);client.channels[0].event({new:{act_id:99}});assert.equal(events.length,40);
});
test('registry isolates access scopes, filters, and independent identical callback consumers',()=>{
 const client=transport(),registry=load().createDatabaseSubscriptionRegistry(client),cb=()=>{};
 const a=registry.subscribe({table:'acts'},cb,undefined,'a'),b=registry.subscribe({table:'acts'},cb,undefined,'a');
 registry.subscribe({table:'acts'},cb,undefined,'b');registry.subscribe({table:'acts',filter:'act_id=eq.1'},cb,undefined,'a');assert.equal(client.channels.length,3);a.unsubscribe();assert.equal(client.removed.length,0);b.unsubscribe();assert.equal(client.removed.length,1);
});
test('registry suspends page transports and rejects stale callbacks after BFCache resume',()=>{
 const client=transport(),registry=load().createDatabaseSubscriptionRegistry(client),events=[],statuses=[];
 const sub=registry.subscribe({table:'acts'},p=>events.push(p),s=>statuses.push(s),'actor');const old=client.channels[0];registry.pause();assert.equal(client.removed.length,1);assert.deepEqual(statuses,['CLOSED']);registry.resume();assert.equal(client.channels.length,2);old.event(1);client.channels[1].ready();client.channels[1].event(2);assert.deepEqual(events,[2]);assert.deepEqual(statuses,['CLOSED','SUBSCRIBED']);sub.unsubscribe();
});
test('settings burst refresh reads once and later event during pending read gets one followup',async()=>{
 const source=fs.readFileSync('src/ts/roboha/zakaz_naraudy/inhi/settings_subscription.ts','utf8');const ast=ts.createSourceFile('s.ts',source,ts.ScriptTarget.Latest,true);const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='scheduleSettingsRefresh').getText(ast);
 let callback,release,reads=0,updates=0;const context={setTimeout:fn=>{callback=fn;return 1},refreshSettingsCache:()=>{reads++;return new Promise(r=>release=()=>r(true))},updateUIBasedOnSettings:async()=>{updates++},showSettingsNotification(){},resetSettingsRefreshRecovery(){},planSettingsRefreshRecovery(){},settingsRecoveryNeeded:false,settingsRefreshQueued:false,settingsNotifyQueued:false,settingsRefreshTimer:null,settingsRefreshPending:null,settingsGeneration:1,settingsChannel:{}};
 vm.runInNewContext(ts.transpileModule(fn,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,context);
 for(let i=0;i<10;i++)context.scheduleSettingsRefresh();callback();assert.equal(reads,1);context.scheduleSettingsRefresh();release();await new Promise(r=>setImmediate(r));assert.equal(reads,2);release();await new Promise(r=>setImmediate(r));assert.equal(updates,2);
});
test('settings ignores identical/AI-only payloads but preserves simultaneous role changes',async()=>{
 const source=fs.readFileSync('src/ts/roboha/zakaz_naraudy/inhi/settings_subscription.ts','utf8'),ast=ts.createSourceFile('s.ts',source,ts.ScriptTarget.Latest,true);
 const helper={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/utils/settingsUiChanges.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:helper});
 const tracker=helper.createSettingsUiChangeTracker('Адміністратор');const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='handleSettingsChange').getText(ast);let reads=0;const context={scheduleSettingsRefresh:()=>reads++,currentSettingsTracker:()=>tracker,settingsRecoveryNeeded:false};vm.runInNewContext(ts.transpileModule(fn,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,context);
 await context.handleSettingsChange({eventType:'UPDATE',new:{setting_id:1,data:{a:true}},old:{setting_id:1,data:{a:true}}});assert.equal(reads,0);
 await context.handleSettingsChange({eventType:'UPDATE',new:{setting_id:1,token:2,data:true},old:{setting_id:1,token:1,data:true}});assert.equal(reads,0);
 await context.handleSettingsChange({eventType:'UPDATE',new:{setting_id:1,token:2,data:true},old:{setting_id:1,token:1,data:false}});assert.equal(reads,1);
});
test('silent act broadcast refresh serializes a burst and retains one latest followup',async()=>{
 const source=fs.readFileSync('src/ts/roboha/zakaz_naraudy/modalMain.ts','utf8'),ast=ts.createSourceFile('m.ts',source,ts.ScriptTarget.Latest,true);
 const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='refreshActTableSilently').getText(ast);let reads=0,release;const context={exports:{},realtimeActSnapshot:{wasApplied:()=>false},refreshActTableSilentlyOnce:()=>{reads++;return new Promise(r=>release=r)}};
 vm.runInNewContext(ts.transpileModule('const silentActRefreshes=new Map();'+fn,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
 const first=context.exports.refreshActTableSilently(1);for(let i=0;i<10;i++)context.exports.refreshActTableSilently(1);assert.equal(reads,1);release();await new Promise(r=>setImmediate(r));assert.equal(reads,2);release();await first;assert.equal(reads,2);
});

const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('projected resources share a single capability read and canonical column set',async()=>{
 const client=transport();let probes=0;client.rpc=async()=>{probes++;return {data:{version:1},error:null}};
 const registry=load().createDatabaseSubscriptionRegistry(client);
 const a=registry.subscribe({table:'acts',select:['traffic_state','act_id']},()=>{},undefined,'actor');
 const b=registry.subscribe({table:'acts',select:['act_id','traffic_state','act_id']},()=>{},undefined,'actor');
 const c=registry.subscribe({table:'settings',select:['setting_id','data']},()=>{},undefined,'actor');
 await flush();assert.equal(probes,1);assert.equal(client.channels.length,2);
 assert.deepEqual(Array.from(client.channels[0].filter.select),['act_id','traffic_state']);
 a.unsubscribe();b.unsubscribe();c.unsubscribe();assert.equal(registry.size(),0);
});
test('pending projection probe cannot subscribe a closed modal or a suspended page',async()=>{
 const client=transport();let resolve;client.rpc=()=>new Promise(r=>resolve=r);
 const registry=load().createDatabaseSubscriptionRegistry(client),sub=registry.subscribe({table:'acts',select:['act_id']},()=>{});
 await flush();sub.unsubscribe();resolve({data:{version:1}});await flush();assert.equal(client.channels.length,0);
 const sub2=registry.subscribe({table:'acts',select:['act_id']},()=>{});registry.pause();await flush();assert.equal(client.channels.length,0);
 registry.resume();await flush();assert.equal(client.channels.length,1);sub2.unsubscribe();
});
test('missing migration and rejected projection retain functioning legacy delivery',async()=>{
 for(const available of [false,true]){
   const client=transport();client.rpc=async()=>available?{data:{version:1}}:{error:{code:'PGRST202'}};
   const registry=load().createDatabaseSubscriptionRegistry(client),seen=[];
   const sub=registry.subscribe({table:'acts',select:['act_id','traffic_state']},p=>seen.push(p));await flush();
   const initial=client.channels[0];
   if(available){initial.status('CHANNEL_ERROR');await flush();assert.equal(client.channels.length,2);initial.event('stale');}
   const active=client.channels.at(-1);assert.equal(active.filter.select,undefined);active.event('current');
   assert.deepEqual(seen,['current']);sub.unsubscribe();
 }
});
test('late consumer receives shared status once and disposed status callbacks are ignored',async()=>{
 const client=transport(),registry=load().createDatabaseSubscriptionRegistry(client),states=[];
 const a=registry.subscribe({table:'acts'},()=>{},undefined,'a');client.channels[0].ready();
 const b=registry.subscribe({table:'acts'},()=>{},s=>states.push(s),'a');await flush();assert.deepEqual(states,['SUBSCRIBED']);
 const c=registry.subscribe({table:'acts'},()=>{},s=>states.push('stale:'+s),'a');c.unsubscribe();await flush();
 assert.deepEqual(states,['SUBSCRIBED']);a.unsubscribe();b.unsubscribe();
});
test('late ready replay cannot overwrite a newer disconnect or reconnect status',async()=>{
 const client=transport(),registry=load().createDatabaseSubscriptionRegistry(client),states=[];
 const a=registry.subscribe({table:'acts'},()=>{},undefined,'a');client.channels[0].ready();
 const b=registry.subscribe({table:'acts'},()=>{},s=>states.push(s),'a');
 client.channels[0].status('CHANNEL_ERROR');await flush();assert.deepEqual(states,['CHANNEL_ERROR']);
 client.channels[0].ready();assert.deepEqual(states,['CHANNEL_ERROR','SUBSCRIBED']);
 a.unsubscribe();b.unsubscribe();
});

test('socket join and PostgreSQL acknowledgement are both required, in either order',()=>{
 for(const systemFirst of [false,true]){
  const timers=clock(),client=transport(),registry=load(timers).createDatabaseSubscriptionRegistry(client),states=[];
  const sub=registry.subscribe({table:'acts'},()=>{},s=>states.push(s));const channel=client.channels[0];
  assert.deepEqual(channel.bindings.map(b=>b.kind),['system','postgres_changes']);
  channel.system({extension:'presence',status:'ok'});assert.deepEqual(states,[]);
  if(systemFirst){channel.system({extension:'postgres_changes',status:'ok'});assert.deepEqual(states,[]);channel.status('SUBSCRIBED');}
  else{channel.status('SUBSCRIBED');assert.deepEqual(states,[]);assert.equal(timers.timers.size,1);channel.system({extension:'postgres_changes',status:'ok'});}
  assert.deepEqual(states,['SUBSCRIBED']);assert.equal(timers.timers.size,0);
  channel.ready();channel.system({extension:'postgres_changes',status:'ok'});assert.deepEqual(states,['SUBSCRIBED']);sub.unsubscribe();
 }
});

test('legacy readiness timeout releases waits without claiming ready; first row recovers exactly once',()=>{
 const timers=clock(),client=transport(),registry=load(timers).createDatabaseSubscriptionRegistry(client),seen=[];
 const sub=registry.subscribe({table:'acts'},p=>seen.push(['event',p]),s=>seen.push(['status',s]));const channel=client.channels[0];
 channel.status('SUBSCRIBED');assert.equal([...timers.timers.values()][0].ms,3000);assert.deepEqual(seen,[]);
 timers.run();assert.deepEqual(seen,[['status','TIMED_OUT']]);assert.equal(client.removed.length,0);
 channel.status('SUBSCRIBED');assert.equal(timers.timers.size,0);
 channel.event({id:1});channel.event({id:2});channel.system({extension:'postgres_changes',status:'ok'});
 assert.deepEqual(seen,[['status','TIMED_OUT'],['status','SUBSCRIBED'],['event',{id:1}],['event',{id:2}]]);sub.unsubscribe();
});

test('legacy readiness timeout also recovers through a late system acknowledgement',()=>{
 const timers=clock(),client=transport(),registry=load(timers).createDatabaseSubscriptionRegistry(client),states=[];
 const sub=registry.subscribe({table:'acts'},()=>{},s=>states.push(s));const channel=client.channels[0];
 channel.status('SUBSCRIBED');timers.run();channel.system({extension:'postgres_changes',status:'ok'});
 assert.deepEqual(states,['TIMED_OUT','SUBSCRIBED']);sub.unsubscribe();
});

test('extension failure recovers on the same joined legacy socket, while socket failure requires a new join',()=>{
 const timers=clock(),client=transport(),registry=load(timers).createDatabaseSubscriptionRegistry(client),states=[];
 const sub=registry.subscribe({table:'acts'},()=>{},s=>states.push(s));const channel=client.channels[0];
 channel.ready();channel.system({extension:'postgres_changes',status:'error'});channel.system({extension:'postgres_changes',status:'ok'});
 assert.deepEqual(states,['SUBSCRIBED','CHANNEL_ERROR','SUBSCRIBED']);assert.equal(client.channels.length,1);
 channel.status('CHANNEL_ERROR');channel.system({extension:'postgres_changes',status:'ok'});
 assert.deepEqual(states,['SUBSCRIBED','CHANNEL_ERROR','SUBSCRIBED','CHANNEL_ERROR']);
 channel.status('SUBSCRIBED');assert.equal(states.at(-1),'SUBSCRIBED');assert.equal(states.length,5);assert.equal(timers.timers.size,0);sub.unsubscribe();
});

test('projected extension rejection clears its timer and falls back only once',async()=>{
 const timers=clock(),client=transport(),states=[];client.rpc=async()=>({data:{version:1}});
 const registry=load(timers).createDatabaseSubscriptionRegistry(client),sub=registry.subscribe({table:'acts',select:['act_id']},()=>{},s=>states.push(s));await flush();
 const old=client.channels[0];old.status('SUBSCRIBED');const stale=[...timers.timers.values()][0].callback;
 old.system({extension:'postgres_changes',status:'error'});assert.equal(timers.timers.size,0);assert.equal(client.removed.length,1);assert.equal(client.channels.length,2);
 stale();old.system({extension:'postgres_changes',status:'ok'});assert.deepEqual(states,['CHANNEL_ERROR']);
 const fallback=client.channels[1];assert.equal(fallback.filter.select,undefined);fallback.ready();
 fallback.system({extension:'postgres_changes',status:'error'});fallback.system({extension:'postgres_changes',status:'ok'});
 assert.equal(client.channels.length,2);assert.deepEqual(states,['CHANNEL_ERROR','SUBSCRIBED','CHANNEL_ERROR','SUBSCRIBED']);sub.unsubscribe();
});

test('pause and final disposal clear readiness timers and reject stale system/timer callbacks',()=>{
 const timers=clock(),client=transport(),registry=load(timers).createDatabaseSubscriptionRegistry(client),states=[];
 const sub=registry.subscribe({table:'acts'},()=>{},s=>states.push(s));const old=client.channels[0];old.status('SUBSCRIBED');const stale=[...timers.timers.values()][0].callback;
 registry.pause();assert.equal(timers.timers.size,0);stale();old.system({extension:'postgres_changes',status:'ok'});assert.deepEqual(states,['CLOSED']);
 registry.resume();const current=client.channels[1];current.status('SUBSCRIBED');const disposed=[...timers.timers.values()][0].callback;
 sub.unsubscribe();assert.equal(timers.timers.size,0);disposed();current.ready();assert.deepEqual(states,['CLOSED']);assert.equal(registry.size(),0);
});
