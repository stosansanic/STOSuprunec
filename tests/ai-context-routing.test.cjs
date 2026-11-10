const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const vm=require('vm');const ts=require('typescript');
const compile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
test('every Atlas context level routes tools without fetching broad resources',async()=>{
 const source=fs.readFileSync('src/ts/roboha/ai/aiChat.ts','utf8');const a=source.indexOf('async function gatherSTOContext('),b=source.indexOf('// ============================================================\n// 🌐 GEMINI GOOGLE SEARCH GROUNDING',a);
 const api={};vm.runInNewContext(compile('export '+source.slice(a,b)),{exports:api,buildCompactContext:()=> 'context',analyzeQuery:()=>({needsActs:true,needsClients:true}),supabase:new Proxy({},{get(){throw Error('unexpected network')}})});
 for(const level of ['light','medium','heavy']) {const result=await api.gatherSTOContext('Акти',level);assert.match(result,/query_database/);assert.match(result,/get_analytics/);assert.match(result,/не завантажувалися/)}
});
test('AI tools share concurrent reads and return full count plus explicit page scope',async()=>{
 let calls=0,resolve,owner='one';const client={from(){calls++;const q={select(){return q},range(){return q},then(r){return new Promise(done=>resolve=done).then(r)}};return q}};
 const api={};vm.runInNewContext(compile(fs.readFileSync('src/ts/roboha/ai/aiDatabaseQuery.ts','utf8')),{exports:api,require:()=>({supabase:client}),localStorage:{getItem:()=>owner},structuredClone});
 const p={table:'clients',select:'client_id'};const a=api.executeAIQuery(p),b=api.executeAIQuery(p);await new Promise(r=>setImmediate(r));assert.equal(calls,1);
 resolve({data:[{client_id:1}],count:1005,error:null});const x=await a,y=await b;assert.equal(x.count,1005);assert.equal(x.returnedRows,1);assert.equal(x.hasMore,true);assert.equal(x.scope.limit,50);
 x.data[0].client_id=999;assert.equal(y.data[0].client_id,1);
 const stale=api.executeAIQuery(p);await new Promise(r=>setImmediate(r));owner='two';resolve({data:[{client_id:1}],count:1});assert.equal((await stale).success,false);
});
