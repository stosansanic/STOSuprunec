const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const file='src/ts/roboha/dodatu_inchi_bazu/db_sclad.ts';
function harness({mode='Редагувати',base,mutate,response,auditError=false,canonical}={}) {
  let baseline=base===null?null:{sclad_id:7,time_on:'2026-10-21T10:20:30',shops:'Shop',part_number:'CAT',name:'Part',kilkist_on:3,price:50,rahunok:'INV',unit_measurement:'штук',scladNomer:1,xto_zamovuv:9,employee_name:'Old employee',kilkist_off:0,akt:null,statys:'Прибуло',prumitka:'keep note',...base};
  const fields={sclad_date:'2026-10-21',sclad_shop:'Shop',sclad_detail_catno:'CAT',sclad_detail:'Part',sclad_qty_in:'3',sclad_price:'50',sclad_invoice_no:'INV',sclad_unit:'штук',sclad_procent:'1',sclad_zapchastyst_pib:'Old employee'};
  mutate?.(fields);
  const elements=Object.fromEntries(Object.entries(fields).map(([id,value])=>[id,{value,dataset:{}}]));
  const queries=[],resolves=[],audits=[];let invalidations=0;
  const supabase={from(table){const q={table,filters:[]};return {update(payload){q.op='update';q.payload=payload;return this;},insert(payload){q.op='insert';q.payload=payload;return this;},delete(){q.op='delete';return this;},eq(k,v){q.filters.push([k,v]);return this;},is(k,v){q.filters.push([k,v]);return this;},select(cols){q.select=cols;queries.push(structuredClone(q));return Promise.resolve(response??{data:[{sclad_id:7}],error:null});}}},rpc:async()=>{throw Error('Unexpected RPC');}};
  const deps={
    './inhi/stockReadRevision':{invalidateStockReads(){invalidations++;}},
    '../../vxid/supabaseClient':{supabase},
    './dodatu_inchi_bazu_danux':{CRUD:mode},
    './inhi/scladMagasunDetal':{getCurrentScladId:()=>baseline?.sclad_id,getOriginalScladRecord:()=>structuredClone(baseline),updateOriginalScladRecord:p=>{baseline={...baseline,...p};},getSlyusarIdByPib:()=>null,shopEditState:{baseShopId:2,originalName:'Shop'},detailEditState:{baseDetailId:3,originalName:'Part'}},
    './inhi/referenceWrite':{resolveStockReferences:async items=>{resolves.push(structuredClone(items));return items.map(i=>({...i,id:4,canonical:canonical?.(i)??i.name,status:'created'}));}},
    '../../utils/auditLogger':{logAction:async(...args)=>{audits.push(args);if(auditError)throw Error('audit failure');}},
  };
  const context={exports:{},require:k=>{if(!(k in deps))throw Error(k);return deps[k];},document:{getElementById:id=>elements[id]??null},localStorage:{getItem:()=>JSON.stringify({slyusar_id:99,Name:'Current'})},structuredClone};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
  return {api:context.exports,queries,resolves,elements,audits,get invalidations(){return invalidations;}};
}
test('normal stock form never writes absent act/status/notes/usage/client-price controls',()=>{
  const h=harness();const p=h.api.readScladFormValues();for(const key of ['akt','statys','prumitka','kilkist_off','client_price'])assert.equal(key in p,false,key);
  assert.equal(p.xto_zamovuv,9);
});
test('selected historic employee ID survives names cache miss',()=>{
  const h=harness();h.elements.sclad_zapchastyst_pib.dataset.slyusarId='17';assert.equal(h.api.readScladFormValues().xto_zamovuv,17);
});
test('unresolved explicitly changed employee does not silently become current user',()=>{
  const h=harness({mutate:f=>f.sclad_zapchastyst_pib='Missing'});assert.throws(()=>h.api.readScladFormValues(),/Оберіть запчастиста/);
});
test('unchanged date input preserves the original timestamp and sends no request',async()=>{
  const h=harness();assert.equal(await h.api.handleScladCrud(),true);assert.equal(h.queries.length,0);assert.equal(h.resolves.length,0);assert.equal(h.audits.length,0);
});
test('one changed cell writes only that cell with its old-value guard and tiny receipt',async()=>{
  const h=harness({mutate:f=>f.sclad_price='75'});await h.api.handleScladCrud();assert.deepEqual(h.queries,[{table:'sclad',filters:[['sclad_id',7],['price',50]],op:'update',payload:{price:75},select:'sclad_id'}]);
});
test('zero affected update is a conflict, not success',async()=>{
  const h=harness({mutate:f=>f.sclad_price='75',response:{data:[],error:null}});await assert.rejects(h.api.handleScladCrud(),/вже змінено/);assert.equal(h.invalidations,0);
});
test('quantity cannot fall below consumed inventory',async()=>{
  const h=harness({base:{kilkist_off:2},mutate:f=>f.sclad_qty_in='1'});await assert.rejects(h.api.handleScladCrud(),/вже використану/);assert.equal(h.queries.length,0);
});
test('quantity edit also guards consumed inventory against concurrent act saves',async()=>{
  const h=harness({mutate:f=>f.sclad_qty_in='4'});await h.api.handleScladCrud();assert.deepEqual(h.queries[0].filters,[['sclad_id',7],['kilkist_on',3],['kilkist_off',0]]);
});
test('delete refuses stock linked to an act',async()=>{
  const h=harness({mode:'Видалити',base:{akt:'1514'}});await assert.rejects(h.api.handleScladCrud(),/прив'язана/);assert.equal(h.queries.length,0);
});
test('delete uses one guarded call without a preliminary SELECT',async()=>{
  const h=harness({mode:'Видалити'});await h.api.handleScladCrud();assert.equal(h.queries.length,1);assert.equal(h.queries[0].op,'delete');assert.equal(h.queries[0].select,'sclad_id');assert.ok(h.queries[0].filters.some(([k,v])=>k==='akt'&&v===null));
});
test('zero affected delete is a conflict',async()=>{
  const h=harness({mode:'Видалити',response:{data:[],error:null}});await assert.rejects(h.api.handleScladCrud(),/вже змінено/);
});
test('new stock resolves both missing reference names in one call',async()=>{
  const h=harness({mode:'Додати',base:null,mutate:f=>{f.sclad_shop='New shop';f.sclad_detail='New part';f.sclad_zapchastyst_pib='';}});await h.api.handleScladCrud();assert.equal(h.resolves.length,1);assert.equal(h.resolves[0].length,2);assert.equal(h.queries.length,1);assert.equal(h.queries[0].payload.kilkist_off,0);
});
test('batch insertion reuses already resolved names',async()=>{
  const h=harness({mode:'Додати',base:null,mutate:f=>{f.sclad_shop='New';f.sclad_detail='Other';f.sclad_zapchastyst_pib='';}});await h.api.handleScladCrud({referencesResolved:true,skipAuditLog:true});assert.equal(h.resolves.length,0);assert.equal(h.queries.length,1);
});
test('audit failure after committed write does not retry a successful mutation',async()=>{
  const h=harness({mutate:f=>f.sclad_price='75',auditError:true});assert.equal(await h.api.handleScladCrud(),true);assert.equal(h.queries.length,1);
});
test('edit without an explicitly selected baseline never mutates stock',async()=>{
  const h=harness({base:null,mutate:f=>f.sclad_zapchastyst_pib=''});await assert.rejects(h.api.handleScladCrud(),/Спочатку оберіть/);assert.equal(h.queries.length,0);
});
function referenceHarness({mode='Редагувати',error=false}={}) {
  const states={shopEditState:{touched:true,currentName:'New shop',originalName:'Shop',baseShopId:2},detailEditState:{touched:true,currentName:'New part',originalName:'Part',baseDetailId:3}};
  const calls=[],audits=[];
  const deps={
    './dodatu_inchi_bazu_danux':{CRUD:mode},'./inhi/scladMagasunDetal':states,
    './inhi/directoryRead':{clearDirectoryReads(){},writeDirectory(){throw Error('non-atomic call');},deleteDirectory(){throw Error('non-atomic call');}},
    './inhi/stockReadRevision':{invalidateStockReads(){}},'../../utils/auditLogger':{logAction:async(...a)=>audits.push(a)},
    '../../vxid/supabaseClient':{supabase:{rpc:async(name,args)=>{calls.push({name,args:structuredClone(args)});return error?{error:Error('conflict')}:{data:args.p_changes.map(c=>({kind:c.kind,status:mode==='Видалити'?'deleted':'updated',id:c.id,row:{[c.kind==='shops'?'shop_id':'detail_id']:c.id}})).reverse(),error:null};}}},
  };
  const context={exports:{},require:k=>deps[k]};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/db_shops_details.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
  return {api:context.exports,states,calls,audits};
}
test('shop and detail rename without a catalog are one atomic two-field RPC',async()=>{
  const h=referenceHarness();assert.equal(await h.api.tryHandleStockReferencesCrud(),true);assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'traffic_directory_reference_batch');assert.equal(h.calls[0].args.p_changes.length,2);assert.equal(h.audits.length,1);
});
test('failed reference batch never emits a successful write audit',async()=>{
  const h=referenceHarness({error:true});await assert.rejects(h.api.tryHandleStockReferencesCrud(),/conflict/);assert.equal(h.calls.length,1);assert.equal(h.audits.length,0);
});
test('unchanged reference form performs no RPC',async()=>{
  const h=referenceHarness();h.states.shopEditState.currentName='Shop';h.states.detailEditState.currentName='Part';await h.api.tryHandleStockReferencesCrud();assert.equal(h.calls.length,0);
});
test('reference deletion requires an explicitly selected ID before any request',async()=>{
  const h=referenceHarness({mode:'Видалити'});h.states.detailEditState.baseDetailId=null;await assert.rejects(h.api.tryHandleStockReferencesCrud(),/Оберіть деталь/);assert.equal(h.calls.length,0);
});

