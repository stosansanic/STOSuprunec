const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const base = 'src/ts/roboha/dodatu_inchi_bazu/inhi/';
function element(value = '') {
  const classes = new Set();
  return { value, dataset: {}, style: {}, disabled: false, readOnly: false, title: '', isConnected: true, options: [],
    classList: { contains: key => classes.has(key), add: key => classes.add(key), remove: key => classes.delete(key), toggle: (key, yes) => yes ? classes.add(key) : classes.delete(key) },
    closest: () => null, add(option) { this.options.push(option); }, replaceChildren(...options) { this.options = options; },
    querySelector: () => null, addEventListener() {}, remove() { this.isConnected = false; } };
}
function fixture(file, hooks = '') {
  const exports = {}, nodes = new Map(), calls = [], events = new Map();
  let actor = JSON.stringify({ Name: 'Admin', Доступ: 'Адміністратор' });
  const state = { CRUD: 'Редагувати', updateAllBd: value => { state.draft = value; }, updateTableNameDisplay() {}, updateCRUD(value) {state.CRUD=value;} };
  const directory = { writeDirectory: async (...args) => { calls.push(['write', ...args]); return { status: 'updated', row: { slyusar_id: args[1], data: { ...args[3], ...args[2] } } }; }, deleteDirectory: async (...args) => { calls.push(['delete', ...args]); return {status:'deleted',id:args[1]}; }, clearDirectoryReads() {}, directoryId: kind => kind === 'receivers' ? 'receiver_id' : 'income_id', mountDirectoryDropdown: (...args) => { state.dropdown = args; } };
  const supabase = { rpc: async (...args) => { calls.push(['rpc', ...args]); return {data: null}; }, auth: {onAuthStateChange() {}} };
  const document = { getElementById: id => nodes.get(id) || null, addEventListener: (type, cb) => events.set(type, cb), querySelectorAll: () => [] };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(base + file,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText + '\n' + hooks, {
    exports, require: name => name.includes('supabaseClient') ? {supabase} : name.endsWith('directoryRead') ? directory : name.endsWith('dodatu_inchi_bazu_danux') ? state : name.endsWith('auditLogger') ? {logAction: async (...args) => calls.push(['audit', ...args])} : {showNotification(...args) {calls.push(["notify",...args]);},setupEnterNavigationForFields() {}},
    document, localStorage:{getItem:()=>actor}, window:{addEventListener(){}}, Option:class {constructor(text,value){this.text=text;this.value=value;}}, AbortController, setTimeout, clearTimeout, structuredClone, console,
  });
  return {api:exports,nodes,calls,directory,state,supabase,events,document,setActor:value=>actor=value};
}
const staffHooks = 'exports.inspect = { activate() {currentConfig={table:"slyusars",field:"data"};}, selectById: selectEmployee, selectCurrent: selectCurrentEmployee, clear: clearSlusarInputs, fillWarehouses: fillEmployeeWarehouseOptions, get row() {return selectedEmployeeRow;}, fill: fillSlusarInputs, warehouses: getWarehouseNumbers, clearAuxiliary: clearEmployeeAuxiliaryReads, stats: fetchAndDisplayEmployeeStats, select(row) { selectedEmployeeRow=row; lastValidSlyusarId=row.slyusar_id; selectedEmployeeOwner=localStorage.getItem("userAuthData"); currentConfig={table:"slyusars",field:"data"}; fillSlusarInputs(row.data,row.data.Name); } };';
function staffFixture() {
  const f=fixture('slusar.ts',staffHooks);
  for(const id of ['search-input-all_other_bases','slusar-password','slusar-access','slusar-percent','slusar-percent-parts','slusar-warehouse']) f.nodes.set(id,element());
  return f;
}
test('employee selection resets missing fields and never exposes a saved password',()=>{
 const f=staffFixture();
 f.api.inspect.select({slyusar_id:5,data:{Name:'A',Доступ:'Запчастист',ПроцентРоботи:80,ПроцентЗапчастин:40,Склад:3,Пароль:'secret-hash'}});
 assert.equal(f.nodes.get('slusar-password').value,'');
 f.api.inspect.select({slyusar_id:6,data:{Name:'B'}});
 assert.equal(f.nodes.get('slusar-access').value,'Слюсар');assert.equal(f.nodes.get('slusar-percent').value,'50');assert.equal(f.nodes.get('slusar-percent-parts').value,'0');assert.equal(f.nodes.get('slusar-warehouse').value,'0');
});
test('unchanged legacy employee sends no write or audit and does not persist displayed defaults',async()=>{
 const f=staffFixture();f.api.inspect.select({slyusar_id:5,data:{Name:'A'}});
 assert.equal(await f.api.saveSlusarData(),true);assert.deepEqual(f.calls,[]);
});
test('employee edit sends only changed fields and retains original password baseline',async()=>{
 const f=staffFixture();f.api.inspect.select({slyusar_id:5,data:{Name:'A',ПроцентРоботи:50,Пароль:'old-hash'}});
 f.nodes.get('slusar-percent').value='60';await f.api.saveSlusarData();
 const call=f.calls.find(row=>row[0]==='write');assert.deepEqual(JSON.parse(JSON.stringify(call[3])),{ПроцентРоботи:60});assert.equal(call[4].Пароль,'old-hash');assert.equal(call[3].Історія,undefined);
});
test('staff write conflicts surface original error and preserve current draft',async()=>{
 const f=staffFixture();f.api.inspect.select({slyusar_id:5,data:{Name:'A',ПроцентРоботи:50}});f.nodes.get('slusar-percent').value='65';
 const conflict=new Error('Поле змінено іншим користувачем');f.directory.writeDirectory=async()=>{throw conflict;};
 await assert.rejects(f.api.saveSlusarData(),error=>error===conflict);assert.equal(f.nodes.get('slusar-percent').value,'65');
});
test('staff invalid percent is rejected before write and add input is not silently clamped',async()=>{
 const f=staffFixture();f.api.inspect.select({slyusar_id:5,data:{Name:'A'}});f.nodes.get('slusar-percent-parts').value='150';
 await assert.rejects(f.api.saveSlusarData(),/Відсоток/);assert.throws(()=>f.api.getSlusarAdditionalData(),/Відсоток/);assert.deepEqual(f.calls,[]);
});
test('non-admin edits cannot alter financial fields or another user metadata',()=>{
 const f=staffFixture(), before={Name:'A',Доступ:'Слюсар',ПроцентРоботи:50,ПроцентЗапчастин:0,Склад:0};
 const patch=f.api.employeeMetadataPatch(before,before,{...before,Name:'Other',ПроцентРоботи:99,Пароль:'new'},false,5);
 assert.deepEqual(JSON.parse(JSON.stringify(patch)),{Пароль:'new'});
});
test('protected employee name and role remain unchanged while explicit percent edits remain possible',()=>{
 const f=staffFixture(), before={Name:'Admin',Доступ:'Адміністратор',ПроцентРоботи:50};
 assert.deepEqual(JSON.parse(JSON.stringify(f.api.employeeMetadataPatch(before,before,{...before,Name:'Other',Доступ:'Слюсар',ПроцентРоботи:60},true,1))),{ПроцентРоботи:60});
});
const contractorHooks = 'exports.inspect = { choose(row) {exports.contragentData=[...exports.contragentData.filter(old=>old.faktura_id!==row.faktura_id),row];selectedContragentId=row.faktura_id;require("../dodatu_inchi_bazu_danux").updateAllBd(JSON.stringify({table:"faktura",...row}));}, get selectedId() {return selectedContragentId;}, select(row) { exports.contragentData=[row]; selectedContragentId=row.faktura_id; contragentOwner=localStorage.getItem("userAuthData"); contragentController=new AbortController(); }, setRecipientState };';
function contractorFixture(row={faktura_id:7,name:'Company',oderjyvach:'Receiver',prumitka:'',data:null,namber:null}) {
 const f=fixture('contragent.ts',contractorHooks);
 for(const [id,value] of Object.entries({'contragent-name':row.name,'contragent-receiver':row.oderjyvach,'contragent-note':row.prumitka||'','contragent-date':'','contragent-namber':row.namber==null?'':String(row.namber)})) f.nodes.set(id,element(value));
 f.nodes.set('contragent-recipient-toggle',element());f.nodes.set('contragent-form',element());
 f.api.inspect.select(row);f.api.inspect.setRecipientState(row.namber!=null);return f;
}
test('contractor no-op sends neither RPC nor audit even if old optional fields are null',async()=>{
 const f=contractorFixture({faktura_id:7,name:'Company',oderjyvach:'Receiver',prumitka:null,data:null,namber:null});
 assert.equal(await f.api.tryHandleFakturaCrud(),true);assert.deepEqual(f.calls,[]);
});
test('contractor delta includes only edited field and its original baseline',async()=>{
 const f=contractorFixture();f.nodes.get('contragent-name').value='Updated';
 f.supabase.rpc=async(name,args)=>{f.calls.push(['rpc',name,args]);return{data:{faktura_id:7,name:'Updated',oderjyvach:'Receiver',prumitka:'',data:null,namber:null}};};
 assert.equal(await f.api.tryHandleFakturaCrud(),true);
 const params=f.calls.find(row=>row[0]==='rpc')[2];assert.deepEqual(JSON.parse(JSON.stringify(params.p_patch)),{name:'Updated'});assert.deepEqual(JSON.parse(JSON.stringify(params.p_expected)),{name:'Company'});
});
test('contractor recipient toggle hydrates, can clear number, and full reset clears all selection',async()=>{
 const f=contractorFixture({faktura_id:7,name:'Company',oderjyvach:'Receiver',prumitka:'',data:null,namber:123});
 assert.equal(f.nodes.get('contragent-recipient-toggle').dataset.active,'true');assert.equal(f.nodes.get('contragent-namber').style.display,'');
 const patch=f.api.contragentMetadataPatch({faktura_id:7,name:'Company',oderjyvach:'Receiver',prumitka:'',data:null,namber:123},{name:'Company',oderjyvach:'Receiver',prumitka:'',data:null,namber:null});assert.deepEqual(JSON.parse(JSON.stringify(patch)),{namber:null});
 f.api.clearFormFields();assert.equal(f.nodes.get('contragent-namber').value,'');assert.equal(f.nodes.get('contragent-recipient-toggle').dataset.active,'false');
 f.state.CRUD='Видалити';await assert.rejects(f.api.tryHandleFakturaCrud(),/Виберіть контрагента/);assert.deepEqual(f.calls,[]);
});
test('missing contractor write receipt is rejected and current draft retained',async()=>{
 const f=contractorFixture();f.nodes.get('contragent-name').value='New';
 await assert.rejects(f.api.tryHandleFakturaCrud(),/підтвердження/);assert.equal(f.nodes.get('contragent-name').value,'New');assert.equal(f.calls.filter(row=>row[0]==='audit').length,0);
});
test('contractor deletion uses selected ID and original baseline, not typed replacement name',async()=>{
 const f=contractorFixture();f.state.CRUD='Видалити';f.nodes.get('contragent-receiver').value='Unselected different text';
 await f.api.tryHandleFakturaCrud();const call=f.calls.find(row=>row[0]==='delete');assert.equal(call[1],'faktura');assert.equal(call[2],7);assert.equal(call[3].name,'Company');
});
test('contractor stale actor is rejected before request',async()=>{
 const f=contractorFixture();f.setActor('different');f.nodes.get('contragent-name').value='New';await assert.rejects(f.api.tryHandleFakturaCrud(),/відкрийте/);assert.deepEqual(f.calls,[]);
});
for(const [file,kind,handler,id] of [['djerelo.ts','incomes','handleDhereloClick','income_id'],['pruimalnuk.ts','receivers','handlePruimalnikClick','receiver_id']]) test(kind+' clears stale selection on empty input and resets cloned employee restrictions',async()=>{
 const f=fixture(file), old=element(), input=element();old.disabled=true;old.readOnly=true;old.cloneNode=()=>input;old.replaceWith=()=>{};
 f.nodes.set('search-input-all_other_bases',old);f.nodes.set('custom-dropdown-all_other_bases',element());await f.api[handler]();
 assert.equal(input.disabled,false);assert.equal(input.readOnly,false);
 input.value='Selected';f.state.dropdown[3]({[id]:12,data:{Name:'Selected'}});assert.equal(JSON.parse(f.state.draft)[id],12);
 input.value='Rename';f.state.dropdown[4]();assert.equal(JSON.parse(f.state.draft)[id],12);
 input.value='';f.state.dropdown[4]();assert.equal(JSON.parse(f.state.draft)[id],null);
});

