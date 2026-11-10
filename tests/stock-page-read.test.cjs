const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/stockPageRead.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:api,structuredClone,require:()=>({supabase:{},stockReadRevision:()=>0})});
const args={p_status:'Прибула',p_from:null,p_to:null,p_query:'',p_before:null};
const page=()=>({data:{items:[{sclad_id:1,name:'original'}],has_more:false}});
test('stock page joins pending reads, caches fresh page, copies rows and expires',async()=>{
 let clock=0,calls=0,resolve;const read=api.createStockPageReader({rpc:()=>{calls++;return new Promise(r=>resolve=r)}},()=>clock);
 const a=read(args,'one'),b=read(args,'one');assert.equal(calls,1);resolve(page());
 const [first,second]=await Promise.all([a,b]);first.data.items[0].name='edited';assert.equal(second.data.items[0].name,'original');
 assert.equal((await read(args,'one')).data.items[0].name,'original');assert.equal(calls,1);
 clock=15001;const next=read(args,'one');assert.equal(calls,2);resolve(page());await next;
});
test('stock page invalidates on write/owner change, rejects obsolete response and never caches errors',async()=>{
 let revision=0,calls=0,resolve;const read=api.createStockPageReader({rpc:()=>{calls++;return new Promise(r=>resolve=r)}},()=>0,()=>revision);
 const old=read(args,'one');revision++;resolve(page());await assert.rejects(old,/Склад змінився/);
 const good=read(args,'one');resolve(page());await good;assert.equal(calls,2);
 const other=read(args,'two');resolve({error:{code:'42501'}});assert.equal((await other).error.code,'42501');
 const retry=read(args,'two');resolve(page());await retry;assert.equal(calls,4);
});
test('stock page keeps distinct filters and evicts beyond twenty pages',async()=>{
 let calls=0;const read=api.createStockPageReader({rpc:async()=>{calls++;return page()}},()=>0);
 for(let i=0;i<21;i++) await read({...args,p_query:String(i)},'one');
 await read({...args,p_query:'20'},'one');assert.equal(calls,21);
 await read({...args,p_query:'0'},'one');assert.equal(calls,22);
});