test('stock form session reset removes previous ID, baseline and reference selection',async()=>{
  const events=new Map(),hidden={value:'',dataset:{}};
  const deps={
    './stockReadRevision':{stockSuggestionRevision:()=>0},'../../../vxid/supabaseClient':{supabase:{}},'./referenceLookup':{},
    '../dodatu_inchi_bazu_danux':{updateAllBd(){}},'./batchImportSclad':{},'../../redahyvatu_klient_machuna/enter_navigation':{},'./sharedAutocomplete':{},
  };
  const context={exports:{},require:k=>deps[k],AbortController,structuredClone,localStorage:{getItem:()=>''},document:{addEventListener:(name,handler)=>events.set(name,handler),getElementById:id=>id==='hidden-sclad-id'?hidden:null}};
  const source=fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/scladMagasunDetal.ts','utf8')+'\nexport const testFill=fillFormFieldsFromSclad;';
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
  const api=context.exports;await api.testFill({sclad_id:99,part_number:'X',shops:'Shop',name:'Part',shop_id:2,detail_id:3});assert.equal(api.getCurrentScladId(),'99');
  api.resetScladFormSession();assert.equal(api.getCurrentScladId(),null);assert.equal(api.getOriginalScladRecord(),null);assert.equal(hidden.value,'');assert.equal(api.shopEditState.baseShopId,null);assert.equal(api.detailEditState.baseDetailId,null);
});
function dropdownHarness() {
  const handlers={},documentHandlers={},requests=[];let pendingResolve;
  const input={value:'Part',isConnected:true,dataset:{},getBoundingClientRect:()=>({width:100}),addEventListener:(event,fn)=>{(handlers[event]??=[]).push(fn);}};
  const dd={innerHTML:'',textContent:'',children:[],style:{},classList:{add(){},remove(){}},addEventListener(){},appendChild(item){this.children.push(item);},replaceChildren(){this.children=[];},contains:()=>false};
  const doc={getElementById:id=>id==='field'?input:id==='dd'?dd:null,addEventListener:(event,fn)=>{(documentHandlers[event]??=[]).push(fn);},createElement:()=>({className:'',textContent:'',style:{},appendChild(){},addEventListener(){}})};
  const deps={
    './stockReadRevision':{stockSuggestionRevision:()=>0},'../../../vxid/supabaseClient':{supabase:{from(name){const args={};return {select(columns){args.columns=columns;return this;},ilike(column,query){args.column=column;args.query=query;return this;},order(){return this;},range(start,end){requests.push({name,args:{...args,start,end}});return new Promise(resolve=>{pendingResolve=resolve;});}};}}},'./referenceLookup':{},
    '../dodatu_inchi_bazu_danux':{updateAllBd(){}},'./batchImportSclad':{},'../../redahyvatu_klient_machuna/enter_navigation':{},'./sharedAutocomplete':{setupDropdownKeyboard(){}},
  };
  const context={exports:{},require:k=>deps[k],AbortController,structuredClone,setTimeout,clearTimeout,localStorage:{getItem:()=>''},document:doc};
  const source=fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/scladMagasunDetal.ts','utf8')+'\nexport const testWire=wireDetailsAutocompleteWithLiveLoad;';
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
  return {api:context.exports,handlers,input,dd,requests,resolve(data){pendingResolve({data,error:null});}};
}
test('detail focus plus click shares one compact request, repeated reopening uses cached page',async()=>{
  const h=dropdownHarness();await h.api.testWire('field','dd');h.handlers.focus[0]();h.handlers.click[0]();assert.equal(h.requests.length,1);h.resolve([{sclad_id:3,name:'Part',part_number:'CAT'}]);await new Promise(r=>setImmediate(r));
  h.handlers.click[0]();await new Promise(r=>setImmediate(r));assert.equal(h.requests.length,1);assert.equal(h.requests[0].name,'sclad');assert.equal(h.requests[0].args.column,'name');assert.equal(h.requests[0].args.end,20);assert.equal(h.requests[0].args.columns.includes('*'),false);
});
test('late detail response after closing/resetting form cannot render suggestions',async()=>{
  const h=dropdownHarness();await h.api.testWire('field','dd');h.handlers.focus[0]();h.api.resetScladFormSession();h.resolve([{sclad_id:3,name:'Part',part_number:'CAT'}]);await new Promise(r=>setImmediate(r));assert.equal(h.dd.children.length,0);
});