test('recipient counter requires a non-negative integer, including zero',async()=>{
 const f=contractorFixture();f.state.CRUD='Додати';f.api.inspect.setRecipientState(true);
 for (const value of ['', '-1', '1.5', 'NaN']) {
   f.nodes.get('contragent-namber').value=value;await assert.rejects(f.api.tryHandleFakturaCrud(),/початковий номер/);
 }
 assert.deepEqual(f.calls,[]);
 f.nodes.get('contragent-namber').value='0';f.supabase.rpc=async(name,args)=>{f.calls.push(['rpc',name,args]);return{data:{faktura_id:8,name:'Company',oderjyvach:'Receiver',prumitka:'',data:null,namber:0}};};
 await f.api.tryHandleFakturaCrud();assert.equal(f.calls.find(row=>row[0]==='rpc')[2].p_patch.namber,0);
});

test('warehouse IDs share an in-flight request and cache until modal invalidation',async()=>{
 const f=staffFixture();let calls=0,finish;
 f.supabase.from=()=>{calls++;const chain={select:()=>chain,not:()=>chain,then(resolve,reject){return new Promise(done=>finish=done).then(resolve,reject)}};return chain;};
 const a=f.api.inspect.warehouses(),b=f.api.inspect.warehouses();await Promise.resolve();finish({data:[{setting_id:2},{setting_id:2},{setting_id:7}]});
 assert.deepEqual(JSON.parse(JSON.stringify(await a)),[0,2,7]);await b;await f.api.inspect.warehouses();assert.equal(calls,1);
 f.api.inspect.clearAuxiliary();const c=f.api.inspect.warehouses();await Promise.resolve();finish({data:[{setting_id:3}]});assert.deepEqual(JSON.parse(JSON.stringify(await c)),[0,3]);assert.equal(calls,2);
});
test('employee role counts use one aggregate without fetching employee profiles',async()=>{
 const f=staffFixture();f.api.inspect.select({slyusar_id:1,data:{Name:'Admin'}});let requests=0;
 f.directory.readDirectory=async()=>assert.fail('statistics must not fetch employee profiles');
 f.supabase.rpc=async name=>{requests++;assert.equal(name,'traffic_employee_counts');return {data:{Слюсар:50,Приймальник:1},error:null};};
 const container=element();await f.api.inspect.stats(container);assert.equal(requests,1);assert.match(container.textContent,/Слюсар: 50/);assert.match(container.textContent,/Приймальник: 1/);assert.deepEqual(f.calls,[]);
});
test('contractor delete ignores unsaved invalid form fields and still targets selected record',async()=>{
 const f=contractorFixture({faktura_id:7,name:'Company',oderjyvach:'Receiver',prumitka:'',data:null,namber:5});
 f.state.CRUD='Видалити';f.nodes.get('contragent-namber').value='invalid';await f.api.tryHandleFakturaCrud();assert.equal(f.calls.find(row=>row[0]==='delete')[2],7);
});


