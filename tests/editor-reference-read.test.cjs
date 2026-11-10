const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');
function load(file,context={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,structuredClone,...context});return exports}
test('editor references coalesce, clone, separate queries, reject stale scope and errors',async()=>{
 let finish,calls=0,actor='a';const api=load('src/ts/roboha/zakaz_naraudy/editorReferenceRead.ts',{localStorage:{getItem:()=>actor},require:()=>({supabase:{rpc:()=>{calls++;return new Promise(r=>finish=r)}}})});
 const a=api.readEditorReferences({query:'болт'}),b=api.readEditorReferences({query:'болт'});assert.equal(calls,1);
 finish({data:[{kind:'detail',id:'1',name:'Болт',catalog:''}]});(await a)[0].name='wrong';assert.equal((await b)[0].name,'Болт');await api.readEditorReferences({query:'болт'});assert.equal(calls,1);
 const stale=api.readEditorReferences({query:'інший'});actor='b';finish({data:[]});await assert.rejects(stale,/Контекст/);
 const failed=api.readEditorReferences({query:'err'});finish({error:{code:'42501'}});await assert.rejects(failed,e=>e.code==='42501');
 const retry=api.readEditorReferences({query:'err'});finish({data:[]});await retry;assert.equal(calls,4);
});
test('quantity zero is known only for complete act snapshot, with independent revisions',()=>{
 const {createActQuantitySnapshot}=load('src/ts/roboha/zakaz_naraudy/actQuantitySnapshot.ts');const store=createActQuantitySnapshot();
 assert.equal(store.quantity(1,10),undefined);store.seed(1,new Map([[10,3]]));assert.equal(store.quantity(1,10),3);assert.equal(store.quantity(1,99),0);assert.equal(store.quantity(2,10),undefined);
 const revision=store.revision();store.invalidate(2);assert.equal(store.revision(),revision);store.invalidate(1);assert.equal(store.quantity(1,10),undefined);assert.ok(store.revision()>revision);
});

test('global partial references clear on internal actor switch and reject late merges',async()=>{
 const path='src/ts/roboha/zakaz_naraudy/globalCache.ts',source=fs.readFileSync(path,'utf8'),ast=ts.createSourceFile(path,source,99,true);
 const names=['editorReferenceScope','ensureEditorReferenceScope','loadEditorReferences'];
 const code=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast).replace(/^export /,'')).join('\n');
 let actor='a',resolve;
 const globalCache={works:[],worksWithId:[],details:[],detailsWithId:[],shops:[],slyusars:[]};
 const ctx={editorReferenceOwner:undefined,globalCache,localStorage:{getItem:()=>actor},releaseEditorStockSubscription(){},invalidateGlobalDataCache(){},ensureSkladIdsLoaded:async()=>{},readEditorReferences:()=>new Promise(r=>resolve=r)};
 vm.createContext(ctx);vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,ctx);
 const initial=ctx.loadEditorReferences({});resolve([{kind:'work',id:'1',name:'Actor A work'}]);await initial;assert.equal(globalCache.works[0],'Actor A work');
 const late=ctx.loadEditorReferences({});actor='b';resolve([{kind:'work',id:'2',name:'Late A result'}]);await assert.rejects(late,/Користувач/);
 assert.equal(globalCache.works.length,0);assert.equal(globalCache.worksWithId.length,0);
 const fresh=ctx.loadEditorReferences({});resolve([{kind:'detail',id:'3',name:'Actor B detail'}]);await fresh;assert.equal(globalCache.details[0],'Actor B detail');
});
