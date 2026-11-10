const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve,reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
function setup(stage) {
  const source = fs.readFileSync('src/ts/roboha/zakaz_naraudy/modalMain.ts','utf8');
  const start = source.indexOf('let modalOpeningGeneration = 0;');
  const end = source.indexOf('\nasync function fillMissingSlyusarSums', start);
  assert.ok(start >= 0 && end > start);
  const gates = [], notices = [], renders = [];
  let attr = '', hidden = true;
  const modal = {setAttribute: (_key,value) => {attr=value;},getAttribute: () => attr,
    classList:{remove:()=>{hidden=false;},contains:()=>hidden}};
  const body = {dataset:{},innerHTML:'',classList:{toggle(){}}};
  const data = id => ({data:{act_id:id,client_id:id,cars_id:id,data:{}},error:null});
  const globals = {
    module:{exports:{}}, console, Promise,
    document:{getElementById:id=>id==='modal'?modal:body},
    ZAKAZ_NARAYD_MODAL_ID:'modal', ZAKAZ_NARAYD_BODY_ID:'body',
    canUserOpenActs:async()=>true,confirmActNavigation:async()=>true,
    forgetActEditor(){},createModal(){},captureActsTableScrollPosition:()=>null,
    restoreActsTableScrollPosition(){},getSkeletonLoaderHTML:()=>'<skeleton>',
    loadGlobalData:async()=>{},createRequiredModals:async()=>{},
    supabase:{from:()=>({select:()=>({eq:(_field,id)=>({single:()=>{
      if(stage==='act' || gates.length){ const gate=deferred();gates.push(gate);return gate.promise; }
      return Promise.resolve(data(id));
    }})})})},
    canUserSeeZarplataColumn:async()=>true,
    globalCache:{settings:{}},localStorage:{setItem(){},removeItem(){}},
    fetchClientData:()=>{const gate=deferred();gates.push(gate);return gate.promise;},
    fetchCarData:async()=>({}),loadAllModalPermissions:async()=>({}),
    renderModalContent:(...args)=>renders.push(args),
    showNotification:(...args)=>notices.push(args),handleLoadError:(...args)=>notices.push(args),
  };
  globals.exports=globals.module.exports;
  vm.runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,
  }}).outputText,globals);
  return {show:globals.module.exports.showModal,gates,body,renders,notices,data};
}

for (const sameId of [false,true]) test(`older related-data response cannot render after ${sameId?'same-act reopen':'another act opens'}`,async()=>{
  const state=setup('related');
  const old=state.show(1); await tick();
  assert.equal(state.gates.length,1);
  void state.show(sameId?1:2); await tick();
  assert.equal(state.gates.length,2);
  state.gates[0].resolve({}); await old;
  assert.equal(state.renders.length,0);
  assert.equal(state.notices.length,0);
  assert.equal(state.body.innerHTML,'<skeleton>');
});

test('older act load failure cannot overwrite new opening with an error',async()=>{
  const state=setup('act');
  const old=state.show(1); await tick();
  void state.show(2); await tick();
  state.gates[0].reject(Error('old network failure')); await old;
  assert.equal(state.notices.length,0);
  assert.equal(state.body.innerHTML,'<skeleton>');
});

for (const fail of [false,true]) test(`stale QR ${fail?'failure':'success'} cannot initialize warnings for another editor`,async()=>{
  const source=fs.readFileSync('src/ts/roboha/zakaz_naraudy/modalMain.ts','utf8');
  const start=source.indexOf('async function addModalHandlers(');
  const end=source.indexOf('\nfunction expandName',start);
  const gate=deferred(); let current=true; let warnings=0; const notices=[];
  const module={exports:{}};
  const context={module,exports:module.exports,
    globalCache:{isActClosed:false,carId:null},userAccessLevel:'Адміністратор',
    modalStatusState:{actId:1},ensureModalQrToken:async()=>{try{await gate.promise}catch{}},
    ZAKAZ_NARAYD_BODY_ID:'body',
    document:{getElementById:id=>id==='body'||id==='header-qr-canvas'?{}:null},
    window:{QRCode:{}},crypto:{randomUUID:()=> 'test-token'},
    initStatusLockDelegation(){},initFreezeDelegation(){},initPhoneClickHandler(){},
    addSaveHandler(){},initDeleteRowHandler(){},initIndexIconHandler(){},
    patchActData:()=>gate.promise,showNotification:(...args)=>notices.push(args),
    initializeActWarnings:()=>{warnings++;},
  };
  vm.runInNewContext(ts.transpileModule('export '+source.slice(start,end),{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,
  }}).outputText,context);
  const pending=module.exports.addModalHandlers(1,{},'',undefined,()=>current);
  current=false;
  if(fail)gate.reject(Error('old save failed')); else gate.resolve({data:{qr_token:'token'}});
  await pending;
  assert.equal(warnings,0);assert.equal(notices.length,0);
});