function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

test('employee A then B ignores the later A response and retains B profile',async()=>{
 const f=staffFixture();f.api.inspect.activate();const reads=new Map([[5,deferred()],[6,deferred()]]);
 f.directory.readDirectory=async(kind,query,offset,exact,id)=>reads.get(id).promise;
 const input=f.nodes.get('search-input-all_other_bases');input.value='A';const first=f.api.inspect.selectById(5,input);input.value='B';const second=f.api.inspect.selectById(6,input);
 reads.get(6).resolve({items:[{slyusar_id:6,data:{Name:'B',ПроцентРоботи:65}}],total:1});await second;
 reads.get(5).resolve({items:[{slyusar_id:5,data:{Name:'A',ПроцентРоботи:10}}],total:1});await first;
 assert.equal(f.api.inspect.row.slyusar_id,6);assert.equal(input.value,'B');assert.equal(f.nodes.get('slusar-percent').value,'65');assert.equal(JSON.parse(f.state.draft).slyusar_id,6);
});

test('clearing staff selection invalidates a still-pending profile response',async()=>{
 const f=staffFixture();f.api.inspect.activate();const job=deferred();f.directory.readDirectory=()=>job.promise;
 const input=f.nodes.get('search-input-all_other_bases');input.value='A';const load=f.api.inspect.selectById(5,input);input.value='';f.api.inspect.clear();
 job.resolve({items:[{slyusar_id:5,data:{Name:'A'}}],total:1});await load;assert.equal(f.api.inspect.row,null);assert.equal(input.value,'');assert.equal(f.nodes.get('slusar-percent').value,'50');
});

