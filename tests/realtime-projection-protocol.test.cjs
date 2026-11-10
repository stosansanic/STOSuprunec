// Exercise the installed SDK's real join serialization and response decoder.
// The fake socket stays in memory: no external service or network is contacted.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {RealtimeClient}=require('@supabase/realtime-js');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
test('installed realtime-js forwards select in phx_join and accepts projected change records',async()=>{
 const frames=[],statuses=[],events=[];
 const client=new RealtimeClient('ws://localhost/realtime/v1',{params:{apikey:'test'}});
 // Authentication refresh is outside this protocol test; avoid an unacknowledged
 // access_token push leaving its ten-second timeout on the in-memory socket.
 client.setAuth=async()=>{};
 client.conn={readyState:1,send:data=>frames.push(JSON.parse(data)),close(){},onclose:null};
 const resource={event:'UPDATE',schema:'public',table:'acts',filter:'act_id=eq.1',select:['act_id','traffic_state']};
 const channel=client.channel('projected-test').on('postgres_changes',resource,p=>events.push(p)).subscribe(s=>statuses.push(s));
 try {
   const join=frames.find(frame=>frame.event==='phx_join');assert.ok(join);
   assert.deepEqual(join.payload.config.postgres_changes[0],resource);
   channel._trigger('phx_reply',{status:'ok',response:{postgres_changes:[{...resource,id:1}]}},join.ref);
   await Promise.resolve();assert.ok(statuses.includes('SUBSCRIBED'));
   channel._trigger('postgres_changes',{ids:[1],data:{schema:'public',table:'acts',commit_timestamp:'2026-10-23T12:00:00Z',type:'UPDATE',errors:[],columns:[{name:'act_id',type:'int8'},{name:'traffic_state',type:'jsonb'}],record:{act_id:'1',traffic_state:'{"frozen":false}'},old_record:{act_id:'1'}}});
   assert.equal(events.length,1);assert.equal(events[0].new.act_id,1);
   assert.deepEqual(events[0].new.traffic_state,{frozen:false});assert.equal(events[0].new.data,undefined);
 } finally {
   channel.joinPush.destroy();channel.rejoinTimer.reset();client.disconnect();
 }
});

test('shared registry waits for PostgreSQL readiness using the installed SDK system message',async()=>{
 const frames=[],statuses=[],events=[];
 const client=new RealtimeClient('ws://localhost/realtime/v1',{params:{apikey:'test'}});
 client.setAuth=async()=>{};
 client.conn={readyState:1,send:data=>frames.push(JSON.parse(data)),close(){},onclose:null};
 const transport={rpc:async()=>({data:{version:1},error:null}),channel:name=>client.channel(name),
   removeChannel(channel){channel.joinPush.destroy();channel.rejoinTimer.reset();}};
 const module={exports:{},setTimeout,clearTimeout,require:()=>({supabase:transport})};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/utils/databaseSubscriptions.ts','utf8'),{
   compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
 }).outputText,module);
 const registry=module.exports.createDatabaseSubscriptionRegistry(transport);
 const stop=registry.subscribe({table:'acts',select:['act_id','traffic_state']},p=>events.push(p),s=>statuses.push(s),'test');
 try {
   await new Promise(resolve=>setImmediate(resolve));
   const channel=client.getChannels()[0];
   const join=frames.find(frame=>frame.event==='phx_join');assert.ok(join);
   const resource=join.payload.config.postgres_changes[0];
   assert.deepEqual(resource.select,['act_id','traffic_state']);
   channel._trigger('phx_reply',{status:'ok',response:{postgres_changes:[{...resource,id:1}]}},join.ref);
   await Promise.resolve();assert.deepEqual(statuses,[],'socket join alone is not database readiness');
   channel._trigger('system',{extension:'postgres_changes',status:'ok',message:'Subscribed to PostgreSQL'});
   assert.deepEqual(statuses,['SUBSCRIBED']);
   channel._trigger('system',{extension:'postgres_changes',status:'ok',message:'Subscribed to PostgreSQL'});
   assert.deepEqual(statuses,['SUBSCRIBED'],'repeated acknowledgements do not trigger duplicate refresh');
   channel._trigger('postgres_changes',{ids:[1],data:{schema:'public',table:'acts',commit_timestamp:'2026-10-23T12:00:00Z',type:'UPDATE',errors:[],columns:[{name:'act_id',type:'int8'},{name:'traffic_state',type:'jsonb'}],record:{act_id:'1',traffic_state:'{"frozen":false}'},old_record:{act_id:'1'}}});
   assert.equal(events.length,1);assert.equal(events[0].new.act_id,1);assert.equal(events[0].new.data,undefined);
 } finally {stop.unsubscribe();client.disconnect();}
});
