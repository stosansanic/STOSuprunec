const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const batchFile='src/ts/roboha/dodatu_inchi_bazu/inhi/batchImportSclad.ts';
const stockFile='src/ts/roboha/dodatu_inchi_bazu/db_sclad.ts';
function extract(file,names){
  const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),99,true);
  return names.map(name=>{
    const statement=source.statements.find(n=>(ts.isFunctionDeclaration(n)&&n.name?.text===name)||(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(source)===name)));
    assert.ok(statement,name+' exists');return statement.getText(source).replace(/^export /,'');
  }).join('\n');
}
function uploadClickSource(){
  const ast=ts.createSourceFile(batchFile,fs.readFileSync(batchFile,'utf8'),99,true);let handler;
  function visit(node){if(ts.isBinaryExpression(node)&&node.left.getText(ast)==='uploadBtn.onclick'&&ts.isArrowFunction(node.right))handler=node.right.getText(ast);ts.forEachChild(node,visit);}
  visit(ast);assert.ok(handler,'upload click exists');return 'globalThis.runUploadClick = '+handler+';';
}
const source=[
  extract(stockFile,['fieldMap','numericFields','pick','readScladFormValues','cas','deleteScladSnapshot','validateScladPayload']),
  extract(stockFile,['handleScladCrud']).replace('function handleScladCrud(', 'function handleScladCrudActual('),
  extract(batchFile,['insertBatchStockRow','deleteBatchStockRow','batchRowError','isCompletedBatchDeletion','uploadBatchData','prewriteBatchStockCells','saveRowSnapshot','rowIdentifier','buildRowAddedDescription','buildRowChangesDescription','getChangedScladFields','parseLocalizedNumber']),
  uploadClickSource(),
].join('\n');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
function fixture({onInsert,response}={}){
  const nodes=new Map();
  const attached=[];
  function element(tag='input'){
    const e={tagName:tag.toUpperCase(),id:'',type:'',dataset:{},style:{},options:[],valueText:'',attrs:{},parent:null,
      classList:{add(){},remove(){}},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},
      appendChild(child){child.parent=this;this.options.push(child);},
      remove(){if(this.parent){this.parent.options.splice(this.parent.options.indexOf(this),1);this.parent=null;}else{if(nodes.get(this.id)===this)nodes.delete(this.id);const i=attached.indexOf(this);if(i>=0)attached.splice(i,1);}},
    };
    Object.defineProperty(e,'value',{get(){return this.valueText;},set(v){v=String(v);this.valueText=this.tagName==='SELECT'&&!this.options.some(o=>o.value===v)?'':v;}});
    return e;
  }
  const document={getElementById:id=>nodes.get(id)||null,createElement:element,body:{appendChild(e){assert.equal(nodes.has(e.id),false,'no duplicate IDs');nodes.set(e.id,e);attached.push(e);}}};
  function add(id,value,tag='input',options=[]){const e=element(tag);e.id=id;for(const v of options){const option=element('option');option.value=v;e.appendChild(option);}e.value=value;nodes.set(id,e);return e;}
  const control=add('sclad_detail','Main draft');
  add('sclad_zapchastyst_pib','Existing employee').dataset.slyusarId='99';
  const button=add('batch-upload-btn-Excel','');
  const inserts=[],queries=[],statuses=[],notifications=[],referenceCalls=[];
  const context={document,structuredClone,console:{error(){}},Map,WeakMap,Set,Promise,setTimeout,
    CRUD:'Редагувати',shopEditState:{baseShopId:6,originalName:'Original shop',currentName:'Main shop draft',touched:true},detailEditState:{baseDetailId:7,originalName:'Original part',currentName:'Main part draft',touched:true},
    updateCRUD(mode){context.CRUD=mode;},resetShopState(){Object.assign(context.shopEditState,{baseShopId:null,originalName:null,currentName:'',touched:false});},resetDetailState(){Object.assign(context.detailEditState,{baseDetailId:null,originalName:null,currentName:'',touched:false});},
    getOriginalScladRecord:()=>({xto_zamovuv:99,employee_name:'Existing employee'}),getSlyusarIdByPib:()=>99,localStorage:{getItem:()=>''},
    fieldLabelsUk:{},originalSnapshotMap:new Map(),parsedDataGlobal:[],emptyRowSnapshots:new WeakMap(),usersIdMap:new Map(),usersCacheActor:'',isUploading:false,batchReadVersion:0,scladIdsMap:new Map(),
    updateRowStatus:(index,success,message)=>statuses.push({index,success,message}),showNotification:(...args)=>notifications.push(args),invalidateStockReads(){},logAction:async()=>{},
    resolveStockReferences:async items=>{referenceCalls.push(items);return items.map(x=>({...x,canonical:x.name,status:'existing',id:1}));},
    batchUpdateActWithDetails:async()=>true,
    handleScladCrud:async options=>{
      const payload=context.readScladFormValues();inserts.push({payload,options:{skipAuditLog:options.skipAuditLog,referencesResolved:options.referencesResolved},mode:context.CRUD});
      if(onInsert)await onInsert({payload,options,context,call:inserts.length});
      options.onInserted(100+inserts.length,{...payload,sclad_id:100+inserts.length});return true;
    },
    supabase:{async rpc(name,args){
      assert.equal(name,'write_batch_stock_cells');
      return {data:args.p_items.map(item=>{queries.push({table:'sclad',op:'update',payload:item.changes,guards:[['sclad_id',item.id]],expected:item.expected});return {key:item.key,id:item.id,status:'updated'};}),error:null};
    },from(table){const q={table,guards:[]};return{delete(){q.op='delete';return this;},update(payload){q.op='update';q.payload=payload;return this;},insert(payload){q.op='insert';q.payload=payload;return this;},eq(k,v){q.guards.push([k,v]);return this;},is(k,v){q.guards.push([k,v]);return this;},select(columns){q.select=columns;queries.push(q);return Promise.resolve(response??{error:null,data:[{sclad_id:q.guards.find(([k])=>k==='sclad_id')?.[1]??9}]});}}}},
  };
  vm.createContext(context);vm.runInContext(compiled,context);
  return{context,nodes,attached,add,control,button,inserts,queries,statuses,notifications,referenceCalls};
}
function newRow(overrides={}){return{date:'21.10.2026',shop:'Parts',catno:'CAT1',detail:'Bolt',qty:2,price:25,clientPrice:0,clientPriceManual:false,warehouse:4,invoice:'INV',actNo:'',unit:'шт',orderStatus:'Прибула',createdBy:'',notes:'draft',action:'Записати',...overrides};}
function baseline(overrides={}){return{sclad_id:9,akt:null,kilkist_off:0,kilkist_on:2,name:'Bolt',price:25,client_price:null,shops:'Parts',xto_zamovuv:null,...overrides};}

