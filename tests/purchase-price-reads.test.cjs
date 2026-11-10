const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const source=fs.readFileSync('src/ts/roboha/zakaz_naraudy/inhi/zberechennya_zmin_y_danux_aktu.ts','utf8');
function setup(read){const calls=[],api={};const supabase={from:()=>({select:fields=>({in:async(key,ids)=>{calls.push({fields,key,ids});return read(ids)}})})};
 const start=source.indexOf('async function loadPurchasePrices('),end=source.indexOf('const cleanText',start);
 vm.runInNewContext(ts.transpileModule('const purchasePricesCache=new Map<number,number>();'+source.slice(start,end)+';export {loadPurchasePrices,getPurchasePrice};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,supabase});return {...api,calls};}
test('purchase prices use unique required IDs in batches up to 200, including zero price',async()=>{
 const api=setup(ids=>({data:ids.map(id=>({sclad_id:id,price:id===1?0:10}))}));
 await api.loadPurchasePrices([...Array.from({length:205},(_,i)=>i+1),1,2,0,NaN]);
 assert.equal(api.calls.length,2);assert.equal(api.calls[0].ids.length,200);assert.equal(api.calls[1].ids.length,5);
 assert.equal(api.getPurchasePrice(1),0);assert.equal(api.getPurchasePrice(null),undefined);assert.throws(()=>api.getPurchasePrice(999));
 assert.ok(api.calls.every(c=>c.fields==='sclad_id, price'));
});
test('missing, blank and failed purchase prices stop calculation',async()=>{
 for(const response of [{data:[]},{data:[{sclad_id:1,price:null}]},{data:[{sclad_id:1,price:' '}]},{error:{message:'network'}}]){
  const api=setup(()=>response);await assert.rejects(api.loadPurchasePrices([1]));
 }
});
test('saving gathers old, fresh and DOM stock IDs; payroll stock query is bounded',()=>{
 assert.ok(source.includes('for (const snapshot of [originalActData, freshActData])'));
 assert.ok(source.includes('priceIds.add(Number(detail.sclad_id))'));
 assert.ok(source.includes('priceIds.add(Number(node.dataset.scladId))'));
 assert.ok(source.includes('scladIdsToFetch.slice(offset, offset + 200)'));
 assert.ok(source.includes('scladIdsToFetch.some(id => !priceMap.has(id))'));
});
