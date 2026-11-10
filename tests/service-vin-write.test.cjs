const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');
function load(baseline,changed=false){
 const file='src/ts/roboha/service_book/serviceBook.ts';
 const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),99,true);
 const source=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='applyVinData').getText(ast);
 const state={writes:[],notifications:[],clears:0,rendered:0,filters:[]};
 const query={select(){return state.writes.length?Promise.resolve({data:changed?[]:[{cars_id:1}]}):query},
 eq(k,v){state.filters.push([k,v]);return query},is(k,v){state.filters.push([k,v]);return query},
 single:async()=>({data:{cars_id:1,data:structuredClone(baseline)}}),
 update(value){state.writes.push(value);return query}};
 const ctx={supabase:{from:()=>query},clearServiceSearchCache:()=>state.clears++,
 showNotification:(...args)=>state.notifications.push(args),renderCarCard:()=>state.rendered++};
 vm.createContext(ctx);vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,ctx);
 return {state,save:ctx.applyVinData};
}
test('VIN edit reuses fresh car fields and conditionally writes the exact baseline',async()=>{
 const baseline={Авто:'New name',custom:'retain'};const {state,save}=load(baseline);
 await save({cars_id:1,data:{Авто:'stale',custom:'old'}},{make:'Make',model:'Model',year:'2020'});
 assert.equal(state.writes[0].data.Авто,'New name');assert.equal(state.writes[0].data.custom,'retain');
 assert.equal(state.writes[0].data.Рік,2020);
 assert.equal(state.filters.find(x=>x[0]==='data')[1],JSON.stringify(baseline));
 assert.equal(state.rendered,1);assert.equal(state.clears,1);
});
test('VIN concurrent change is reported and never published as a successful edit',async()=>{
 const {state,save}=load({},true);const car={cars_id:1,data:{}};
 await save(car,{year:'2020'});assert.equal(state.rendered,0);assert.equal(car.data.Рік,undefined);
 assert.match(state.notifications[0][0],/змінилися/);assert.equal(state.notifications[0][1],'error');
});
