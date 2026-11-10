const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const dir = 'src/ts/roboha/redahyvatu_klient_machuna/';
const plain = value => JSON.parse(JSON.stringify(value));
function element() {
  const listeners = new Map();
  return { style: {}, disabled: false, isConnected: true, textContent: '', classList: { add() {}, remove() {} },
    addEventListener(event, cb) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(cb); },
    removeEventListener(event, cb) { listeners.get(event)?.delete(cb); },
    fire(event='click') { return Promise.all([...(listeners.get(event)||[])].map(cb=>cb())); },
    remove() { this.isConnected=false; }, appendChild() {}, querySelector() { return null; } };
}
function fixture(file='pidtverdutu_sberihannya_PIB_avto.ts') {
  const api={}, calls=[], nodes=new Map(); let actor='actor1', serial=0;
  const values = {client_id:'5',cars_id:'8',fullName:'Client',phone:'+380111111111',income:'Source',extra:'',carModel:'BMW',carNumber:'AA1234',engine:'2',fuel:'Diesel',vin:'ABC123',year:'2005',carCode:'N47'};
  const form = { getModalFormValues:()=>({...values}), userConfirmation:null, formSnapshot:{...values},
    clientRecordBaseline:{client_id:'5',data:{ПІБ:'Client',Телефон:'+380111111111',Джерело:'Source',Додаткові:null}},
    carRecordBaseline:{cars_id:'8',client_id:'5',is_deleted:false,data:{Авто:'BMW','Номер авто':'AA1234',Обʼєм:2,Пальне:'Diesel',Vincode:'ABC123',Рік:2005,КодДВЗ:'N47'}},
    closeModalCreateSakazNarad:()=>calls.push(['close']), transferredActComment:'Repair', setTransferredActComment:value=>{form.transferredActComment=value;},
  };
  const supabase={rpc:async(name,args)=>{calls.push(['rpc',name,args]);return{data:{saved:true,client_id:5,cars_id:8,client_changed:true,car_changed:true,client:form.clientRecordBaseline,car:form.carRecordBaseline}};},
    from(name){calls.push(['from',name]);const chain={update(data){calls.push(['update',data]);return chain;},eq(){return chain;},or(filter){calls.push(['or',filter]);return chain;},select(){return chain;},async maybeSingle(){return{data:{post_arxiv_id:12}};}};return chain;}};
  const users={userAccessLevel:'Приймальник',getSavedUserDataFromLocalStorage:()=>({name:'Receiver'})};
  const audit={logAction:async(...args)=>calls.push(['audit',...args]),diffChanges:(a,b)=>Object.keys(b).filter(k=>a[k]!==b[k])};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(dir+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{
    exports:api,require:name=>name.includes('supabaseClient')?{supabase}:name.endsWith('vikno_klient_machuna')?form:name.endsWith('/users')?users:name.includes('auditLogger')?audit:name.includes('plannerRecordStore')?{getPlannerRecord:()=>({post_arxiv_id:12}),publishPlannerChange:(...args)=>calls.push(['publish',...args])}:{showNotification:(...args)=>calls.push(['notify',...args])},
    document:{getElementById:id=>nodes.get(id)||null,createElement:()=>element(),body:{appendChild(){}}},
    window:{dispatchEvent:event=>calls.push(['event',event.type,event.detail])},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
    localStorage:{getItem:()=>actor},crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++serial).padStart(12,'0')}`},console,Date,Promise,
  });
  return {api,calls,form,values,supabase,nodes,users,audit,setActor:value=>actor=value};
}
function request(f) { return f.api.buildClientCarWriteRequest(f.values,f.form.userConfirmation,f.form.formSnapshot,f.form.clientRecordBaseline,f.form.carRecordBaseline); }
function prompt(f,create=false) {
  const modal=element(),yes=element(),no=element();modal.querySelector=selector=>selector.includes('cancel')?no:yes;
  f.nodes.set(create?'save-prompt-modal-create':'save-prompt-modal',modal);return{modal,yes,no};
}

test('unchanged displayed values send no request, history, or audit despite numeric/raw null fields',async()=>{
  const f=fixture();assert.equal(request(f),null);assert.equal((await f.api.saveClientAndCarToDatabase()).saved,false);
  assert.equal(f.calls.filter(c=>c[0]==='rpc'||c[0]==='audit').length,0);
});
test('edit sends changed cells only with original JSON types, never stored history',()=>{
  const f=fixture();f.values.engine='3';f.values.extra='Note';f.form.carRecordBaseline.data.Історія={large:'history'};
  const r=plain(request(f));assert.deepEqual(r.client_patch,{Додаткові:'Note'});assert.deepEqual(r.client_expected,{Додаткові:null});assert.deepEqual(r.car_patch,{Обʼєм:'3'});assert.deepEqual(r.car_expected,{Обʼєм:2});
  assert.doesNotMatch(JSON.stringify(r),/Історія|large/);
});
test('client-only editing leaves absent car untouched',()=>{
  const f=fixture();f.values.cars_id=null;f.values.carModel='';f.values.fullName='Updated';f.form.carRecordBaseline=null;
  const r=plain(request(f));assert.equal(r.operation,'edit');assert.equal(r.cars_id,null);assert.deepEqual(r.car_patch,{});assert.deepEqual(r.client_patch,{ПІБ:'Updated'});
});
test('soft deletion uses explicit ID and baseline only and never includes client edits',()=>{
  const f=fixture();f.form.userConfirmation='no';f.values.fullName='';f.values.phone='';f.values.carModel='Typed different car';
  const r=plain(request(f));assert.equal(r.operation,'delete');assert.equal(r.cars_id,'8');assert.deepEqual(r.client_patch,{});assert.deepEqual(r.car_patch,{});assert.equal(r.car_expected.Авто,'BMW');
});
test('delete rejects an unselected car or mismatched owner before request',()=>{
  const f=fixture();f.form.userConfirmation='no';f.form.carRecordBaseline.client_id=9;assert.throws(()=>request(f),/Оберіть/);f.form.carRecordBaseline.client_id=5;f.values.cars_id=null;assert.throws(()=>request(f),/Оберіть/);
});
test('edit rejects a stale selected client baseline rather than overwriting a whole record',()=>{
  const f=fixture();f.values.fullName='New';f.form.clientRecordBaseline=null;assert.throws(()=>request(f),/Оберіть клієнта/);
});
test('add mode sends VIN for server restoration and keeps new owner, even with deleted old-owner baseline',()=>{
  const f=fixture();f.form.userConfirmation='yes';f.form.carRecordBaseline.client_id=99;f.form.carRecordBaseline.is_deleted=true;
  const r=plain(request(f));assert.equal(r.operation,'add');assert.equal(r.client_id,'5');assert.equal(r.cars_id,'8');assert.equal(r.car_patch.Vincode,'ABC123');assert.deepEqual(r.client_patch,{});assert.equal(r.car_expected.Рік,2005);
});
test('new client and car are written by one atomic RPC',async()=>{
  const f=fixture();f.form.userConfirmation='yes';f.values.client_id=null;f.values.cars_id=null;f.form.clientRecordBaseline=null;f.form.carRecordBaseline=null;
  f.supabase.rpc=async(name,args)=>{f.calls.push(['rpc',name,args]);return{data:{saved:true,client_id:5,cars_id:8,client_created:true,car_created:true,client:{client_id:5,data:args.p_request.client_patch},car:{cars_id:8,client_id:5,is_deleted:false,data:args.p_request.car_patch}}};};
  const result=await f.api.saveClientAndCarToDatabase();assert.equal(result.saved,true);assert.equal(f.calls.filter(c=>c[0]==='rpc').length,1);assert.equal(f.calls.filter(c=>c[0]==='audit').length,1);assert.equal(f.calls.some(c=>c[0]==='from'),false);
});
test('duplicate clicks share the pending atomic save',async()=>{
  const f=fixture();f.values.fullName='New';let release;f.supabase.rpc=()=>new Promise(resolve=>release=resolve);
  const a=f.api.saveClientAndCarToDatabase(),b=f.api.saveClientAndCarToDatabase();assert.equal(a,b);assert.equal(f.api.isClientCarSavePending(),true);
  release({data:{saved:true,client_id:5,cars_id:8,client: f.form.clientRecordBaseline,car:f.form.carRecordBaseline}});await a;assert.equal(f.api.isClientCarSavePending(),false);
});
test('failed add retains token for identical retry; changed input receives a new token',async()=>{
  const f=fixture();f.form.userConfirmation='yes';f.supabase.rpc=async(name,args)=>{f.calls.push(['rpc',name,plain(args)]);return{error:{message:'Network'}};};
  await f.api.saveClientAndCarToDatabase();await f.api.saveClientAndCarToDatabase();f.values.vin='OTHER';await f.api.saveClientAndCarToDatabase();
  const keys=f.calls.filter(c=>c[0]==='rpc').map(c=>c[2].p_request.request_id);assert.equal(keys[0],keys[1]);assert.notEqual(keys[1],keys[2]);assert.equal(f.calls.some(c=>c[0]==='event'||c[0]==='audit'),false);
});
test('save errors preserve input and expose original conflict message',async()=>{
  const f=fixture();f.values.engine='3';f.supabase.rpc=async()=>({error:{message:'Автівку вже перенесено іншому клієнту'}});
  assert.equal((await f.api.saveClientAndCarToDatabase()).saved,false);assert.equal(f.values.engine,'3');assert.match(f.calls.find(c=>c[0]==='notify')[1],/перенесено/);
});
test('delete receipt clears only car ID and broadcasts hidden car, not a deleted client',async()=>{
  const f=fixture();f.form.userConfirmation='no';f.supabase.rpc=async()=>({data:{saved:true,client_id:5,cars_id:8,car_changed:true,client:f.form.clientRecordBaseline,car:{...f.form.carRecordBaseline,is_deleted:true}}});
  const result=await f.api.saveClientAndCarToDatabase();assert.equal(result.client_id,'5');assert.equal(result.cars_id,null);
  const events=f.calls.filter(c=>c[0]==='event');assert.equal(events.length,1);assert.equal(events[0][1],'sto:car-saved');assert.equal(events[0][2].is_deleted,true);
});
test('save confirmation is deduplicated and cancellation cleans listeners for reopening',async()=>{
  const f=fixture(),p=prompt(f);const first=f.api.showSavePromptModal();assert.equal(first,f.api.showSavePromptModal());f.api.cancelSavePromptModal();assert.equal(await first,false);
  const second=f.api.showSavePromptModal();await p.yes.fire();assert.equal(await second,true);assert.equal(p.modal.style.display,'none');
});
test('missing save confirmation buttons do not leave an unresolved prompt',async()=>{
  const f=fixture();assert.equal(await f.api.showSavePromptModal(),false);
});
test('one act RPC verifies owner and includes receiver at creation without follow-up act PATCH',async()=>{
  const f=fixture('pidtverdutu_sberihannya_zakaz_naryad.ts');f.supabase.rpc=async(name,args)=>{f.calls.push(['rpc',name,args]);return{data:{act_id:101}};};
  assert.equal(await f.api.createActInDatabase(5,8,'Repair'),101);assert.equal(f.calls.filter(c=>c[0]==='rpc').length,1);assert.equal(f.calls.some(c=>c[0]==='from'),false);
  const r=f.calls.find(c=>c[0]==='rpc');assert.equal(r[1],'traffic_client_car_create_act');assert.equal(r[2].p_request.pruimalnyk,'Receiver');
  const event=f.calls.find(c=>c[0]==='event');assert.equal(event[2].created,true);assert.equal(event[2].record.act_id,101);assert.equal(event[2].client.client_id,'5');
});
test('mechanic creation does not assign mechanic as receiving manager',async()=>{
  const f=fixture('pidtverdutu_sberihannya_zakaz_naryad.ts');f.users.userAccessLevel='Слюсар';f.supabase.rpc=async(name,args)=>{f.calls.push(['rpc',name,args]);return{data:{act_id:101}};};
  await f.api.createActInDatabase(5,8);assert.equal(f.calls.find(c=>c[0]==='rpc')[2].p_request.pruimalnyk,null);
});
test('act creation coalesces duplicate requests and retains retry token/date after transient error',async()=>{
  const f=fixture('pidtverdutu_sberihannya_zakaz_naryad.ts');let release;f.supabase.rpc=(name,args)=>{f.calls.push(['rpc',name,plain(args)]);return new Promise(resolve=>release=resolve);};
  const a=f.api.createActInDatabase(5,8,'Repair'),b=f.api.createActInDatabase(5,8,'Repair');assert.equal(a,b);release({error:{message:'Network'}});assert.equal(await a,null);
  const c=f.api.createActInDatabase(5,8,'Repair');release({data:{act_id:101}});assert.equal(await c,101);
  const calls=f.calls.filter(c=>c[0]==='rpc');assert.equal(calls[0][2].p_request.request_id,calls[1][2].p_request.request_id);assert.equal(calls[0][2].p_request.date_on,calls[1][2].p_request.date_on);
});
test('invalid create IDs stop before SQL',async()=>{
  const f=fixture('pidtverdutu_sberihannya_zakaz_naryad.ts');assert.equal(await f.api.createActInDatabase(NaN,8),null);assert.equal(f.calls.some(c=>c[0]==='rpc'),false);
});
test('create confirmation stays usable after error and prevents cancel/double-submit while saving',async()=>{
  const f=fixture('pidtverdutu_sberihannya_zakaz_naryad.ts'),p=prompt(f,true);let release;f.supabase.rpc=(name,args)=>{f.calls.push(['rpc',name,args]);return new Promise(resolve=>release=resolve);};
  const result=f.api.showSaveModalCreate();assert.equal(result,f.api.showSaveModalCreate());const first=p.yes.fire();await p.yes.fire();await p.no.fire();assert.equal(f.calls.filter(c=>c[0]==='rpc').length,1);assert.equal(p.no.disabled,true);
  release({error:{message:'Retry'}});await first;assert.equal(p.yes.disabled,false);const second=p.yes.fire();release({data:{act_id:101}});await second;assert.equal(await result,101);assert.equal(f.calls.filter(c=>c[0]==='close').length,1);
});
test('create cancellation resolves pending dialog before any request',async()=>{
  const f=fixture('pidtverdutu_sberihannya_zakaz_naryad.ts');prompt(f,true);const result=f.api.showSaveModalCreate();f.api.cancelSaveModalCreate();assert.equal(await result,null);assert.equal(f.calls.length,0);
});
test('delete preserves legacy VIN and engine-code keys in its compare baseline',()=>{
  const f=fixture();f.form.userConfirmation='no';delete f.form.carRecordBaseline.data.Vincode;f.form.carRecordBaseline.data.VIN='LEGACY';f.form.carRecordBaseline.data['Код ДВЗ']='OLD';
  const r=plain(request(f));assert.equal(r.car_expected.VIN,'LEGACY');assert.equal(r.car_expected['Код ДВЗ'],'OLD');
});
test('car added while editing an existing client uses add contract and no stale selected ID',()=>{
  const f=fixture();f.values.cars_id=null;f.form.carRecordBaseline=null;const r=plain(request(f));assert.equal(r.operation,'add');assert.equal(r.cars_id,null);assert.deepEqual(r.client_patch,{});
});
test('verified successful add consumes its token so an intentional new add can create another car',async()=>{
  const f=fixture();f.form.userConfirmation='yes';await f.api.saveClientAndCarToDatabase();await f.api.saveClientAndCarToDatabase();
  const calls=f.calls.filter(c=>c[0]==='rpc');assert.notEqual(calls[0][2].p_request.request_id,calls[1][2].p_request.request_id);
});
test('client/car save remains successful when audit logging throws after transaction commit',async()=>{
  const f=fixture();f.values.fullName='New';f.audit.logAction=async()=>{throw new Error('audit unavailable');};assert.equal((await f.api.saveClientAndCarToDatabase()).saved,true);assert.equal(f.calls.some(c=>c[0]==='notify'&&c[2]==='error'),false);
});
test('act ID remains successful when audit logging throws after transaction commit',async()=>{
  const f=fixture('pidtverdutu_sberihannya_zakaz_naryad.ts');f.supabase.rpc=async()=>({data:{act_id:101}});f.audit.logAction=async()=>{throw new Error('audit unavailable');};assert.equal(await f.api.createActInDatabase(5,8),101);
});
test('actor changing during act creation prevents planner write with new credentials',async()=>{
  const f=fixture('pidtverdutu_sberihannya_zakaz_naryad.ts');let release;f.supabase.rpc=()=>new Promise(resolve=>release=resolve);
  const result=f.api.createActInDatabase(5,8,'Repair',12);f.setActor('actor2');release({data:{act_id:101}});assert.equal(await result,101);assert.equal(f.calls.some(c=>c[0]==='from'||c[0]==='event'),false);
});
test('confirmation does not silently save a form changed after the question appeared',async()=>{
  const f=fixture(),p=prompt(f);const result=f.api.showSavePromptModal();f.values.fullName='Different';await p.yes.fire();assert.equal(await result,false);assert.equal(f.calls.some(c=>c[0]==='rpc'),false);
});
test('act creation freezes underlying modal until completion and rejects stale prompt selection',async()=>{
  const f=fixture('pidtverdutu_sberihannya_zakaz_naryad.ts'),p=prompt(f,true),owner=element();f.nodes.set('custom-modal-create-sakaz_narad',owner);let release;f.supabase.rpc=()=>new Promise(resolve=>release=resolve);
  const result=f.api.showSaveModalCreate(),click=p.yes.fire();assert.equal(owner.inert,true);release({error:{message:'Retry'}});await click;assert.equal(owner.inert,false);
  f.values.cars_id='99';await p.yes.fire();assert.equal(await result,null);
});
test('planner binding protects a different act linked concurrently',async()=>{
  const f=fixture('pidtverdutu_sberihannya_zakaz_naryad.ts');f.supabase.rpc=async()=>({data:{act_id:101}});
  assert.equal(await f.api.createActInDatabase(5,8,'Repair',12),101);assert.equal(f.calls.find(c=>c[0]==='or')[1],'act_id.is.null,act_id.eq.101');assert.equal(f.calls.some(c=>c[0]==='publish'),true);
});
test('soft-delete audit does not claim metadata fields were erased',async()=>{
  const f=fixture();f.form.userConfirmation='no';f.audit.diffChanges=(a,b)=>[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>a[k]!==b[k]);
  f.supabase.rpc=async()=>({data:{saved:true,client_id:5,cars_id:8,car_changed:true,client:f.form.clientRecordBaseline,car:{...f.form.carRecordBaseline,is_deleted:true}}});
  await f.api.saveClientAndCarToDatabase();assert.deepEqual(plain(f.calls.find(c=>c[0]==='audit')[3].car_changes),[]);
});
test('canonical VIN and engine-code edits compare legacy aliases before synchronizing them',()=>{
  const f=fixture();delete f.form.carRecordBaseline.data.Vincode;delete f.form.carRecordBaseline.data.КодДВЗ;
  f.form.carRecordBaseline.data.VIN='ABC123';f.form.carRecordBaseline.data['Код ДВЗ']='N47';
  f.values.vin='';f.values.carCode='N57';
  const r=plain(request(f));assert.deepEqual(r.car_patch,{Vincode:'',КодДВЗ:'N57'});
  assert.deepEqual(r.car_expected,{Vincode:null,КодДВЗ:null,VIN:'ABC123','Код ДВЗ':'N47'});
});
test('canonical identity edits guard an absent legacy alias against concurrent insertion',()=>{
  const f=fixture();f.values.vin='NEWVIN';f.values.carCode='N57';
  const r=plain(request(f));assert.equal(r.car_expected.VIN,null);assert.equal(r.car_expected['Код ДВЗ'],null);
  assert.equal(r.car_expected.Vincode,'ABC123');assert.equal(r.car_expected.КодДВЗ,'N47');
});
