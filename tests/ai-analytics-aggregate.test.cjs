const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const vm=require('vm');const ts=require('typescript');
function load(rpc){const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/ai/aiAnalytics.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:n=>n.includes('supabaseClient')?{supabase:{rpc,from(){throw Error('broad read')}}}:{}});return api;}
test('financial report keeps JS negative rounding and never reads raw histories',async()=>{
 const api=load(async()=>({data:{complete:true,current:{revenue:10.5,expenses:13,acts_count:2},previous:{revenue:2,expenses:0,acts_count:1}}}));
 const result=await api.getFinancialReport(30);assert.equal(result.success,true);assert.equal(result.data.current.revenue,11);assert.equal(result.data.current.profit,-2);assert.equal(result.data.current.avg_check,5);assert.equal(result.data.current.margin,-23.8);
});
test('VIP and staff rankings use compact aggregates with existing labels',async()=>{
 const api=load(async(name)=>({data:name==='traffic_ai_vip'?{complete:true,items:[[1,{name:'Test',phone:'123',acts:5005,revenue:100001,lastVisit:'2026-10-01'}]]}:{items:[{slyusar_id:1,data:{Name:'Test',Рейтинг:'4.5'},__stats:{acts:5005,revenue:100001,openActs:3}}],has_more:false}}));
 const vip=await api.getVipClients();assert.equal(vip.success,true);assert.equal(vip.data[0].total_acts,5005);assert.equal(vip.data[0].vip_level,'💎 VIP');
 const staff=await api.getSlyusarRanking();assert.equal(staff.success,true);assert.equal(staff.data[0].total_acts,5005);assert.equal(staff.data[0].workload,'🔴 Перевантажений');assert.equal(staff.data[0].rating,4.5);
});

function automation(rpc){const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/ai/aiAutomation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,localStorage:{getItem:()=> 'actor'},require:()=>({supabase:{rpc,from(){throw Error('broad read')}}})});return api;}
test('automation workload and stock alerts keep formulas with compact responses',async()=>{
 const api=automation(async name=>({data:name==='traffic_ai_workload'?{complete:true,total:10,days:[{dow:1,count:10,dates:2,revenue:-2.5}],hours:[{hour:9,count:10}]}:{total_stock:1000,items:[{sclad_id:2,name:'Part',current_qty:1,threshold:2}],has_more:false}}));
 const w=await api.getWorkloadForecast();assert.equal(w.success,true);assert.equal(w.data.totalActs,10);assert.equal(w.data.weekly[0].avgActsPerDay,5);assert.equal(w.data.weekly[0].avgRevenuePerDay,-1);
 const stock=await api.getStockAlerts();assert.equal(stock.success,true);assert.equal(stock.data[0].urgency,'critical');
});
test('retention scans all compact pages and excludes unused work documents',async()=>{
 let calls=0;const api=automation(async(name,args)=>{assert.equal(name,'traffic_ai_closed_act_page');assert.equal(args.p_mode,'retention');calls++;return {data:{items:calls===1?Array.from({length:200},(_,i)=>({client_id:1,date_on:'2020-01-01',date_off:'2020-01-02',data:{ПІБ:'Client',Телефон:'380123456789','Загальна сума':1}})):[{client_id:1,date_on:'2019-01-01',date_off:'2019-01-02',data:{'Загальна сума':1}}],has_more:calls===1}}});
 const result=await api.getClientRetentionList();assert.equal(result.success,true);assert.equal(calls,2);assert.equal(result.data[0].total_acts,201);assert.equal(result.data[0].total_spent,201);
});