test('closed/reopened staff form cannot be repopulated by the old selection response',async()=>{
 const f=staffFixture();f.api.inspect.activate();const job=deferred();f.directory.readDirectory=()=>job.promise;
 const input=f.nodes.get('search-input-all_other_bases');input.value='A';const load=f.api.inspect.selectById(5,input);
 f.api.removeSlusarAdditionalInputs();f.api.inspect.activate();input.value='new draft';
 job.resolve({items:[{slyusar_id:5,data:{Name:'A'}}],total:1});await load;assert.equal(f.api.inspect.row,null);assert.equal(input.value,'new draft');
});

test('profile response from a previous actor never changes the active form',async()=>{
 const f=staffFixture();f.api.inspect.activate();const job=deferred();f.directory.readDirectory=()=>job.promise;
 const input=f.nodes.get('search-input-all_other_bases');input.value='A';const load=f.api.inspect.selectById(5,input);f.setActor('new actor');
 job.resolve({items:[{slyusar_id:5,data:{Name:'A'}}],total:1});await load;assert.equal(f.api.inspect.row,null);assert.equal(f.calls.length,0);
});

test('own employee profile uses one ID lookup rather than matching possibly duplicate names',async()=>{
 const f=staffFixture();f.api.inspect.activate();const requests=[];
 f.directory.readDirectory=async(...args)=>{requests.push(args);return{items:[{slyusar_id:7,data:{Name:'Same name'}}],total:1};};
 const input=f.nodes.get('search-input-all_other_bases');input.value='Same name';await f.api.inspect.selectCurrent({id:7,name:'Same name'},input);
 assert.equal(requests.length,1);assert.equal(requests[0][4],7);assert.equal(requests[0][1],'');assert.equal(f.api.inspect.row.slyusar_id,7);
});