test('explicit empty batch employee override remains NULL instead of visible previous owner',()=>{
  const h=harness({mutate:f=>{f.sclad_xto_zamovuv='';}});h.elements.sclad_zapchastyst_pib.dataset.slyusarId='9';assert.equal(h.api.readScladFormValues().xto_zamovuv,null);
});
test('canonical reference spelling equal to baseline sends no empty update',async()=>{
  const h=harness({mutate:f=>f.sclad_shop='shop',canonical:()=> 'Shop'});assert.equal(await h.api.handleScladCrud(),true);assert.equal(h.resolves.length,1);assert.equal(h.queries.length,0);assert.equal(h.audits.length,0);
});
test('deleting a selected row ignores invalid unsaved numeric and employee input',async()=>{
  const h=harness({mode:'Видалити',mutate:f=>{f.sclad_price='invalid';f.sclad_zapchastyst_pib='Unknown';}});assert.equal(await h.api.handleScladCrud(),true);assert.equal(h.queries.length,1);assert.equal(h.queries[0].op,'delete');
});
test('stock selection preserves historical unit and inactive warehouse not in current options',async()=>{
  const makeSelect=(initial)=>({tagName:'SELECT',options:initial.map(value=>({value,dataset:{}})),dataset:{},style:{},selectedIndex:0,_value:initial[0],add(option){this.options.push(option);},get value(){return this._value;},set value(value){this._value=this.options.some(option=>option.value===value)?value:'';this.selectedIndex=this.options.findIndex(option=>option.value===value);}});
  const unit=makeSelect(['штук']),warehouse=makeSelect(['1']);const fields={sclad_unit:unit,sclad_procent:warehouse};
  const deps={'./stockReadRevision':{stockSuggestionRevision:()=>0},'../../../vxid/supabaseClient':{supabase:{}},'./referenceLookup':{},'../dodatu_inchi_bazu_danux':{updateAllBd(){}},'./batchImportSclad':{},'../../redahyvatu_klient_machuna/enter_navigation':{},'./sharedAutocomplete':{}};
  const context={exports:{},require:k=>deps[k],AbortController,structuredClone,Option:function(text,value){this.text=text;this.value=value;this.dataset={};},localStorage:{getItem:()=>''},document:{addEventListener(){},getElementById:id=>fields[id]??null}};
  const source=fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/scladMagasunDetal.ts','utf8')+'\nexport const testFill=fillFormFieldsFromSclad;';
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
  await context.exports.testFill({sclad_id:9,unit_measurement:'шт.',scladNomer:17});assert.equal(unit.value,'шт.');assert.equal(warehouse.value,'17');assert.equal(warehouse.options.find(row=>row.value==='17').text,'17 (неактивний)');
});

