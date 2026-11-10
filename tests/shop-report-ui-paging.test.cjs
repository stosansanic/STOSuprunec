const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function load(read){
 const source=fs.readFileSync('src/ts/roboha/bukhhalteriya/poAktam.ts','utf8'),ast=ts.createSourceFile('ui.ts',source,ts.ScriptTarget.Latest,true);
 const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='readAllFilteredPaymentRows');
 const state={exports:{},structuredClone,appliedReportFilter:{item:'Part'},shopsData:[],readShopReportPage:read,trackReportShops:rows=>rows};
 vm.runInNewContext(ts.transpileModule('export '+fn.getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,state);return state;
}
test('explicit export reads every matching page and merges complete payment baselines by shop ID',async()=>{
 const calls=[],entry={Акт:1,Деталі:[{Ціна:20}]};const state=load(async(filter,offset,force)=>{calls.push([filter.item,offset,force]);return {items:Array.from({length:Math.min(100,205-offset)},(_,i)=>({rowId:String(offset+i)})),totalCount:205,shops:[{shop_id:1,data:{Name:'Same',Історія:{d:[entry]}}},{shop_id:2,data:{Name:'Same',Історія:{d:[entry]}}}]}});
 const rows=await state.exports.readAllFilteredPaymentRows();assert.equal(rows.length,205);assert.deepEqual(calls,[['Part',0,true],['Part',100,false],['Part',200,false]]);assert.equal(state.shopsData.length,2);assert.equal(state.shopsData[0].data.Історія.d.length,1);
});
test('explicit export rejects moving result set or changed baseline before any mutation',async()=>{
 const state=load(async(_,offset)=>({items:Array.from({length:100},(_,i)=>({rowId:String(offset+i)})),totalCount:offset?201:200,shops:[]}));
 await assert.rejects(state.exports.readAllFilteredPaymentRows(),/Звіт змінено/);assert.equal(state.shopsData.length,0);
 const changed=load(async(_,offset)=>({items:Array.from({length:100},(_,i)=>({rowId:String(offset+i)})),totalCount:200,shops:[{shop_id:1,data:{Name:'Shop',Історія:{d:[{Акт:1,Деталі:[{Ціна:offset}]}]}}}]}));
 await assert.rejects(changed.exports.readAllFilteredPaymentRows(),/Акт змінено/);assert.equal(changed.shopsData.length,0);
});
test('payments never call full export reader',()=>{
 const source=fs.readFileSync('src/ts/roboha/bukhhalteriya/poAktam.ts','utf8'),ast=ts.createSourceFile('ui.ts',source,ts.ScriptTarget.Latest,true);
 for(const name of ['toggleDetailsPaymentWithConfirmation','performDetailsPayment','runMassPaymentCalculationForDetails']){
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.doesNotMatch(fn.getText(ast),/readAllFilteredPaymentRows/);
 }
});
