const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), vm=require('node:vm'), ts=require('typescript');
const file='src/ts/roboha/redahyvatu_klient_machuna/vikno_klient_machuna.ts';
const tick=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
class Element {
  constructor(id='',tag='input'){this.id=id;this.tag=tag;this.value='';this.children=[];this.handlers={};this.attributes={};this.dataset={};this.style={};this.options=[];this.isConnected=true;this.disabled=false;this.readOnly=false;this.scrollHeight=40;this.selectionStart=0;this.selectionEnd=0;this.parentElement=null;this.textContent='';this.classList={add(){},remove(){}};}
  addEventListener(name,fn){(this.handlers[name] ||= []).push(fn);}
  removeEventListener(name,fn){this.handlers[name]=(this.handlers[name]||[]).filter(x=>x!==fn);}
  dispatch(name,extra={}){const event={target:this,preventDefault(){},stopPropagation(){},stopImmediatePropagation(){},...extra};for(const fn of [...(this.handlers[name]||[])])fn(event);if((name==='input'||name==='change')&&this.parentElement)this.parentElement.dispatch(name,event);}
  click(){if(!this.disabled)this.dispatch('click');}
  appendChild(child){this.children.push(child);child.parentElement=this;child.isConnected=true;return child;}
  add(option){this.options.push(option);}
  replaceChild(next,old){const i=this.children.indexOf(old);if(i>=0)this.children[i]=next;next.parentElement=this;old.isConnected=false;this.register?.(next);}
  remove(){this.isConnected=false;for(const child of this.children)child.remove();}
  setAttribute(key,value){this.attributes[key]=String(value);if(key==='readonly')this.readOnly=true;}
  getAttribute(key){return key.startsWith('data-')?(this.dataset[key.slice(5)]??null):(this.attributes[key]??null);}
  removeAttribute(key){delete this.attributes[key];if(key==='readonly')this.readOnly=false;}
  querySelectorAll(){return this.children.flatMap(child=>[child,...child.querySelectorAll()]).filter(child=>['input','textarea','select','button'].includes(child.tag));}
  focus(){} setSelectionRange(){}
}
class Input extends Element{constructor(id=''){super(id,'input');}}
class Textarea extends Element{constructor(id=''){super(id,'textarea');}}
class Select extends Element{constructor(id=''){super(id,'select');}}
const ids={client:'client-input-create-sakaz_narad',phone:'phone-create-sakaz_narad',model:'car-model-create-sakaz_narad',number:'car-number-input-create-sakaz_narad',vin:'car-vin-create-sakaz_narad',extra:'extra-create-sakaz_narad',income:'car-income-create-sakaz_narad',year:'car-year-create-sakaz_narad',engine:'car-engine-create-sakaz_narad',code:'car-code-create-sakaz_narad',fuel:'car-fuel-create-sakaz_narad',edit:'btn-edit-create-sakaz_narad',save:'btn-save-create-sakaz_narad',create:'btn-create-create-sakaz_narad',mode:'confirm-toggle',close:'close-create-sakaz_narad'};
function fixture(){
 const nodes=new Map(),controllers=new Map(),calls=[],notices=[],events={};let actor='A',finishSave,saveResult,finishPrompt;
 const state={savedCalls:0,promptCalls:0,createCalls:0,cacheClears:0,prompt:true};
 const api={};const document={getElementById:id=>{const n=nodes.get(id);return n?.isConnected?n:null;},addEventListener(){},querySelector:()=>null,createElement:tag=>tag==='input'?new Input():tag==='select'?new Select():new Element('',tag),body:{appendChild(node){nodes.set(node.id,node);node.isConnected=true;}}};
 function makeModal(){const modal=new Element('custom-modal-create-sakaz_narad','div');for(const [key,id]of Object.entries(ids)){const el=key==='client'?new Textarea(id):['edit','save','create','mode','close'].includes(key)?new Element(id,'button'):new Input(id);nodes.set(id,el);modal.appendChild(el);el.parentElement=modal;}for(const id of ['client-list','phone-list','car-model-list','car-number-list','car-engine-list','car-vin-list','car-code-list','car-income-list']){const el=new Element(id+'-create-sakaz_narad','ul');nodes.set(el.id,el);modal.appendChild(el);}const icons=new Element('car-confirm-icons','div');nodes.set(icons.id,icons);modal.appendChild(icons);modal.register=next=>nodes.set(next.id,next);return modal;}
 const cache=new Map();const options={clear(){state.cacheClears++;cache.clear();},async readEntity(kind,id,load){const key=kind+id;if(cache.has(key))return cache.get(key);const result=await load();cache.set(key,result);return result;},read(...args){return new Promise((resolve,reject)=>calls.push({kind:'options',args,resolve,reject}));}};
 const writes={savePromptModalId:'save-prompt-modal',createSavePromptModal:()=>new Element('save-prompt-modal','div'),cancelSavePromptModal(){},showSavePromptModal(){state.promptCalls++;return state.prompt===null?new Promise(resolve=>finishPrompt=resolve):Promise.resolve(state.prompt);},saveClientAndCarToDatabase(){state.savedCalls++;return saveResult?Promise.resolve(saveResult):new Promise(resolve=>finishSave=resolve);}};
 const act={saveModalIdCreate:'save-prompt-modal-create',createSaveModalCreate:()=>new Element('save-prompt-modal-create','div'),cancelSaveModalCreate(){},isActCreatePending:()=>false,showSaveModalCreate(){state.createCalls++;return Promise.resolve();}};
 const deps={supabase:{rpc(name,args){return new Promise((resolve,reject)=>calls.push({name,args,resolve,reject}));},auth:{onAuthStateChange(){}}}};
 const context={exports:api,require:name=>name.includes('supabaseClient')?deps:name.endsWith('pidtverdutu_sberihannya_PIB_avto')?writes:name.endsWith('pidtverdutu_sberihannya_zakaz_naryad')?act:name.endsWith('clientFormOptions')?{createClientFormOptions:()=>options}:name.endsWith('clientFormDropdown')?{mountClientFormDropdown:settings=>{controllers.set(settings.input.id,settings);return {close(){},dispose(){if(controllers.get(settings.input.id)===settings)controllers.delete(settings.input.id);}}}}:name.endsWith('auto.json')?{default:{data:[]}}:name.endsWith('enter_navigation')?{setupEnterNavigation:()=>()=>{}}:{},
  document,window:{addEventListener:(name,fn)=>events[name]=fn},localStorage:{getItem:()=>JSON.stringify({Name:actor,slyusar_id:actor})},HTMLInputElement:Input,HTMLTextAreaElement:Textarea,HTMLSelectElement:Select,Option:class{constructor(text,value){this.text=text;this.value=value;}},setTimeout:()=>0,clearTimeout(){},makeModal,console};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText+'\ncreateModalElement=makeModal;showLockToggleMessage=(_state,message)=>exports.notices.push(message);exports.inspect={get pending(){return formSelectionPending;},get saving(){return formMutationPending;},setupAutocomplete};',context);api.notices=notices;
 const select=(key,item)=>{const setup=controllers.get(ids[key]);assert.ok(setup,'controller '+key);nodes.get(ids[key]).value=setup.label(item);return setup.onSelect(item);};
 return{api,state,calls,notices,nodes,controllers,options,document,events,select,node:key=>nodes.get(ids[key]),setActor(value){actor=value;},setSaveResult(value){saveResult=value;},finishSave(value){finishSave(value);},finishPrompt(value){finishPrompt(value);}};
}
const client=(id,name='Client '+id,phone='+380(67)123-45-67')=>({client_id:String(id),data:{ПІБ:name,Телефон:phone,Джерело:'',Додаткові:''}});
const car=(id,owner=1,deleted=false)=>({cars_id:String(id),client_id:String(owner),is_deleted:deleted,data:{Авто:'Auto '+id,'Номер авто':'AA'+id,Vincode:'VIN'+id,Пальне:'Бензин'}});
async function chooseClient(f,id=1,vehicle=car(10,id)){const work=f.select('client',{id,fullName:'Client '+id});f.calls.at(-1).resolve({data:{client:client(id),car:vehicle}});await work;return vehicle;}
async function selectedFixture(){const f=fixture();await f.api.showModalCreateSakazNarad();await chooseClient(f);return f;}