function stockDropdownFixture() {
  const fields=new Map(),timers=new Map(),requests=[],mounts=[];let timerId=0;
  class Element extends EventTarget {
    constructor(value=''){super();this.value=value;this.isConnected=true;this.dataset={};this.style={};this.children=[];this.tagName='INPUT';this.flags=new Set(['hidden-all_other_bases']);this.classList={add:x=>this.flags.add(x),remove:x=>this.flags.delete(x),contains:x=>this.flags.has(x),toggle:(x,on)=>on?this.flags.add(x):this.flags.delete(x)};}
    get innerHTML(){return '';}
    set innerHTML(_v){this.children=[];}
    append(...rows){this.children.push(...rows);}
    appendChild(row){this.children.push(row);}
    replaceChildren(){this.children=[];}
    contains(node){return node===this||this.children.some(child=>child.contains(node));}
    querySelectorAll(){return this.children;}
    getBoundingClientRect(){return {width:100};}
  }
  for(const [id,value] of Object.entries({sclad_detail_catno:'CAT',sclad_detail:'Part',sclad_shop:'Shop',sclad_price:'10',sclad_zapchastyst_pib:'Current','hidden-sclad-id':''}))fields.set(id,new Element(value));
  for(const id of ['sclad_part_dd','sclad_detail_dd','sclad_shop_dd','sclad_zapchastyst_dd'])fields.set(id,new Element());
  fields.get('sclad_zapchastyst_pib').dataset.slyusarId='1';
  const document=new EventTarget();document.getElementById=id=>fields.get(id)||null;document.querySelectorAll=()=>[...fields].filter(([id])=>!id.endsWith('_dd')).map(([,field])=>field);document.createElement=()=>new Element();
  const pending=(kind,args)=>new Promise((resolve,reject)=>requests.push({kind,args,resolve,reject}));
  const deps={
    './stockReadRevision':{stockSuggestionRevision:()=>0},'../../../vxid/supabaseClient':{supabase:{rpc:(name,args)=>pending(name,args),from:()=>({select(){return this;},ilike(){return this;},order(){return this;},range:(start,end)=>pending('summary',{start,end})})}},
    './referenceLookup':{readStockDirectory:kind=>pending('directory',kind)},'./directoryRead':{mountDirectoryDropdown:(...args)=>mounts.push(args)},
    '../dodatu_inchi_bazu_danux':{CRUD:'Додати',updateAllBd(){}},'./batchImportSclad':{},'../../redahyvatu_klient_machuna/enter_navigation':{},'./sharedAutocomplete':{setupDropdownKeyboard(){}},
  };
  const source=fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/scladMagasunDetal.ts','utf8')+'\nexport const testLinked=wireLinkedAutocomplete,testStaff=wireZapchastystAutocomplete,testShop=wireShopAutocomplete,testDetails=wireDetailsAutocompleteWithLiveLoad;';
  const context={exports:{},require:k=>deps[k],AbortController,Event,structuredClone,localStorage:{getItem:()=>''},document,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
  return{api:context.exports,fields,requests,mounts,emit:(target,type)=>target.dispatchEvent(new Event(type)),tick:()=>new Promise(resolve=>setImmediate(resolve)),flush(){const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());}};
}

