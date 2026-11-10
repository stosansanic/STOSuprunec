const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');

function fixture(read) {
  const calls = [], errors = [];
  const row = { removed:false, replacement:null, remove(){this.removed=true}, contains(){return false}, replaceWith(next){this.replacement=next} };
  const table = {isConnected:true,querySelectorAll:()=>[{textContent:'Сума'}]};
  const container = {dataset:{actTotal:'298'},querySelector:()=>table};
  const ctx = {
    exports:{},rowRefreshVersions:new Map(),rowRefreshSerial:0,tableLoadGeneration:1,labelWriteSerial:0,
    preserveNewerLabelWrite:(_kind,row)=>row,
    actsGlobal:Array.from({length:55},(_,i)=>({act_id:i+1,date_off:null,data:{value:'old'}})),
    clientsGlobal:[],carsGlobal:[],modifiedActIdsGlobal:new Set(),
    activeActPage:{input:{mode:'open',query:''},page:{matched:298,total:298,next_offset:55,has_more:true,items:[]}},
    clearActSearchPages(){},isUserAuthenticated:()=>true,localStorage:{getItem:()=> 'same-user'},
    document:{getElementById:()=>container,activeElement:null},
    findActRowsInTable:()=>[row],
    supabase:{from(name){assert.equal(name,'acts');return {select(){return this},eq(key,id){calls.push({key,id});return this},single:read}}},
    loadClientsFromDB:async()=>[],loadCarsFromDB:async()=>[],mergeCarsIntoGlobal(){},
    normalizeRecordId:Number,isActFrozen:act=>act.data?.Заморожений===true,filterActs:acts=>acts,
    stopActLazyLoading(){ctx.stops=(ctx.stops||0)+1},
    createActTableRow:act=>({act,classList:{remove(){}},focus(){}}),
    renderActPageNavigation(){ctx.rearmed=true},refreshActCounters(){},updateActSearchSummary(){},
    console:{error(...args){errors.push(args)}}
  };
  const path='src/ts/roboha/tablucya/tablucya.ts';
  const ast=ts.createSourceFile(path,fs.readFileSync(path,'utf8'),99,true);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='refreshActRowInTable');
  vm.createContext(ctx);vm.runInContext(ts.transpileModule(fn.getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,ctx);
  return {ctx,row,calls,errors,container};
}

test('saving a visible act replaces only its row and retains all 55 loaded acts and cursor',async()=>{
  const f=fixture(async()=>({data:{act_id:52,date_off:null,data:{value:'saved'}}}));
  const first=f.ctx.actsGlobal[0];
  await f.ctx.exports.refreshActRowInTable(52);
  assert.deepEqual(f.calls,[{key:'act_id',id:52}]);assert.deepEqual(f.errors,[]);
  assert.equal(f.ctx.actsGlobal.length,55);assert.equal(f.ctx.actsGlobal[0],first);
  assert.equal(f.row.replacement.act.data.value,'saved');assert.equal(f.ctx.activeActPage.page.next_offset,55);
  assert.equal(f.container.dataset.actTotal,'298');assert.equal(f.ctx.rearmed,true);
});

test('closing an act in the open filter removes only it and adjusts lazy offset',async()=>{
  const f=fixture(async()=>({data:{act_id:52,date_off:'2026-10-11',data:{}}}));
  await f.ctx.exports.refreshActRowInTable(52);
  assert.deepEqual(f.errors,[]);assert.equal(f.row.removed,true);assert.equal(f.ctx.actsGlobal.length,54);
  assert.equal(f.ctx.activeActPage.page.next_offset,54);assert.equal(f.container.dataset.actTotal,'297');
});

test('a late act read cannot change a newer table filter',async()=>{
  let resolve;const f=fixture(()=>new Promise(r=>resolve=r));
  const pending=f.ctx.exports.refreshActRowInTable(52);f.ctx.tableLoadGeneration++;
  resolve({data:{act_id:52,date_off:null,data:{value:'saved'}}});await pending;
  assert.equal(f.row.replacement,null);assert.equal(f.ctx.actsGlobal[51].data.value,'old');assert.deepEqual(f.errors,[]);
});