test('opening client modal does not download directories or table rows',async()=>{const f=fixture();await f.api.showModalCreateSakazNarad();assert.equal(f.calls.length,0);await f.api.showModalCreateSakazNarad();assert.equal(f.calls.length,0);});
test('locked client selection loads one compact client/car receipt and reuses it',async()=>{const f=await selectedFixture();assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'traffic_client_car_record');assert.equal(f.calls[0].args.p_kind,'client_car');assert.equal(f.api.getModalFormValues().cars_id,'10');await f.select('client',{id:1,fullName:'Client 1'});assert.equal(f.calls.length,1);assert.equal(f.api.clientRecordBaseline.client_id,'1');});
test('selecting phone for client without cars clears previous car while preserving new client',async()=>{const f=await selectedFixture();const work=f.select('phone',{id:2,phone:'+380(50)111-11-11'});f.calls.at(-1).resolve({data:{client:client(2),car:null}});await work;assert.equal(f.node('model').value,'');assert.equal(f.node('vin').value,'');assert.equal(f.api.getModalFormValues().client_id,'2');assert.equal(f.api.getModalFormValues().cars_id,null);assert.equal(f.node('phone').value,'+380(50)111-11-11');});
test('unlocked client selection fetches only that client and no default car',async()=>{const f=fixture();await f.api.showModalCreateSakazNarad();f.node('edit').click();const work=f.select('client',{id:3,fullName:'Client 3'});assert.equal(f.calls[0].args.p_kind,'client');f.calls[0].resolve({data:client(3)});await work;assert.equal(f.calls.length,1);assert.equal(f.api.getModalFormValues().cars_id,null);});
test('client detail failure does not overwrite entered fields and clears pending state',async()=>{const f=await selectedFixture();const work=f.select('client',{id:2,fullName:'Client 2'});f.calls.at(-1).resolve({error:Error('offline')});await assert.rejects(work,/offline/);assert.equal(f.node('model').value,'Auto 10');assert.equal(f.api.getModalFormValues().client_id,null);assert.equal(f.api.inspect.pending,false);});
test('late selection cannot overwrite notes typed during the read',async()=>{const f=await selectedFixture();const work=f.select('client',{id:2,fullName:'Client 2'});f.node('extra').value='unsaved';f.node('extra').dispatch('input');f.calls.at(-1).resolve({data:{client:client(2),car:car(20,2)}});await work;assert.equal(f.node('extra').value,'unsaved');assert.equal(f.node('model').value,'Auto 10');assert.equal(f.api.getModalFormValues().client_id,null);});
test('car selection waits for owner before committing vehicle fields',async()=>{const f=await selectedFixture();const work=f.select('number',{id:20,'Номер авто':'BB20'});f.calls.at(-1).resolve({data:car(20,2)});await tick();assert.equal(f.calls.at(-1).args.p_kind,'client');f.calls.at(-1).resolve({error:Error('owner offline')});await assert.rejects(work,/owner offline/);assert.equal(f.node('model').value,'Auto 10');assert.equal(f.node('client').value,'Client 1');assert.equal(f.api.getModalFormValues().cars_id,null);});
test('mode button advances from actual reset state after relocking',async()=>{const f=await selectedFixture();f.node('edit').click();f.node('mode').click();assert.equal(f.api.userConfirmation,null);f.node('mode').click();assert.equal(f.api.userConfirmation,'no');f.node('edit').click();assert.equal(f.api.userConfirmation,'yes');f.node('edit').click();f.node('mode').click();assert.equal(f.api.userConfirmation,null);assert.equal(f.node('mode').textContent,'🔁');});
test('manual identity input in add mode clears selected identities; edit mode retains exact IDs',async()=>{const f=await selectedFixture();f.node('edit').click();f.node('mode').click();f.node('model').value='Renamed';f.node('model').dispatch('input');assert.equal(f.api.getModalFormValues().cars_id,'10');f.node('mode').click();f.node('mode').click();f.node('vin').value='NEW';f.node('vin').dispatch('input');assert.equal(f.api.getModalFormValues().cars_id,null);assert.equal(f.api.carRecordBaseline,null);});
test('saving freezes controls and repeated click performs only one save',async()=>{const f=await selectedFixture();f.node('edit').click();f.node('mode').click();f.node('extra').value='changed';f.node('save').click();await tick();assert.equal(f.state.savedCalls,1);assert.equal(f.node('edit').disabled,true);f.node('save').click();f.node('mode').click();f.api.closeModalCreateSakazNarad();assert.equal(f.state.savedCalls,1);assert.equal(f.api.userConfirmation,null);assert.ok(f.document.getElementById('custom-modal-create-sakaz_narad'));f.finishSave({saved:true,client_id:'1',cars_id:'10',client:{...client(1),data:{...client(1).data,Додаткові:'changed'}},car:car(10)});await tick();assert.equal(f.api.inspect.saving,false);assert.equal(f.node('edit').dataset.unlocked,'false');assert.equal(f.calls.length,1);});
test('delete hides only car in form, preserving client and phone without list reload',async()=>{const f=await selectedFixture();f.node('edit').click();f.node('mode').click();f.node('mode').click();f.setSaveResult({saved:true,client_id:'1',cars_id:null,client:client(1),car:car(10,1,true)});f.node('save').click();await tick();assert.equal(f.api.getModalFormValues().client_id,'1');assert.equal(f.api.getModalFormValues().cars_id,null);assert.equal(f.node('client').value,'Client 1');assert.equal(f.node('phone').value,'+380(67)123-45-67');assert.equal(f.node('model').value,'');assert.equal(f.node('vin').value,'');assert.equal(f.api.carRecordBaseline,null);assert.equal(f.calls.length,1);});
test('exact VIN restore fills old car while preserving selected new owner',async()=>{const f=fixture();await f.api.showModalCreateSakazNarad();f.node('edit').click();const pick=f.select('client',{id:2,fullName:'New owner'});f.calls.at(-1).resolve({data:client(2,'New owner')});await pick;const restore=f.select('vin',{id:10,label:'VIN10'});f.calls.at(-1).resolve({data:car(10,1,true)});await restore;assert.equal(f.node('client').value,'New owner');assert.equal(f.api.getModalFormValues().client_id,'2');assert.equal(f.api.getModalFormValues().cars_id,'10');assert.equal(f.node('model').value,'Auto 10');f.node('create').click();assert.equal(f.state.createCalls,0);});
test('canceling confirmation restores fields and makes no write',async()=>{const f=await selectedFixture();f.node('edit').click();f.state.prompt=false;f.node('save').click();await tick();assert.equal(f.state.savedCalls,0);assert.equal(f.node('save').disabled,false);assert.equal(f.node('edit').dataset.unlocked,'true');});
test('actor change cannot save old client form or commit late selection',async()=>{const f=await selectedFixture();f.node('edit').click();f.setActor('B');f.node('save').click();assert.equal(f.state.savedCalls,0);assert.equal(f.api.getModalFormValues().client_id,null);assert.match(f.notices.at(-1),/Користувач змінився/);});
test('pending lookup cannot save until selected record has finished loading',async()=>{const f=await selectedFixture();f.node('edit').click();const work=f.select('client',{id:2,fullName:'Client 2'});f.node('save').click();assert.equal(f.state.promptCalls,0);assert.match(f.notices.at(-1),/Зачекайте/);f.calls.at(-1).resolve({data:client(2)});await work;});
test('closing and reopening cannot receive old selection result',async()=>{const f=await selectedFixture();const work=f.select('client',{id:2,fullName:'Client 2'});f.api.closeModalCreateSakazNarad();await f.api.showModalCreateSakazNarad();f.calls.at(-1).resolve({data:{client:client(2),car:car(20,2)}});await work;assert.equal(f.api.getModalFormValues().client_id,null);assert.equal(f.node('client').value,'');});