test('stock shops initialize without loading names; typed labels never infer a rename/delete ID',async()=>{
  const f=stockDropdownFixture();await f.api.testShop('sclad_shop','sclad_shop_dd');assert.equal(f.requests.length,0);assert.equal(f.mounts[0][0],'shops');
  const input=f.fields.get('sclad_shop');input.value='Existing shop';f.mounts[0][4]();assert.equal(f.api.shopEditState.baseShopId,null);assert.equal(f.api.shopEditState.originalName,null);
  f.mounts[0][3]({shop_id:7,data:{Name:'Existing shop'}});input.value='Renamed';f.mounts[0][4]();assert.equal(f.api.shopEditState.baseShopId,7);assert.equal(f.api.shopEditState.originalName,'Existing shop');assert.equal(f.api.shopEditState.currentName,'Renamed');
});

test('stock employee names load only when opened and focus/click/reopening share the cached compact result',async()=>{
  const f=stockDropdownFixture();await f.api.testStaff('sclad_zapchastyst_pib','sclad_zapchastyst_dd');assert.equal(f.requests.length,0);
  const input=f.fields.get('sclad_zapchastyst_pib');f.emit(input,'focus');f.emit(input,'click');assert.equal(f.requests.length,1);assert.equal(f.requests[0].kind,'directory');assert.equal(f.requests[0].args,'staff');
  f.requests[0].resolve([{slyusar_id:7,data:{Name:'Parts employee',Доступ:'Запчастист'}},{slyusar_id:8,data:{Name:'Mechanic',Доступ:'Слюсар'}}]);await f.tick();assert.equal(f.fields.get('sclad_zapchastyst_dd').children.length,1);
  f.emit(input,'click');await f.tick();assert.equal(f.requests.length,1);f.emit(f.fields.get('sclad_zapchastyst_dd').children[0],'click');assert.equal(input.dataset.slyusarId,'7');
});

