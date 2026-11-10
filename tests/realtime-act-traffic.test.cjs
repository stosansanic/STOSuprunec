const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const root='src/ts/roboha/zakaz_naraudy/';
function load(file,context={}) {const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(root+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,require:()=>({supabase:{}}),structuredClone,console,...context});return exports;}
const flush=()=>new Promise(setImmediate);
function channelClient() {
 const channels=[],removed=[];
 return {channels,removed,channel(topic){const channel={topic,events:[],tracks:[],untracks:0,on(kind,filter,callback){this.events.push({kind,filter,callback});return this},subscribe(callback){this.status=callback;return this},async track(value){this.tracks.push(value)},async untrack(){this.untracks++},presenceState(){return {other:[{actId:9,userName:'Other'}]}}};channels.push(channel);return channel},removeChannel(channel){removed.push(channel);return Promise.resolve()}};
}
test('presence observer + editor share a channel; closing editor keeps table observer',async()=>{
 const client=channelClient(),hub=load('actPresenceHub.ts').createActPresenceHub(client),states=[];
 const release=hub.observe(s=>states.push(s));await hub.setEditor(10,'Me');assert.equal(client.channels.length,1);
 client.channels[0].status('SUBSCRIBED');await flush();assert.equal(client.channels[0].tracks.length,1);
 client.channels[0].events[0].callback();assert.equal(states.length,1);
 await hub.clearEditor();assert.equal(client.channels[0].untracks,1);assert.equal(client.removed.length,0);
 await hub.setEditor(11,'Me');assert.equal(client.channels.length,1);assert.equal(client.channels[0].tracks.at(-1).actId,11);
 await hub.clearEditor();release();assert.equal(client.removed.length,1);
});
test('close before channel join never publishes stale editing presence',async()=>{
 const client=channelClient(),hub=load('actPresenceHub.ts').createActPresenceHub(client);
 await hub.setEditor(10,'Me');await hub.clearEditor();client.channels[0].status('SUBSCRIBED');await flush();
 assert.equal(client.channels[0].tracks.length,0);assert.equal(client.removed.length,1);
 await hub.setEditor(20,'Me');client.channels[1].status('SUBSCRIBED');await flush();assert.equal(client.channels[1].tracks[0].actId,20);
});
test('presence recovery has one active topic and repopulates current editor',async()=>{
 const client=channelClient(),hub=load('actPresenceHub.ts').createActPresenceHub(client);
 hub.observe(()=>{});await hub.setEditor(10,'Me');client.channels[0].status('SUBSCRIBED');await flush();
 hub.suspend();hub.resume();client.channels[1].status('SUBSCRIBED');await flush();
 assert.equal(client.channels.length,2);assert.equal(client.removed.length,1);assert.equal(client.channels[1].tracks[0].actId,10);
});
test('compact status preserves previous frozen/date state without pulling work arrays',()=>{
 const normalize=load('actRealtimeState.ts').normalizeActRealtimeChange;
 const result=normalize({new:{act_id:1,date_off:'2026-10-23',traffic_state:{frozen:false,summary:{'За роботу':100},previous:{date_off:null,frozen:true}}},old:{act_id:1}});
 assert.equal(result.current.data['За роботу'],100);assert.equal(result.current.data['Заморожений'],false);
 assert.equal(result.previous.date_off,null);assert.equal(result.previous.data['Заморожений'],true);assert.equal(result.current.data['Роботи'],undefined);
 const legacy={act_id:2,data:{'Роботи':[]}};assert.equal(normalize({new:legacy}).current,legacy);
});