test('failed insertion restores CRUD, reference state and main draft; removes every temporary input',async()=>{
  const failure=new Error('write denied');const f=fixture({onInsert:()=>{throw failure;}});
  const initialShop=structuredClone(f.context.shopEditState);const initialDetail=structuredClone(f.context.detailEditState);
  await assert.rejects(f.context.insertBatchStockRow(newRow(),'2026-10-21',null),e=>e===failure);
  assert.equal(f.context.CRUD,'Редагувати');assert.equal(f.control.value,'Main draft');assert.equal(f.attached.length,0);
  assert.deepEqual(f.context.shopEditState,initialShop);assert.deepEqual(f.context.detailEditState,initialDetail);
});

test('successful insertion reuses resolved references and explicit blank owner instead of main actor',async()=>{
  const f=fixture();const result=await f.context.insertBatchStockRow(newRow({clientPriceManual:true,clientPrice:0}),'2026-10-21',null);
  assert.equal(result.id,101);assert.equal(result.success,true);assert.equal(f.inserts.length,1);
  assert.equal(f.inserts[0].payload.xto_zamovuv,null);assert.equal(f.inserts[0].payload.client_price,0);
  assert.equal(f.inserts[0].options.referencesResolved,true);assert.equal(f.inserts[0].options.skipAuditLog,true);
  assert.equal(f.attached.length,0);assert.equal(f.context.CRUD,'Редагувати');assert.equal(f.control.value,'Main draft');
});

test('retry after failed insertion reads current row values without stale act or owner inputs',async()=>{
  const f=fixture({onInsert:({call})=>{if(call===1)throw Error('first failed');}});
  await assert.rejects(f.context.insertBatchStockRow(newRow({actNo:'123',notes:'first'}),'2026-10-21',11));
  await f.context.insertBatchStockRow(newRow({actNo:'456',notes:'second'}),'2026-10-21',12);
  assert.equal(f.inserts[1].payload.akt,'456');assert.equal(f.inserts[1].payload.xto_zamovuv,12);assert.equal(f.inserts[1].payload.prumitka,'second');assert.equal(f.attached.length,0);
});