test('non-admin cannot edit another employee with an identical displayed name',async()=>{
 const f=staffFixture();f.setActor(JSON.stringify({slyusar_id:6,Name:'Same name',Доступ:'Слюсар'}));f.api.inspect.select({slyusar_id:5,data:{Name:'Same name',Пароль:'old'}});
 f.nodes.get('slusar-password').value='new';await assert.rejects(f.api.saveSlusarData(),/власний пароль/);assert.deepEqual(f.calls,[]);
});

test('own-password edit does not validate or rewrite disabled legacy payroll percentages',async()=>{
 const f=staffFixture();f.setActor(JSON.stringify({slyusar_id:5,Name:'A',Доступ:'Слюсар'}));f.api.inspect.select({slyusar_id:5,data:{Name:'A',ПроцентРоботи:150,Пароль:'old'}});
 f.nodes.get('slusar-password').value='new';await f.api.saveSlusarData();const call=f.calls.find(row=>row[0]==='write');assert.deepEqual(JSON.parse(JSON.stringify(call[3])),{Пароль:'new'});
});

test('late employee save receipt does not overwrite a newer selection',async()=>{
 const f=staffFixture();f.api.inspect.select({slyusar_id:5,data:{Name:'A',ПроцентРоботи:50}});f.nodes.get('slusar-percent').value='60';const job=deferred();f.directory.writeDirectory=()=>job.promise;
 const save=f.api.saveSlusarData();f.api.inspect.select({slyusar_id:6,data:{Name:'B',ПроцентРоботи:70}});
 job.resolve({status:'updated',row:{slyusar_id:5,data:{Name:'A',ПроцентРоботи:60}}});await save;
 assert.equal(f.api.inspect.row.slyusar_id,6);assert.equal(f.nodes.get('search-input-all_other_bases').value,'B');assert.equal(f.nodes.get('slusar-percent').value,'70');
});

