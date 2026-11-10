const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');
function fixture(){
 const source=fs.readFileSync('src/ts/roboha/zakaz_naraudy/inhi/kastomna_tabluca_poperedhennya.ts','utf8');const ast=ts.createSourceFile('warnings.ts',source,99,true);
 const names=['loadCurrentActData','fetchCurrentActData','getCurrentActDetailQty','resetActDataCache'];const selected=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast).replace(/^export /,'')).join('\n');
 const quantities=new Map();let complete=false,calls=0,finish;
 const ctx={currentActDataCache:null,actDataPending:null,actDataGeneration:0,actDataLoadedId:null,actDataLoadedAt:0,
  globalCache:{currentActId:1},safeParseJSON:x=>x,actQuantitySnapshot:{quantity:(id,stock)=>complete&&id===1?quantities.get(stock)||0:undefined,seed:(_id,rows)=>{complete=true;for(const pair of rows)quantities.set(...pair)}},
  supabase:{rpc:()=>{calls++;return new Promise(r=>finish=r)}}};
 vm.createContext(ctx);vm.runInContext(ts.transpileModule(selected,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,ctx);
 return {ctx,seed:()=>{complete=true;quantities.set(10,3)},calls:()=>calls,resolve:data=>finish(data)};
}
test('known complete act covers both saved and new IDs without acts.data rereads',async()=>{
 const f=fixture();f.seed();assert.equal(await f.ctx.getCurrentActDetailQty(10),3);assert.equal(await f.ctx.getCurrentActDetailQty(99),0);assert.equal(f.calls(),0);
});
test('input blur click share unknown baseline read; failed read never implies zero',async()=>{
 const f=fixture();const tasks=[10,10,99].map(id=>f.ctx.getCurrentActDetailQty(id));assert.equal(f.calls(),1);
 f.resolve({data:{Деталі:[{sclad_id:10,Кількість:3}]}});assert.deepEqual(await Promise.all(tasks),[3,3,0]);assert.equal(await f.ctx.getCurrentActDetailQty(99),0);assert.equal(f.calls(),1);
 const bad=fixture();const attempt=bad.ctx.getCurrentActDetailQty(99);bad.resolve({error:Error('offline')});await assert.rejects(attempt,/початкову кількість/);
});