test('existing hidden form fields are reused and restored without duplicate IDs',async()=>{
  const f=fixture();const hidden=f.add('sclad_akt','existing-act');
  await f.context.insertBatchStockRow(newRow({actNo:'999'}),'2026-10-21',null);
  assert.equal(f.inserts[0].payload.akt,'999');assert.equal(f.nodes.get('sclad_akt'),hidden);assert.equal(hidden.value,'existing-act');
});

test('legacy unit and inactive warehouse remain valid and temporary select options are cleaned',async()=>{
  const f=fixture();const unit=f.add('sclad_unit','шт','select',['шт']);const warehouse=f.add('sclad_procent','1','select',['1']);
  await f.context.insertBatchStockRow(newRow({unit:'к-т',warehouse:8}),'2026-10-21',null);
  assert.equal(f.inserts[0].payload.unit_measurement,'к-т');assert.equal(f.inserts[0].payload.scladNomer,8);
  assert.equal(unit.value,'шт');assert.equal(warehouse.value,'1');assert.equal(unit.options.length,1);assert.equal(warehouse.options.length,1);
});

test('failed row stays editable with server cause while the next row saves and retry button unlocks',async()=>{
  const f=fixture({onInsert:({call})=>{if(call===1)throw{message:'Row blocked by RLS'};}});
  const rows=[newRow({rowNumber:1,notes:'keep this draft'}),newRow({rowNumber:2,catno:'CAT2'})];f.context.parsedDataGlobal=rows;
  await f.context.uploadBatchData(rows);
  assert.equal(f.inserts.length,2);assert.equal(rows[0]._scladId,undefined);assert.equal(rows[0].notes,'keep this draft');assert.match(rows[0].status,/Row blocked by RLS/);
  assert.equal(rows[1]._scladId,'102');assert.match(rows[1].status,/Успішно/);assert.equal(f.statuses[0].success,false);assert.equal(f.button.attrs.disabled,undefined);
  assert.equal(f.context.isUploading,false);assert.equal(f.context.CRUD,'Редагувати');assert.equal(f.attached.length,0);
});

test('batch delete uses loaded snapshot in one guarded call and checks returned ID',async()=>{
  const f=fixture();f.context.originalSnapshotMap.set(9,{_db:baseline()});await f.context.deleteBatchStockRow({_scladId:9});
  assert.equal(f.queries.length,1);assert.equal(f.queries[0].op,'delete');assert.equal(f.queries[0].select,'sclad_id');
  assert.ok(f.queries[0].guards.some(([k,v])=>k==='akt'&&v===null));assert.ok(f.queries[0].guards.some(([k,v])=>k==='kilkist_off'&&v===0));assert.ok(f.queries[0].guards.some(([k,v])=>k==='price'&&v===25));
});

test('zero affected delete cannot be reported as success; row keeps its ID and failure cause',async()=>{
  const f=fixture({response:{error:null,data:[]}});const row=newRow({_scladId:9,action:'Видалити',rowNumber:1});f.context.originalSnapshotMap.set(9,{_db:baseline()});f.context.parsedDataGlobal=[row];
  await f.context.uploadBatchData([row]);
  assert.equal(f.queries.length,1);assert.equal(row._scladId,9);assert.match(row.status,/вже змінено/);assert.equal(f.statuses.length,1);assert.equal(f.statuses[0].success,false);assert.equal(f.button.attrs.disabled,undefined);
});

test('missing or mismatched deletion snapshot never sends a delete',async()=>{
  const f=fixture();await assert.rejects(f.context.deleteBatchStockRow({_scladId:9}),/початкові дані/);
  f.context.originalSnapshotMap.set(9,{_db:baseline({sclad_id:10})});await assert.rejects(f.context.deleteBatchStockRow({_scladId:9}),/початкові дані/);assert.equal(f.queries.length,0);
});

test('used stock and stock linked to an act cannot be deleted from the batch editor',async()=>{
  const f=fixture();for(const patch of[{kilkist_off:1},{akt:'1514'}]){f.context.originalSnapshotMap.set(9,{_db:baseline(patch)});await assert.rejects(f.context.deleteBatchStockRow({_scladId:9}),/вже використана/);}assert.equal(f.queries.length,0);
});

test('incomplete baseline cannot weaken consumption or act guards',async()=>{
  const f=fixture();const b=baseline();delete b.kilkist_off;f.context.originalSnapshotMap.set(9,{_db:b});await assert.rejects(f.context.deleteBatchStockRow({_scladId:9}),/Оновіть SQL/);assert.equal(f.queries.length,0);
});