test('late employee save receipt cannot recreate selection in a closed form',async()=>{
 const f=staffFixture();f.api.inspect.select({slyusar_id:5,data:{Name:'A',ПроцентРоботи:50}});f.nodes.get('slusar-percent').value='60';const job=deferred();f.directory.writeDirectory=()=>job.promise;
 const save=f.api.saveSlusarData();f.api.removeSlusarAdditionalInputs();f.nodes.get('search-input-all_other_bases').value='another tab';
 job.resolve({status:'updated',row:{slyusar_id:5,data:{Name:'A',ПроцентРоботи:60}}});await save;
 assert.equal(f.api.inspect.row,null);assert.equal(f.nodes.get('search-input-all_other_bases').value,'another tab');
});

test('warehouse list completion preserves the user current choice instead of the saved baseline',()=>{
 const f=staffFixture();f.api.inspect.select({slyusar_id:5,data:{Name:'A',Склад:3}});const select=f.nodes.get('slusar-warehouse');select.value='8';
 f.api.inspect.fillWarehouses(select,[0,2,3]);assert.equal(select.value,'8');assert.ok(select.options.some(option=>option.value==='8'));
 f.api.inspect.fillWarehouses(select,[]);assert.equal(select.value,'8');
});

test('contractor conflict invalidates cached baseline without retry or discarding draft',async()=>{
 const f=contractorFixture();f.nodes.get('contragent-name').value='Draft';const conflict={message:'counter changed',code:'40001'};let invalidations=0,requests=0;
 f.directory.clearDirectoryReads=()=>invalidations++;f.supabase.rpc=async()=>{requests++;return{error:conflict,data:null};};
 await assert.rejects(f.api.tryHandleFakturaCrud(),error=>error===conflict);assert.equal(invalidations,1);assert.equal(requests,1);assert.equal(f.nodes.get('contragent-name').value,'Draft');
});

test('contractor write receipt retains a newer selection made during the request',async()=>{
 const f=contractorFixture();f.nodes.get('contragent-name').value='Updated A';const job=deferred();f.supabase.rpc=()=>job.promise;const save=f.api.tryHandleFakturaCrud();
 const other={faktura_id:8,name:'B',oderjyvach:'B',prumitka:'',data:null,namber:null};f.api.inspect.choose(other);
 job.resolve({error:null,data:{faktura_id:7,name:'Updated A',oderjyvach:'Receiver',prumitka:'',data:null,namber:null}});await save;
 assert.equal(f.api.inspect.selectedId,8);assert.equal(JSON.parse(f.state.draft).faktura_id,8);
});