test('compact completion of an unloaded act announces once with a PK-only OLD row',()=>{
 const normalize=load('actRealtimeState.ts').normalizeActRealtimeChange;
 const ast=ts.createSourceFile('tablucya.ts',fs.readFileSync('src/ts/roboha/tablucya/tablucya.ts','utf8'),99,true);
 const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='applySlusarCompletionRecord');
 const notices=[],context={exports:{},observedCompletionStates:new Map(),completionRevisions:new Map(),completionRevision:0,completionOwner:'owner',actsGlobal:[],
  localStorage:{getItem:()=> 'owner'},isActFrozen:act=>act.data?.Заморожений===true,userAccessLevel:'Адміністратор',
  updateFrozenRowInDom(){},updateSlusarsOnRowInDom(){},showAppMessage:(...args)=>notices.push(args)};
 vm.runInNewContext(ts.transpileModule(fn.getText(ast)+'\nexports.apply=applySlusarCompletionRecord;',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
 const payload={new:{act_id:99,slusarsOn:true,date_off:null,traffic_state:{frozen:false,previous:{date_off:null,frozen:false}}},old:{act_id:99}};
 const {current,previous}=normalize(payload);assert.equal(Object.hasOwn(previous,'slusarsOn'),false);
 context.exports.apply(current,previous);context.exports.apply(current,previous);assert.equal(notices.length,1);
 payload.new.traffic_state.previous.slusarsOn=false;assert.equal(normalize(payload).previous.slusarsOn,false);
});
test('saved snapshot reuse requires exact act/revision and deduplicates already rendered revisions',()=>{
 const cache=load('actRealtimeSnapshot.ts').createActRealtimeSnapshot();cache.reset(3);
 cache.remember({act_id:3,data:{__act_revision:'one',Роботи:[]}});
 assert.equal(cache.get(3,'one').act_id,3);assert.equal(cache.get(3,'two'),null);assert.equal(cache.get(4,'one'),null);
 cache.markApplied(cache.get(3,'one'));assert.equal(cache.wasApplied(3,'one'),true);
 cache.remember({act_id:3,data:{__act_revision:'one',Роботи:[],Пробіг:123}});
 assert.equal(cache.wasApplied(3,'one'),false);
 cache.reset(4);assert.equal(cache.wasApplied(3,'one'),false);assert.equal(cache.get(3,'one'),null);
});
test('staff refresh uses equality, not ordering, and photo/mileage changes preserve staff cache',()=>{
 const changed=load('actRealtimeSnapshot.ts').actStaffSnapshotChanged;
 const before={data:{Роботи:[{Зарплата:25}],Деталі:[],Пробіг:10},pruimalnyk:'Receiver'};
 assert.equal(changed(before,{...before,data:{...before.data,Пробіг:20,Фото:'new'}}),false);
 assert.equal(changed(before,{...before,data:{...before.data,Роботи:[{Зарплата:50}]}}),true);
 assert.equal(changed({traffic_state:{staff_revision:'ff'}},{traffic_state:{staff_revision:'01'}}),true);
 assert.equal(changed({traffic_state:{staff_revision:'ff'}},{traffic_state:{staff_revision:'ff'}}),false);
});
function lockFixture(read) {
 const client=channelClient(),calls=[],tracks=[];client.rpc=async(name,args)=>{calls.push({name,args});return {data:await read(name,args,calls.length)}};
 const api=load('actPresence.ts',{require:()=>({supabase:client,userName:'Me',globalCache:{generalSettings:{}},showNotification(){},actPresenceHub:{setEditor:async(...v)=>tracks.push(v),clearEditor:async()=>{}}}),
   window:{addEventListener(){}},document:{visibilityState:'visible',addEventListener(){},querySelector(){return null},getElementById(){return null}},setInterval:()=>1,clearInterval(){},setTimeout:()=>2,clearTimeout(){}});
 return {api,client,calls,tracks,handler:()=>client.channels.find(c=>c.topic.startsWith('act_locks')).events[0].callback};
}
test('lock events for other acts and events received by owner never acquire/reload',async()=>{
 const f=lockFixture(()=>({acquired:true}));let unlocked=0;await f.api.subscribeToActPresence(10,()=>unlocked++);
 await f.handler()({old:{act_id:11}});await f.handler()({old:{act_id:10}});
 assert.equal(f.calls.length,1);assert.equal(unlocked,0);
});
test('matching unlock burst makes one acquire and one transition; delayed response after close does nothing',async()=>{
 let finish;const f=lockFixture((_name,_args,n)=>n===1?{acquired:false,locked_by:'Other'}:new Promise(resolve=>finish=resolve));let unlocked=0;
 await f.api.subscribeToActPresence(10,()=>unlocked++);await f.handler()({old:{act_id:11}});assert.equal(f.calls.length,1);
 const a=f.handler()({old:{act_id:10}}),b=f.handler()({old:{act_id:10}});assert.equal(f.calls.length,2);
 finish({acquired:true});await Promise.all([a,b]);assert.equal(unlocked,1);assert.equal(f.tracks.length,1);
 const g=lockFixture((name,_args,n)=>name==='release_act_lock'?{}:n===1?{acquired:false,locked_by:'Other'}:new Promise(resolve=>finish=resolve));
 await g.api.subscribeToActPresence(20,()=>unlocked++);const pending=g.handler()({old:{act_id:20}});await g.api.unsubscribeFromActPresence();finish({acquired:true});await pending;
 assert.equal(unlocked,1);assert.equal(g.tracks.length,0);
});

function modalSubscriptionFixture(read) {
 const ast=ts.createSourceFile('modalMain.ts',fs.readFileSync(root+'modalMain.ts','utf8'),99,true);
 const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='setupSlusarsOnRealtimeSubscription');
 const snapshots=load('actRealtimeSnapshot.ts'),applied=[],refreshes=[],subscriptions=[],listeners={},reads=[];
 const context={exports:{},slusarsOnGeneration:0,slusarsOnSubscription:null,realtimeActSnapshot:snapshots.createActRealtimeSnapshot(),
   globalCache:{currentActId:1},localStorage:{getItem:()=> 'owner'},receiveSavedActQuantities(){},applyActStatusToModal:(_id,row)=>applied.push(row),
   safeParseJSON:v=>typeof v==='string'?JSON.parse(v):v,actStaffSnapshotChanged:snapshots.actStaffSnapshotChanged,
   refreshActTableSilently:async(id,change)=>refreshes.push({id,change}),
   databaseSubscriptions:{subscribe(resource,onChange,onStatus){subscriptions.push({resource,onChange,onStatus});return{unsubscribe(){}}}},
   window:{addEventListener(name,fn){listeners[name]=fn},removeEventListener(name,fn){if(listeners[name]===fn)delete listeners[name]}},
   supabase:{from(){let columns;return{select(value){columns=value;return this},eq(){return this},single(){reads.push(columns);return read(columns)}}}}};
 vm.runInNewContext(ts.transpileModule(fn.getText(ast)+'\nexports.setup=setupSlusarsOnRealtimeSubscription;',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
 return {...context.exports,applied,refreshes,subscriptions,listeners,reads,getSubscription:()=>context.slusarsOnSubscription};
}
test('first SUBSCRIBED repairs snapshot gap once with an exact-act read',async()=>{
 let reads=0;const before={act_id:1,data:{__act_revision:'old',Роботи:[],Пробіг:10}};
 const after={act_id:1,data:{__act_revision:'new',Роботи:[],Пробіг:20}};
 const f=modalSubscriptionFixture(async()=>{reads++;return{data:after}});f.setup(1,before);
 assert.equal(reads,0);assert.equal(f.subscriptions[0].resource.filter,'act_id=eq.1');
 f.subscriptions[0].onStatus('SUBSCRIBED');await flush();f.subscriptions[0].onStatus('SUBSCRIBED');await flush();
 assert.equal(reads,1);assert.equal(f.applied.length,1);assert.equal(f.refreshes.length,1);assert.equal(f.refreshes[0].change.staffChanged,false);
 assert.deepEqual(f.reads,['*']); // No new-column request against the old schema.
});

for(const state of [null,{revision:'same-hash'}]) test(`unchanged migrated act (${state?'hash':'null'}) uses a compact initial and reconnect probe only`,async()=>{
 const f=modalSubscriptionFixture(async()=>({data:{act_id:1,traffic_state:state}}));
 f.setup(1,{act_id:1,traffic_state:state,data:{__act_revision:'saved'}});
 f.subscriptions[0].onStatus('SUBSCRIBED');await flush();
 assert.deepEqual(f.reads,['act_id,traffic_state']);assert.equal(f.applied.length,0);assert.equal(f.refreshes.length,0);
 f.subscriptions[0].onStatus('CLOSED');f.subscriptions[0].onStatus('SUBSCRIBED');await flush();
 assert.deepEqual(f.reads,['act_id,traffic_state','act_id,traffic_state']);
});

test('changed migrated act performs one compact probe and one full exact-act recovery',async()=>{
 const after={act_id:1,traffic_state:{revision:'01'},data:{__act_revision:'new',Пробіг:20}};
 const f=modalSubscriptionFixture(async columns=>({data:columns==='*'?after:{act_id:1,traffic_state:after.traffic_state}}));
 f.setup(1,{act_id:1,traffic_state:{revision:'ff'},data:{__act_revision:'old',Пробіг:10}});
 f.subscriptions[0].onStatus('SUBSCRIBED');await flush();
 assert.deepEqual(f.reads,['act_id,traffic_state','*']);assert.equal(f.applied.length,1);assert.equal(f.refreshes.length,1);
});

for(const stage of ['probe','full']) test(`confirmed write during compact ${stage} recovery prevents stale apply and extra reads`,async()=>{
 let finish;
 const f=modalSubscriptionFixture(columns=>columns===(stage==='probe'?'act_id,traffic_state':'*')?new Promise(resolve=>finish=resolve):Promise.resolve({data:{act_id:1,traffic_state:{revision:'changed'}}}));
 f.setup(1,{act_id:1,traffic_state:{revision:'base'},data:{__act_revision:'base'}});
 f.subscriptions[0].onStatus('SUBSCRIBED');await flush();f.listeners['sto:act-saved']({detail:{actId:1}});
 finish({data:{act_id:1,traffic_state:{revision:'older'},data:{__act_revision:'older'}}});await flush();
 assert.deepEqual(f.reads,stage==='probe'?['act_id,traffic_state']:['act_id,traffic_state','*']);assert.equal(f.applied.length,0);assert.equal(f.refreshes.length,0);
});
test('a live event wins over an older initial reconciliation response',async()=>{
 let finish;const f=modalSubscriptionFixture(()=>new Promise(resolve=>finish=resolve));
 f.setup(1,{act_id:1,data:{__act_revision:'base'}});f.subscriptions[0].onStatus('SUBSCRIBED');
 await f.subscriptions[0].onChange({new:{act_id:1,data:{__act_revision:'latest'}}});
 finish({data:{act_id:1,data:{__act_revision:'older'}}});await flush();
 assert.equal(f.applied.length,1);assert.equal(f.applied[0].data.__act_revision,'latest');assert.equal(f.refreshes.length,0);
});

for(const receipt of ['sto:act-saved','sto:act-status-committed']) test(`${receipt} fences older recovery before the WAL echo`,async()=>{
 let finish;const f=modalSubscriptionFixture(()=>new Promise(resolve=>finish=resolve));
 f.setup(1,{act_id:1,data:{__act_revision:'base'}});f.subscriptions[0].onStatus('SUBSCRIBED');
 f.listeners[receipt]({detail:{actId:1}});
 finish({data:{act_id:1,date_off:null,data:{__act_revision:'older'}}});await flush();
 assert.equal(f.applied.length,0);assert.equal(f.refreshes.length,0);
 f.getSubscription().unsubscribe();assert.equal(Object.keys(f.listeners).length,0);
});
function stockFixture(read,options={}) {
 const subscriptions=[],events=[],reads=[];
 const supabase={auth:{onAuthStateChange(){}},rpc:async()=>({data:{ids:[1],has_more:false,next_cursor:1}}),
   from(){let ids;const q={select(){return q},in(_key,value){ids=value;return q},then(resolve,reject){reads.push([...ids]);return Promise.resolve(read(ids)).then(resolve,reject)}};return q}};
 const api=load('globalCache.ts',{require:()=>({supabase,invalidateEditorReferences(){},...options.referenceRead,databaseSubscriptions:{subscribe(resource,callback,status){subscriptions.push({resource,callback,status});return{unsubscribe(){}}}}}),
   window:{addEventListener(){},dispatchEvent:event=>{events.push(event);options.dispatchEvent?.(event)}},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail}}});
 api.ensureEditorReferenceScope();events.length=0;api.initScladRealtimeSubscription();return{api,subscriptions,events,reads};
}
const stockRow=(id,off=0)=>({sclad_id:id,part_number:'P'+id,name:'Part '+id,price:10,kilkist_on:5,kilkist_off:off});
test('unrelated stock event cannot restart an in-flight selected-ID read; newer selected data wins',async()=>{
 let finish;const f=stockFixture(()=>new Promise(resolve=>finish=resolve));const pending=f.api.ensureSkladIdsLoaded([1]);await flush();
 f.subscriptions[0].callback({eventType:'UPDATE',new:stockRow(99)});assert.equal(f.events.length,0);
 f.subscriptions[0].callback({eventType:'UPDATE',new:stockRow(1,2)});finish({data:[stockRow(1)]});await pending;
 assert.equal(f.reads.length,1);assert.equal(f.api.globalCache.skladParts[0].kilkist_off,2);assert.equal(f.events[0].detail.id,1);
});
test('unknown DELETE revalidates only watched IDs; catalogue INSERT invalidates names without loading its full row',async()=>{
 let deleted=false;const f=stockFixture(ids=>({data:deleted?[]:ids.map(id=>stockRow(id))}));
 await f.api.ensureSkladIdsLoaded([1]);f.subscriptions[0].callback({eventType:'DELETE',old:{}});
 assert.equal(f.api.globalCache.skladParts.length,1);deleted=true;await f.api.ensureSkladIdsLoaded([1]);assert.equal(f.api.globalCache.skladParts.length,0);
 await f.api.searchSkladCatalog('part');const names=f.subscriptions.find(s=>s.resource.select.length===3);
 const before=f.reads.length;names.callback({eventType:'INSERT',new:{sclad_id:55,name:'New',part_number:'N55'}});
 assert.equal(f.reads.length,before);assert.equal(f.api.globalCache.skladParts.length,0);
 assert.ok(f.events.some(e=>e.type==='sto:stock-catalog-updated'&&e.detail.id===55));
 assert.ok(f.reads.every(ids=>ids.length===1&&ids[0]===1));
});
test('stock quantity events retain lookups; catalogue events expire only stock/voice searches',async()=>{
 const listeners={},calls=[];let stockId=3;
 const supabase={auth:{onAuthStateChange(){}},rpc:async(name,args)=>{calls.push({name,args});return{data:name==='traffic_editor_name_ids'?[stockId]:[{kind:'work',id:'1',name:'Repair',catalog:''}]}}};
 const api=load('editorReferenceRead.ts',{require:()=>({supabase}),window:{addEventListener(name,fn){listeners[name]=fn}},document:{addEventListener(){}},localStorage:{getItem:()=> 'owner'}});
 await api.readEditorReferences({query:'rep'});await api.readEditorStockNameIds('part',new Map());assert.equal(calls.length,2);
 listeners['sto:stock-updated']?.({detail:{id:3}});
 await api.readEditorReferences({query:'rep'});await api.readEditorStockNameIds('part',new Map());assert.equal(calls.length,2);
 stockId=4;listeners['sto:stock-catalog-updated']({detail:{id:4}});
 await api.readEditorReferences({query:'rep'});assert.equal(calls.length,2);
 assert.deepEqual([...await api.readEditorStockNameIds('part',new Map())],[4]);assert.equal(calls.length,3);
});