test('mismatched delete receipt is a conflict, not confirmation of another row',async()=>{
  const f=fixture({response:{data:[{sclad_id:10}],error:null}});f.context.originalSnapshotMap.set(9,{_db:baseline()});await assert.rejects(f.context.deleteBatchStockRow({_scladId:9}),/вже змінено/);assert.equal(f.queries.length,1);
});


test('ordinary INSERT callback supplies a submitted snapshot for add then edit without another SELECT',async()=>{
  const f=fixture();f.context.handleScladCrud=options=>f.context.handleScladCrudActual(options);
  const row=newRow({rowNumber:1});f.context.parsedDataGlobal=[row];await f.context.uploadBatchData([row]);
  assert.equal(row._scladId,'9');assert.equal(row._dbSnapshot.price,25);assert.equal(row._dbSnapshot.kilkist_off,0);
  assert.equal(f.context.originalSnapshotMap.get('9')._db.sclad_id,9);
  row.price=30;await f.context.uploadBatchData([row]);
  assert.equal(f.queries.length,2);assert.equal(f.queries[0].op,'insert');assert.equal(f.queries[1].op,'update');
  assert.equal(f.queries[1].payload.price,30);assert.deepEqual(f.queries[1].guards,[['sclad_id',9]]);assert.equal(f.queries[1].expected.price,25);
  assert.equal(f.context.originalSnapshotMap.get('9')._db.price,30);assert.match(row.status,/Успішно/);
  await f.context.uploadBatchData([row]);assert.equal(f.queries.length,2);assert.match(row.status,/Без змін/);
  await f.context.deleteBatchStockRow(row);assert.ok(f.queries[2].guards.some(([k,v])=>k==='price'&&v===30));
});

test('ordinary newly inserted row can be guarded-deleted from its receipt snapshot without a read',async()=>{
  const f=fixture();f.context.handleScladCrud=options=>f.context.handleScladCrudActual(options);
  const row=newRow({rowNumber:1});f.context.parsedDataGlobal=[row];await f.context.uploadBatchData([row]);await f.context.deleteBatchStockRow(row);
  assert.equal(f.queries.length,2);assert.equal(f.queries[1].op,'delete');assert.equal(f.queries[1].select,'sclad_id');
});

test('created invoice receipt produces a usable snapshot; reused receipt never assumes unused stock',async()=>{
  for(const status of ['created','existing']){
    const f=fixture();let rpcCalls=0;f.context.supabase.rpc=async(name,args)=>{assert.equal(name,'stock_insert_invoice');rpcCalls++;return{error:null,data:{sclad_id:9,status}};};
    f.context.handleScladCrud=options=>f.context.handleScladCrudActual(options);
    const row=newRow({rowNumber:1,notes:'[atlas-invoice:'+ 'a'.repeat(64)+':1]'});f.context.parsedDataGlobal=[row];await f.context.uploadBatchData([row]);
    assert.equal(rpcCalls,1);assert.equal(row._scladId,'9');
    if(status==='created'){assert.equal(row._dbSnapshot.kilkist_off,0);await f.context.deleteBatchStockRow(row);assert.equal(f.queries.length,1);}
    else{assert.equal(row._dbSnapshot,undefined);await assert.rejects(f.context.deleteBatchStockRow(row),/початкові дані/);assert.equal(f.queries.length,0);}
  }
});


test('stock insert survives act-sync failure; retry updates the act without reinserting stock',async()=>{
  const f=fixture();f.context.handleScladCrud=options=>f.context.handleScladCrudActual(options);
  const actWrites=[];f.context.batchUpdateActWithDetails=async(id,details)=>{actWrites.push({id,details:structuredClone(details)});return actWrites.length>1;};
  const row=newRow({rowNumber:1,actNo:'123',clientPrice:50});f.context.parsedDataGlobal=[row];
  await f.context.uploadBatchData([row]);
  assert.equal(f.queries.length,1);assert.equal(row._scladId,'9');assert.equal(row._actSyncPending,true);assert.equal(row.status,'⚠️ Збережено (акт не оновлено)');
  assert.equal(f.button.attrs.disabled,undefined);assert.equal(f.context.originalSnapshotMap.get('9')._db.price,25);
  await f.context.uploadBatchData([row]);
  assert.equal(f.queries.length,1);assert.equal(actWrites.length,2);assert.equal(actWrites[1].details[0]._updateExisting,true);
  assert.equal(row._actSyncPending,undefined);assert.match(row.status,/Без змін/);assert.equal(f.context.originalSnapshotMap.get('9')._db.price,25);
});