test('planner transfer loads two compact records and retains raw baselines for editing',async()=>{
 const f=fixture();await f.api.showModalCreateSakazNarad();const pending=f.api.fillSelectedClientCar('2','20');
 assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.name==='traffic_client_car_record'));
 f.calls.find(call=>call.args.p_kind==='client').resolve({data:client(2,'Planner owner')});
 f.calls.find(call=>call.args.p_kind==='car').resolve({data:car(20,2)});
 assert.equal(await pending,true);assert.equal(f.api.clientRecordBaseline.client_id,'2');assert.equal(f.api.carRecordBaseline.cars_id,'20');
 assert.equal(f.api.formSnapshot.carModel,'Auto 20');assert.equal(f.api.getModalFormValues().cars_id,'20');
});
test('planner transfer rejects a moved or hidden car without combining old owner data',async()=>{
 const f=fixture();await f.api.showModalCreateSakazNarad();const pending=f.api.fillSelectedClientCar('2','20');
 f.calls.find(call=>call.args.p_kind==='client').resolve({data:client(2)});
 f.calls.find(call=>call.args.p_kind==='car').resolve({data:car(20,1,true)});
 await assert.rejects(pending,/більше не належить/);assert.equal(f.api.getModalFormValues().cars_id,null);assert.equal(f.node('model').value,'');
});
test('cancelled planner transfer cannot populate a newly opened modal',async()=>{
 const f=fixture();await f.api.showModalCreateSakazNarad();const pending=f.api.fillSelectedClientCar('2','20');f.api.closeModalCreateSakazNarad();await f.api.showModalCreateSakazNarad();
 f.calls.find(call=>call.args.p_kind==='client').resolve({data:client(2)});f.calls.find(call=>call.args.p_kind==='car').resolve({data:car(20,2)});
 assert.equal(await pending,false);assert.equal(f.node('client').value,'');
});
test('write rejection preserves draft, selected IDs and unlocked mode',async()=>{
 const f=await selectedFixture();f.node('edit').click();f.node('mode').click();f.node('extra').value='retain me';f.setSaveResult({saved:false,client_id:'1',cars_id:'10'});f.node('save').click();await tick();
 assert.equal(f.node('extra').value,'retain me');assert.equal(f.api.getModalFormValues().cars_id,'10');assert.equal(f.node('edit').dataset.unlocked,'true');assert.equal(f.node('save').disabled,false);
});
test('changing operation and lock never downloads reference lists eagerly',async()=>{
 const f=await selectedFixture();const count=f.calls.length;f.node('edit').click();for(let i=0;i<6;i++)f.node('mode').click();f.node('edit').click();assert.equal(f.calls.length,count);
});


