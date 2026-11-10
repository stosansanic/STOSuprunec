const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),ts=require('typescript');
function fixture(rpc,automation={}){let actor='A';const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/ai/aiAnalytics.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,require:name=>name.includes('supabase')?{supabase:{rpc,from(){throw Error('raw table read forbidden')}}}:automation,localStorage:{getItem:()=>actor},structuredClone,Intl,Date});return {api:exports,setActor:v=>actor=v};}
test('recommendation retains weighting while only requesting aggregate staff load',async()=>{
 const calls=[];const {api}=fixture(async(name,args)=>{calls.push([name,args.p_mode]);return {data:{complete:true,scope:'recommend',as_of:'now',total:2,items:[{slyusar_id:1,data:{Name:'A',Спеціалізація:'oil',Рейтинг:5},current_load:0},{slyusar_id:2,data:{Name:'B',Рейтинг:5},current_load:3}]}}});
 const result=await api.recommendSlyusar('oil replacement');assert.equal(result.success,true);assert.equal(result.data[0].score,10);assert.equal(result.data[1].score,4.5);assert.deepEqual(calls,[['traffic_ai_operational','recommend']]);
});
test('vehicle history collects compact pages for editor but AI states its 20-row scope and full total',async()=>{
 const calls=[];const {api}=fixture(async(_,args)=>{const {offset=0,limit}=args.p_args;calls.push([offset,limit]);return {data:{complete:true,as_of:'now',total:55,total_sum:5500,latest:[],has_more:offset+limit<55,next_offset:offset+limit,items:Array.from({length:Math.min(limit,55-offset)},(_,i)=>({act_id:offset+i+1,mileage:'123km',works:[],details:[],total_sum:100}))}}});
 const full=await api.getVehicleHistory(1,0);assert.equal(full.entries.length,55);assert.equal(full.entries[0].mileage,123);assert.equal(full.hasMore,false);assert.match(full.hints[0].text,/55/);assert.deepEqual(calls,[[0,50],[50,50]]);
 const ai=await api.executeAnalytics('vehicle_history',undefined,undefined,undefined,1);assert.equal(ai.data.entries.length,20);assert.equal(ai.total,55);assert.equal(ai.hasMore,true);
});
test('executeAnalytics deduplicates all params and automation calls, rejects late actor change',async()=>{
 let calls=0,finish;const f=fixture(async()=>{throw Error('unused')},{getWorkloadForecast:()=>{calls++;return new Promise(resolve=>finish=resolve)}});
 const a=f.api.executeAnalytics('workload_forecast',90),b=f.api.executeAnalytics('workload_forecast',90);finish({success:true,type:'workload_forecast',data:[1]});const [x,y]=await Promise.all([a,b]);assert.equal(calls,1);x.data.push(2);assert.equal(y.data.length,1);assert.equal(y.hasMore,false);assert.ok(y.asOf);
 const late=f.api.executeAnalytics('workload_forecast',30);f.setActor('B');finish({success:true,type:'workload_forecast'});await assert.rejects(late,/Користувач/);
});
test('operational errors never trigger full-history fallback',async()=>{const {api}=fixture(async()=>({error:Error('missing migration')}));const result=await api.recommendSlyusar('oil');assert.equal(result.success,false);assert.match(result.error,/missing/);});