test('initial catalogue join expires an empty pre-join stock name result',async()=>{
 const listeners={};let ids=[],calls=0;
 const supabase={auth:{onAuthStateChange(){}},rpc:async()=>{calls++;return{data:ids}}};
 const refs=load('editorReferenceRead.ts',{require:()=>({supabase}),window:{addEventListener(name,fn){listeners[name]=fn}},document:{addEventListener(){}},localStorage:{getItem:()=> 'owner'}});
 const f=stockFixture(values=>({data:values.map(id=>stockRow(id))}),{referenceRead:refs,dispatchEvent:e=>listeners[e.type]?.(e)});
 assert.equal((await f.api.searchSkladNames('part')).length,0);assert.equal(calls,1);
 ids=[55];const names=f.subscriptions.find(s=>s.resource.select.length===3);names.status('SUBSCRIBED');
 assert.equal((await f.api.searchSkladNames('part'))[0].sclad_id,55);assert.equal(calls,2);
});

for(const voice of [false,true]) test(`initial catalogue join retries in-flight ${voice?'voice':'stock names'} once`,async()=>{
 let finish,calls=0;const listeners={};
 const fresh=voice?[{kind:'stock',id:'55',name:'Part',catalog:'P55'}]:[55];
 const supabase={auth:{onAuthStateChange(){}},rpc:async()=>{calls++;return calls===1?new Promise(resolve=>finish=resolve):{data:fresh}}};
 const api=load('editorReferenceRead.ts',{require:()=>({supabase}),window:{addEventListener(name,fn){listeners[name]=fn}},document:{addEventListener(){}},localStorage:{getItem:()=> 'owner'}});
 const request=voice?api.readEditorReferences({query:'part',voice:true}):api.readEditorStockNameIds('part',new Map());
 listeners['sto:stock-catalog-updated']();finish({data:[]});assert.deepEqual(JSON.parse(JSON.stringify(await request)),fresh);assert.equal(calls,2);
});