test('old stock selection failure cannot overwrite a newer successful selection',async()=>{
  const f=stockDropdownFixture();await f.api.testLinked();const input=f.fields.get('sclad_detail_catno'),dd=f.fields.get('sclad_part_dd');
  const linked=f.fields.get('sclad_detail_dd');
  f.emit(input,'focus');f.flush();f.requests[0].resolve({data:[{sclad_id:1,part_number:'CAT',name:'Old'},{sclad_id:2,part_number:'CAT',name:'New'}]});await f.tick();f.emit(dd.children[0],'click');await f.tick();f.emit(linked.children[0],'click');assert.equal(f.requests[1].kind,'traffic_stock_position');
  f.emit(input,'click');f.flush();await f.tick();f.emit(dd.children[0],'click');await f.tick();f.emit(linked.children[1],'click');assert.equal(f.requests.length,3);
  f.requests[2].resolve({data:{sclad_id:2,part_number:'CAT',name:'New',shops:'Shop',price:20,employee_name:'Current',xto_zamovuv:1}});await f.tick();f.requests[1].reject(Error('old read failed'));await f.tick();
  assert.equal(f.api.getCurrentScladId(),'2');assert.equal(f.api.getOriginalScladRecord().name,'New');assert.equal(f.fields.get('sclad_detail').value,'New');assert.equal(dd.classList.contains('hidden-all_other_bases'),true);
});

test('editing the draft during a stock selection read prevents replacement of typed values and baseline',async()=>{
  const f=stockDropdownFixture();await f.api.testLinked();const input=f.fields.get('sclad_detail_catno'),dd=f.fields.get('sclad_part_dd');
  f.emit(input,'focus');f.flush();f.requests[0].resolve({data:[{sclad_id:1,part_number:'CAT',name:'Old'}]});await f.tick();f.emit(dd.children[0],'click');
  f.fields.get('sclad_price').value='999';f.requests[1].resolve({data:{sclad_id:1,part_number:'CAT',name:'Old',price:20}});await f.tick();assert.equal(f.api.getCurrentScladId(),null);assert.equal(f.api.getOriginalScladRecord(),null);assert.equal(f.fields.get('sclad_price').value,'999');
});

test('delayed linked-name resolution cannot replace an explicitly selected employee or request its whole directory',async()=>{
  const f=stockDropdownFixture();await f.api.testDetails('sclad_detail','sclad_detail_dd');const input=f.fields.get('sclad_detail'),dd=f.fields.get('sclad_detail_dd'),owner=f.fields.get('sclad_zapchastyst_pib');
  f.emit(input,'focus');f.requests[0].resolve({data:[{sclad_id:1,part_number:'CAT',name:'Part'}]});await f.tick();f.emit(dd.children[0],'click');assert.equal(f.requests[1].kind,'traffic_stock_position');owner.dataset.slyusarId='2';
  f.requests[1].resolve({data:{sclad_id:1,part_number:'CAT',name:'Part',employee_name:'Old owner',xto_zamovuv:8}});await f.tick();assert.equal(owner.value,'Current');assert.equal(owner.dataset.slyusarId,'2');assert.equal(f.requests.length,2);assert.equal(f.api.getCurrentScladId(),null);
});