test('legacy lowercase VIN and plate do not turn unchanged selection into unsaved edits',async()=>{
 const f=fixture();await f.api.showModalCreateSakazNarad();const vehicle=car(10);vehicle.data.Vincode='vin10';vehicle.data['Номер авто']='aa10';vehicle.data.КодДВЗ='abc';await chooseClient(f,1,vehicle);
 assert.equal(f.api.formSnapshot.vin,'VIN10');assert.equal(f.api.formSnapshot.carNumber,'AA10');f.node('create').click();await tick();assert.equal(f.state.createCalls,1);
});
test('planner transferred phone choices reuse already loaded client phones',async()=>{
 const f=fixture();await f.api.showModalCreateSakazNarad();const pending=f.api.fillSelectedClientCar('2',null);f.calls[0].resolve({data:client(2,'Owner','+380(67)111-11-11, +380(50)222-22-22')});await pending;
 const dropdown=f.controllers.get(ids.phone);const result=await dropdown.loadPage('',null);assert.equal(result.items.length,2);assert.equal(f.calls.length,1);
});
test('failed save invalidates lookups so explicit reselect obtains current baseline',async()=>{
 const f=await selectedFixture();f.node('edit').click();f.node('mode').click();const before=f.state.cacheClears;f.setSaveResult({saved:false,client_id:'1',cars_id:'10'});f.node('save').click();await tick();assert.ok(f.state.cacheClears>before);
 const pending=f.select('client',{id:1,fullName:'Client 1'});assert.equal(f.calls.length,2);f.calls.at(-1).resolve({data:client(1)});await pending;
});


