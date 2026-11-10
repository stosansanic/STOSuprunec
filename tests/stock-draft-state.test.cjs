const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/stockDraftState.ts', 'utf8');
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
const { collectStockDrafts, mergeStockDrafts } = context.exports;

test('new imported rows and edited existing rows survive a filter change', () => {
  const edited = { _scladId: 12, qty: 4, detail: 'Болт' };
  const imported = { detail: 'Гайка', qty: 5, _invoiceOrigin: 'invoice:1' };
  const untouched = { _scladId: 13, qty: 2 };
  const originals = new Map([[12, { ...edited, qty: 3 }], [13, { ...untouched }]]);
  const drafts = collectStockDrafts([edited, imported, untouched], originals, new WeakMap());
  const merged = mergeStockDrafts([{ _scladId: '12', qty: 9 }, { _scladId: 14 }], drafts);
  assert.equal(merged.length, 3);
  assert.equal(merged[0], edited);
  assert.equal(merged[1], imported);
  assert.equal(merged[2]._scladId, 14);
  assert.equal(originals.get(12).qty, 3);
});

test('empty default rows do not accumulate, but edits to any default are preserved', () => {
  const blank = { qty: 0, price: 0, warehouse: '1', date: '2026-10-07', createdBy: 'User' };
  const defaults = new WeakMap([[blank, { ...blank }]]);
  assert.equal(collectStockDrafts([blank], new Map(), defaults).length, 0);
  blank.warehouse = '2';
  assert.equal(collectStockDrafts([blank], new Map(), defaults)[0], blank);
});

test('validation-only changes are clean, manual pricing changes are dirty', () => {
  const row = { _scladId: 1, price: 20, clientPriceManual: false, status: 'Помилка' };
  const originals = new Map([[1, { ...row }]]);
  row.status = 'Готовий';
  assert.equal(collectStockDrafts([row], originals, new WeakMap()).length, 0);
  row.clientPriceManual = true;
  assert.equal(collectStockDrafts([row], originals, new WeakMap()).length, 1);
});

test('successful rows use the saved baseline; later edits are not discarded by status', () => {
  const row = { detail: 'Болт', qty: 3, status: '✅ Успішно' };
  const saved = new WeakMap([[row, { ...row }]]);
  assert.equal(collectStockDrafts([row], new Map(), saved).length, 0);
  row.qty = 4;
  assert.equal(collectStockDrafts([row], new Map(), saved).length, 1);
});

test('a failed act link remains visible for an explicit retry', () => {
  const row = { _scladId: 1, status: '⚠️ Збережено (акт не оновлено)' };
  assert.equal(collectStockDrafts([row], new Map([[1, { ...row }]]), new WeakMap()).length, 1);
});

test('repeated filter merging never duplicates an edited stock row', () => {
  const row = { _scladId: 1, qty: 2 };
  let merged = [row];
  const originals = new Map([[1, { ...row, qty: 1 }]]);
  for (let i = 0; i < 5; i++) merged = mergeStockDrafts([{ _scladId: 1, qty: 1 }], collectStockDrafts(merged, originals, new WeakMap()));
  assert.equal(merged.length, 1);
  assert.equal(merged[0], row);
});

function filterHarness() {
  const source = fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/batchImportSclad.ts','utf8');
  const start = source.indexOf('async function applyFilterAndReload(append = false): Promise<void> {');
  const end = source.indexOf('function updateBatchMoreButton',start);
  assert.ok(start >= 0 && end > start);
  const requests = [], rendered = [];
  const element = {value:'',style:{},classList:{add(){},remove(){}},removeAttribute(){}};
  const state = {
    exports:{},isUploading:false,batchReadVersion:0,batchSessionVersion:1,activeFilter:'Замовити',
    batchNextCursor:null,batchPageFilter:'',getBatchCatalogSearchValue:()=>'',updateBatchMoreButton(){},
    document:{getElementById:()=>element},originalSnapshotMap:new Map(),emptyRowSnapshots:new WeakMap(),
    parsedDataGlobal:[],collectStockDrafts,mergeStockDrafts,
    loadScladFilteredRecords:(_status,_from,_to,before,onPage)=>new Promise((resolve,reject)=>requests.push({resolve,reject,before,onPage})),
    saveRowSnapshot:row=>state.originalSnapshotMap.set(row._scladId,{...row}),
    createEmptyRow:()=>({}),renderBatchTable:rows=>rendered.push(rows),showNotification(){},updateFilterButtonsActive(){},
  };
  vm.runInNewContext(ts.transpileModule('export '+source.slice(start,end),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
  }).outputText,state);
  return {state,requests,rendered,apply:state.exports.applyFilterAndReload};
}

test('late filter response cannot overwrite newer rows or original snapshots', async()=>{
  const h=filterHarness(); const first=h.apply(), second=h.apply();
  h.requests[1].resolve([{_scladId:2,qty:2}]); await second;
  h.requests[0].resolve([{_scladId:1,qty:1}]); await first;
  assert.equal(h.state.parsedDataGlobal[0]._scladId,2);
  assert.equal(h.state.originalSnapshotMap.has(1),false);
  assert.equal(h.rendered.length,1);
});

test('edits while loading survive; read error preserves the entire current draft', async()=>{
  const h=filterHarness();const row={_scladId:1,qty:2};
  h.state.parsedDataGlobal=[row];h.state.originalSnapshotMap.set(1,{...row});
  const pending=h.apply();row.qty=3;
  h.requests[0].resolve([{_scladId:1,qty:8}]);await pending;
  assert.equal(h.state.parsedDataGlobal[0],row);
  assert.equal(h.state.originalSnapshotMap.get(1).qty,2);
  const failed=h.apply();h.requests[1].reject(Error('network'));await failed;
  assert.equal(h.state.parsedDataGlobal[0],row);
});

test('closing a stock session prevents a pending read from publishing', async()=>{
  const h=filterHarness();const row={detail:'draft'};h.state.parsedDataGlobal=[row];
  const pending=h.apply();h.state.batchSessionVersion++;
  h.requests[0].resolve([{_scladId:1,qty:8}]);await pending;
  assert.equal(h.state.parsedDataGlobal[0],row);
  assert.equal(h.rendered.length,0);
  assert.equal(h.state.originalSnapshotMap.size,0);
});


test('next stock page appends records and retains dirty rows with original snapshots', async()=>{
  const h=filterHarness(); const first=h.apply(); h.requests[0].onPage(51); h.requests[0].resolve([{_scladId:100,qty:1},{_scladId:51,qty:2}]);await first;
  h.state.parsedDataGlobal[0].qty=7;
  const next=h.apply(true); assert.equal(h.requests[1].before,51);
  h.requests[1].onPage(null); h.requests[1].resolve([{_scladId:50,qty:3}]);await next;
  assert.deepEqual(Array.from(h.state.parsedDataGlobal,row=>row._scladId),[100,51,50]);
  assert.equal(h.state.parsedDataGlobal[0].qty,7);assert.equal(h.state.originalSnapshotMap.get(100).qty,1);
  assert.equal(h.state.batchNextCursor,null);
});
