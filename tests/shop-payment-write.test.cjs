const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');const api={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/bukhhalteriya/shopPaymentWrite.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,structuredClone,require:()=>({supabase:{},accountingSearchScope:()=> 'actor',missingAccountingRpc:(_,error)=>error})});
const shop=()=>({Name:'Shop',Історія:{d:[{Акт:1,Деталі:[{Ціна:25}]},{Акт:2}]}});
test('shop payments preserve unrelated concurrent history and settings',()=>{
 const base=shop(),next=shop(),fresh=shop();next.Історія.d[0].Розрахунок='11.10.2026';fresh.Name='New';fresh.Історія.d[1].Розрахунок='10.10.2026';fresh.private={keep:true};
 const result=api.mergeShopPayments(base,next,fresh);
 assert.equal(result.Name,'New');assert.equal(result.private.keep,true);
 assert.equal(result.Історія.d[0].Розрахунок,'11.10.2026');assert.equal(result.Історія.d[1].Розрахунок,'10.10.2026');
 assert.equal(fresh.Історія.d[0].Розрахунок,undefined);
});
test('shop payments reject changed details, ambiguous entries and concurrent settlement',()=>{
 const base=shop(),next=shop(),fresh=shop();next.Історія.d[0].Розрахунок='11.10.2026';fresh.Історія.d[0].Розрахунок='09.10.2026';
 assert.throws(()=>api.mergeShopPayments(base,next,fresh));delete fresh.Історія.d[0].Розрахунок;
 fresh.Історія.d[0].Деталі[0].Ціна=30;assert.throws(()=>api.mergeShopPayments(base,next,fresh));
 fresh.Історія.d.push({Акт:1});assert.throws(()=>api.mergeShopPayments(base,next,fresh));
});
test('shop payment retries are idempotent and unpay removes only settlement',()=>{
 const base=shop(),next=shop();base.Історія.d[0].Розрахунок='old';
 const result=api.mergeShopPayments(base,next,base);assert.equal(result.Історія.d[0].Розрахунок,undefined);
 assert.equal(api.mergeShopPayments(base,next,result).Історія.d[0].Деталі[0].Ціна,25);
});
test('legacy whole-act writer sends only changed fragment and no repeat write',async()=>{
 const raw=shop();raw.Історія.d[0].__payment_fingerprint='a'.repeat(64);
 const unchanged=api.trackShopPaymentData(1,raw),changed=api.trackShopPaymentData(2,structuredClone(raw));changed.Історія.d[0].Розрахунок='2026-10-21';
 const calls=[],client={rpc:async(name,args)=>{calls.push({name,args});return {data:[{id:2,status:'saved'}]}}};
 await api.saveShopPayments([unchanged,changed],client);assert.equal(calls.length,1);assert.equal(calls[0].name,'write_shop_payment_fragments');assert.equal(calls[0].args.p_shops[0].changes.length,1);assert.equal(calls[0].args.p_shops[0].data,undefined);
 await api.saveShopPayments([unchanged,changed],client);assert.equal(calls.length,1);
});
test('page baseline containing only whole selected act entries preserves all omitted history',()=>{
 const fresh=shop();fresh.Склад={catalog:'keep'};fresh.Історія.old=[{Акт:8,Деталі:[{Ціна:100}]}];
 const base={Name:'Shop',Історія:{d:[structuredClone(fresh.Історія.d[0])]}};
 const next=structuredClone(base);next.Історія.d[0].Розрахунок='today';
 const result=api.mergeShopPayments(base,next,fresh);
 assert.equal(result.Історія.d[0].Розрахунок,'today');assert.deepEqual(result.Історія.d[1],fresh.Історія.d[1]);assert.deepEqual(result.Історія.old,fresh.Історія.old);assert.deepEqual(result.Склад,fresh.Склад);
 fresh.Історія.d[0].Деталі.push({Ціна:50});assert.throws(()=>api.mergeShopPayments(base,next,fresh),/Деталі акта змінилися/);
});
test('detail RPC carries only compact exact rows and verifies unique receipts',async()=>{
 const row={rowId:'1:d:1:1',shopId:1,dateOpen:'d',act:'7',entryOrdinal:1,detailOrdinal:1,paymentFingerprint:'a'.repeat(64),paymentDate:'',isPaid:false,history:'private'};
 let calls=0;const client={rpc:async(name,args)=>{calls++;assert.equal(name,'write_shop_detail_payments');assert.equal(args.p_changes[0].history,undefined);return {data:[{rowId:row.rowId,paidAt:'2026-10-21',fingerprint:row.paymentFingerprint}]}}};
 await api.saveDetailPayments([row],'2026-10-21',client);assert.equal(calls,1);
 await assert.rejects(api.saveDetailPayments([row,row],'2026-10-21',client),/Повторні/);assert.equal(calls,1);
 await assert.rejects(api.saveDetailPayments([row],'2026-10-21',{rpc:async()=>({data:[]})}),/підтвердження/);
});
test('stock RPC does not read data, protects unique IDs and receives only payment fingerprint',async()=>{
 const row={sclad_id:2,paymentFingerprint:'b'.repeat(64),rosraxovano:null,history:'private'};let calls=0;
 const client={rpc:async(name,args)=>{calls++;assert.equal(name,'write_stock_payment_rows');assert.deepEqual(Object.keys(args.p_changes[0]).sort(),['desired','expected','fingerprint','id']);return {data:[{id:2,paidAt:'2026-10-21',fingerprint:row.paymentFingerprint}]}}};
 await api.saveStockPayments([row],'2026-10-21',client);assert.equal(calls,1);
 await assert.rejects(api.saveStockPayments([row,row],'2026-10-21',client),/Повторні/);assert.equal(calls,1);
 await assert.rejects(api.saveStockPayments([{...row,paymentFingerprint:''}],'2026-10-21',client),/SQL/);
});
