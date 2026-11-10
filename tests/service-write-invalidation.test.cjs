const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');
function load(name,error){
 const file='src/ts/roboha/redahyvatu_klient_machuna/pidtverdutu_sberihannya_PIB_avto.ts';
 const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),99,true);
 const source=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast);
 const events=[];const query={insert(){return query},update(){return query},select(){return query},
 eq:async()=>({error}),single:async()=>({data:{client_id:1,cars_id:2},error})};
 const ctx={supabase:{from:()=>query},getId:x=>x==null?null:String(x),
 clientDataFromValues:()=>({}),carDataFromValues:()=>({}),findActiveCarByVin:async()=>({car:null}),
 logAction:async()=>{},showNotification:()=>{},normalizeText:x=>x||'',normalizeVin:x=>x||'',
 window:{dispatchEvent:event=>events.push(event)},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail}}};
 vm.createContext(ctx);vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,ctx);
 return {call:ctx[name],events};
}
test('legacy client/car creation and soft deletion invalidate only after successful writes',async()=>{
 for(const [name,args,event] of [
 ['createClient',[{}],'sto:client-saved'],
 ['addCarToDatabase',['1',{}],'sto:car-saved'],
 ['deleteCarFromDatabase',['2'],'sto:car-saved']]){
  const ok=load(name,null);await ok.call(...args);assert.equal(ok.events.length,1);assert.equal(ok.events[0].type,event);
  const bad=load(name,{message:'denied'});await bad.call(...args);assert.equal(bad.events.length,0);
 }
});