test('contractor delete receipt does not clear a newer selected contractor',async()=>{
 const f=contractorFixture();f.state.CRUD='Видалити';const job=deferred();f.directory.deleteDirectory=()=>job.promise;const save=f.api.tryHandleFakturaCrud();
 f.api.inspect.choose({faktura_id:8,name:'B',oderjyvach:'B',prumitka:'',data:null,namber:null});job.resolve({status:'deleted',id:7});await save;
 assert.equal(f.api.inspect.selectedId,8);assert.equal(JSON.parse(f.state.draft).faktura_id,8);assert.equal(f.api.contragentData.some(row=>row.faktura_id===7),false);
});

test('reopened contractor form ignores the former form write receipt',async()=>{
 const f=contractorFixture();f.nodes.get('contragent-name').value='Updated A';const job=deferred();f.supabase.rpc=()=>job.promise;const save=f.api.tryHandleFakturaCrud();
 f.api.clearContragentForm();f.nodes.set('contragent-form',element());f.api.inspect.select({faktura_id:8,name:'B',oderjyvach:'B',prumitka:'',data:null,namber:null});
 job.resolve({error:null,data:{faktura_id:7,name:'Updated A',oderjyvach:'Receiver',prumitka:'',data:null,namber:null}});await save;
 assert.equal(f.api.inspect.selectedId,8);assert.equal(f.api.contragentData.length,1);assert.equal(f.api.contragentData[0].faktura_id,8);
});


test('staff statistics ignore the aggregate response after their form closes',async()=>{
 const f=staffFixture();f.api.inspect.activate();const container=element();let reads=0;
 f.supabase.rpc=async name=>{reads++;assert.equal(name,'traffic_employee_counts');container.isConnected=false;return {data:{Слюсар:500},error:null};};
 await f.api.inspect.stats(container);assert.equal(reads,1);assert.equal(container.textContent,undefined);
 await f.api.inspect.stats(null);assert.equal(reads,1);
});


test('non-admin section initialization rejects a failed own-profile read and succeeds on retry',async()=>{
 const f=staffFixture();f.setActor(JSON.stringify({slyusar_id:5,Name:'A',Доступ:'Слюсар'}));f.document.querySelector=()=>null;
 let requests=0;const failure=new Error('profile service unavailable');
 f.directory.readDirectory=async(kind,query,offset,exact,id)=>{requests++;assert.equal(id,5);if(requests===1)throw failure;return{items:[{slyusar_id:5,data:{Name:'A',Доступ:'Слюсар'}}],total:1};};
 await assert.rejects(f.api.handleSlusarClick(),error=>error===failure);
 assert.equal(f.state.draft,null);assert.equal(f.calls.filter(row=>row[0]==='notify').length,0,'parent section displays the initialization error once');
 await f.api.handleSlusarClick();assert.equal(requests,2);assert.equal(f.api.inspect.row.slyusar_id,5);assert.equal(JSON.parse(f.state.draft).slyusar_id,5);assert.equal(f.state.CRUD,'Редагувати');
});

test('normal employee dropdown failures remain locally handled without an unhandled rejection',async()=>{
 const f=staffFixture();f.api.inspect.activate();f.nodes.get('search-input-all_other_bases').value='A';f.directory.readDirectory=async()=>{throw new Error('profile unavailable');};
 await f.api.inspect.selectById(5,f.nodes.get('search-input-all_other_bases'));assert.equal(f.api.inspect.row,null);assert.equal(f.calls.filter(row=>row[0]==='notify').length,1);assert.match(f.calls[0][1],/profile unavailable/);
});

test('legacy own-profile initialization rejects a missing name match instead of marking the section ready',async()=>{
 const f=staffFixture();f.api.inspect.activate();const input=f.nodes.get('search-input-all_other_bases');input.value='Missing';f.directory.readDirectory=async()=>({items:[],total:0});
 await assert.rejects(f.api.inspect.selectCurrent({id:null,name:'Missing'},input),/профіль працівника не знайдено/);assert.equal(f.api.inspect.row,null);assert.equal(f.calls.length,0);
});
