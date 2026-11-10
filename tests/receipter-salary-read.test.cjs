const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');const api={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/bukhhalteriya/receipterSalaryRead.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:()=>({supabase:{}})});
test('receiver salary reads only unique report acts in batches and filters unusual legacy IDs once',async()=>{
 const calls=[];const rows=await api.readReceipterSalaryRecords([...Array.from({length:205},(_,i)=>i+1),1],{rpc:async(_name,args)=>{calls.push(args.p_ids);return {data:args.p_ids.filter(id=>id!==100).map(id=>({Акт:id,ЗарплатаРоботи:2})).concat([{Акт:'1e2',ЗарплатаРоботи:5},{Акт:999}])}}});
 assert.equal(calls.length,2);assert.equal(calls[0].length,200);assert.equal(calls[1].length,5);assert.equal(rows.length,205);
 assert.equal(rows.filter(r=>Number(r.Акт)===100).length,1);
});
test('empty report performs no query and permission failures do not use full fallback',async()=>{
 assert.equal((await api.readReceipterSalaryRecords([],{rpc:()=>{throw Error('unexpected')}})).length,0);
 await assert.rejects(api.readReceipterSalaryRecords([1],{rpc:async()=>({error:{code:'42501'}}),from:()=>{throw Error('wrong fallback')}}),e=>e.code==='42501');
});
test('legacy compatibility keeps receivers and selected acts only',async()=>{
 const result=await api.readReceipterSalaryRecords([2],{rpc:async()=>({error:{code:'PGRST202'}}),from:()=>({select:async()=>({data:[{data:{Доступ:'Слюсар',Історія:{d:[{Акт:2}]}}},{data:JSON.stringify({Доступ:'Приймальник',Історія:{d:[{Акт:2,ЗарплатаРоботи:4},{Акт:3}]}})}]})})});
 assert.equal(result.length,1);assert.equal(result[0].ЗарплатаРоботи,4);
});