test('stock cell update is not repeated after failed act-sync, and committed changes remain the new baseline',async()=>{
  const f=fixture();const original=newRow({_scladId:9,rowNumber:1,actNo:'123',clientPrice:50,_dbSnapshot:baseline({akt:'123'})});f.context.saveRowSnapshot(original);
  const row={...original,price:30,clientPrice:60};f.context.parsedDataGlobal=[row];
  const actWrites=[];f.context.batchUpdateActWithDetails=async(id,details)=>{actWrites.push(structuredClone(details));return actWrites.length>1;};
  await f.context.uploadBatchData([row]);
  assert.equal(f.queries.length,1);assert.equal(f.queries[0].op,'update');assert.equal(f.queries[0].payload.price,30);
  assert.equal(row._actSyncPending,true);assert.equal(row.status,'⚠️ Збережено (акт не оновлено)');assert.equal(f.context.originalSnapshotMap.get(9)._db.price,30);
  await f.context.uploadBatchData([row]);
  assert.equal(f.queries.length,1);assert.equal(actWrites.length,2);assert.equal(actWrites[1][0]._updateExisting,true);assert.equal(actWrites[1][0]['Ціна'],60);assert.equal(row._actSyncPending,undefined);
});


test('partial delete success plus insert failure retries only the failed insert and finishes',async()=>{
  const f=fixture({onInsert:({call})=>{if(call===1)throw Error('temporary insert failure');}});
  const deleted=newRow({_scladId:9,rowNumber:1,action:'Видалити'});const insert=newRow({rowNumber:2});
  f.context.originalSnapshotMap.set(9,{_db:baseline()});f.context.parsedDataGlobal=[deleted,insert];
  await f.context.uploadBatchData([deleted,insert]);
  assert.equal(deleted.status,'🗑️ Видалено');assert.equal(deleted._scladId,9);assert.equal(f.queries.length,1);assert.match(insert.status,/temporary insert failure/);
  await f.context.uploadBatchData([deleted,insert]);
  assert.equal(f.queries.length,1,'confirmed deletion was not retried');assert.equal(f.inserts.length,2);assert.match(insert.status,/Успішно/);
  assert.equal(f.button.attrs.disabled,'true');assert.equal(f.notifications.at(-1)[1],'success');
});

test('UI retry excludes completed deleted/skipped rows before validation and keeps failed insert',async()=>{
  const f=fixture({onInsert:({call})=>{if(call===1)throw Error('temporary insert failure');}});
  const deleted=newRow({_scladId:9,rowNumber:1,action:'Видалити'});const skipped=newRow({rowNumber:2,action:'Видалити'});const insert=newRow({rowNumber:3,warehouse:'4',warehouseValid:true});
  f.context.originalSnapshotMap.set(9,{_db:baseline()});f.context.parsedDataGlobal=[deleted,skipped,insert];
  await f.context.uploadBatchData([deleted,skipped,insert]);
  deleted.unit='';skipped.unit=''; // Finished deletions no longer need valid insert fields.
  f.context.document.querySelector=()=>null;
  Object.assign(f.context,{refreshEnteredActValidity:async()=>{},VALID_UNITS:['шт'],warehouseListCache:['4'],actsListCache:[],actsDateOffMap:new Map(),showConfirmModal:async count=>{assert.equal(count,1);return true;},assertInvoiceOriginsNotPresent:async()=>{}});
  await f.context.runUploadClick();
  assert.equal(f.queries.length,1);assert.equal(f.inserts.length,2);assert.match(insert.status,/Успішно/);assert.equal(f.button.attrs.disabled,'true');
  assert.equal(deleted.status,'🗑️ Видалено');assert.equal(skipped.status,'🗑️ Пропущено');assert.equal(f.notifications.at(-1)[1],'success');
});

test('failed guarded delete remains pending and is retried, never mistaken for completed deletion',async()=>{
  const response={error:null,data:[]};const f=fixture({response});const row=newRow({_scladId:9,rowNumber:1,action:'Видалити'});
  f.context.originalSnapshotMap.set(9,{_db:baseline()});f.context.parsedDataGlobal=[row];
  await f.context.uploadBatchData([row]);assert.equal(f.context.isCompletedBatchDeletion(row),false);assert.match(row.status,/вже змінено/);
  response.data=[{sclad_id:9}];await f.context.uploadBatchData([row]);assert.equal(f.queries.length,2);assert.equal(row.status,'🗑️ Видалено');assert.equal(f.button.attrs.disabled,'true');
});