function aiFill(f) {
 const source=fs.readFileSync('src/ts/roboha/ai/aiChat.ts','utf8');const start=source.indexOf('async function fillClientFormFromAI('),end=source.indexOf('// ============================================================',start);
 const api={};vm.runInNewContext(ts.transpileModule('export '+source.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{
  exports:api,parseClientDataFromAI:()=>({}),showModalCreateSakazNarad:f.api.showModalCreateSakazNarad,
  setClientCarOperation:f.api.setClientCarOperation,setSelectedIds:f.api.setSelectedIds,
  unlockFormButton:()=>{if(f.node('edit').dataset.unlocked!=='true')f.node('edit').click();},document:f.document,
  fillCarFieldsFromParsed(){},fillCarModelFieldAndFocus(){},getCarSearchText:()=>'',setTimeout:fn=>fn(),
 });return ()=>api.fillClientFormFromAI('recognized input');
}
test('AI import resets the actual operation from delete to add along with the icon',async()=>{
 const f=await selectedFixture();f.node('edit').click();f.node('mode').click();f.node('mode').click();assert.equal(f.api.userConfirmation,'no');
 await aiFill(f)();assert.equal(f.api.userConfirmation,'yes');assert.equal(f.node('mode').textContent,'➕');assert.equal(f.api.getModalFormValues().client_id,null);assert.equal(f.api.getModalFormValues().cars_id,null);
});
test('AI import cannot reset selected IDs or mode while a save is pending',async()=>{
 const f=await selectedFixture();f.node('edit').click();f.node('mode').click();f.node('extra').value='save me';f.node('save').click();await tick();
 await aiFill(f)();assert.equal(f.api.userConfirmation,null);assert.equal(f.api.getModalFormValues().client_id,'1');assert.equal(f.api.getModalFormValues().cars_id,'10');
 f.finishSave({saved:false,client_id:'1',cars_id:'10'});await tick();
});
