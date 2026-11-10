const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const vm=require('vm');const ts=require('typescript');
const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/bukhhalteriya/payrollDirectory.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:()=>({supabase:{}})});
test('accounting bootstrap reads compact directory pages with global pending count',async()=>{
 const calls=[];const result=await api.readPayrollDirectory({rpc:async(name,args)=>{calls.push([name,args.p_after]);return {data:{items:[{slyusar_id:args.p_after?2:1,data:{Name:'Test'}}],has_more:!args.p_after,next_cursor:1,pending_count:args.p_after?null:1005}}}});
 assert.equal(result.rows.length,2);assert.equal(result.pendingCount,1005);assert.deepEqual(calls,[['traffic_payroll_directory',null],['traffic_payroll_directory',1]]);
 assert.match(fs.readFileSync('src/ts/roboha/bukhhalteriya/bukhhalteriya.ts','utf8'),/await loadSlyusarsData\(true\)/);
});
test('directory failures never trigger a full employee-history fallback',async()=>{
 let calls=0;await assert.rejects(api.readPayrollDirectory({rpc:async()=>{calls++;return {error:Error('missing')}}}),/missing/);assert.equal(calls,1);
});
