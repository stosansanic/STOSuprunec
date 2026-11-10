const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');const api={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/bukhhalteriya/analyticsStaff.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:()=>({supabase:{}})});
test('analytics staff reads every compact page without a full history query',async()=>{
 const calls=[];const rows=await api.readAnalyticsStaff({rpc:async(_name,args)=>{calls.push(args);return {data:{items:[{slyusar_id:args.p_after?201:1}],has_more:!args.p_after,next_cursor:200}}},from:()=>{throw Error('unexpected broad read')}});
 assert.equal(rows.length,2);assert.equal(calls.length,2);assert.equal(calls[1].p_after,200);
});
test('analytics staff access errors and broken cursors are not empty success',async()=>{
 await assert.rejects(api.readAnalyticsStaff({rpc:async()=>({error:{code:'42501'}})}));
 await assert.rejects(api.readAnalyticsStaff({rpc:async()=>({data:{items:[{}],has_more:true,next_cursor:0}})}));
});
