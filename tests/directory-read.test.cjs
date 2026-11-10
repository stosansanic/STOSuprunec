const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function fixture(rpc){let actor='A';const api={},listeners=new Map(),supabase={rpc,auth:{onAuthStateChange:fn=>listeners.set('auth',fn)}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/directoryRead.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:p=>p.includes('supabase')?{supabase}:{},structuredClone,localStorage:{getItem:()=>actor},window:{addEventListener:(e,fn)=>listeners.set(e,fn),dispatchEvent(){}},document:{addEventListener:(e,fn)=>listeners.set(e,fn)},CustomEvent:class{constructor(type){this.type=type}}});
 return{api,setActor:a=>actor=a,emit:e=>listeners.get(e)?.()};}
test('directories share pending requests and scoped short cache, no mutable cache aliases',async()=>{
 let finish,calls=0;const f=fixture(async()=>{calls++;return new Promise(resolve=>finish=resolve)});
 const a=f.api.readDirectory('incomes','part'),b=f.api.readDirectory('incomes','part');finish({data:{items:[{income_id:1,data:{Name:'part'}}],total:1}});const [x,y]=await Promise.all([a,b]);x.items[0].data.Name='mutated';assert.equal(y.items[0].data.Name,'part');assert.equal((await f.api.readDirectory('incomes','part')).items[0].data.Name,'part');assert.equal(calls,1);
 const late=f.api.readDirectory('incomes','other');f.setActor('B');finish({data:{items:[],total:0}});await assert.rejects(late,/змінився/);
});
test('directory metadata write emits only explicit fields, then invalidates current query',async()=>{
 const calls=[];const f=fixture(async(name,args)=>{calls.push([name,args]);return{name,data:name==='traffic_directory_write'?{status:'updated',row:{income_id:1,data:{Name:'New'}}}:{items:[],total:0}}});
 await f.api.readDirectory('incomes');await f.api.readDirectory('incomes');assert.equal(calls.length,1);
 await f.api.writeDirectory('incomes',1,{Name:'New'},{Name:'Old'});await f.api.readDirectory('incomes');assert.equal(calls.length,3);assert.equal(calls[1][1].p_patch.Name,'New');assert.equal(calls[1][1].p_patch.Історія,undefined);
 for(const event of ['auth','online','other-base-data-updated']){f.emit(event);await f.api.readDirectory('incomes');}assert.equal(calls.length,6);
});
test('access/RPC failure remains an error; there is no broad table fallback',async()=>{
 for(const code of ['42501','PGRST202']){const f=fixture(async()=>({error:{code}}));await assert.rejects(f.api.readDirectory('incomes'),e=>e.code===code);}
});
test('selected employee credential metadata shares in-flight work but never enters the dictionary TTL cache',async()=>{
 let calls=0,finish;const f=fixture(()=>{calls++;return new Promise(resolve=>finish=resolve)});
 const a=f.api.readDirectory('slyusars','',0,false,1),b=f.api.readDirectory('slyusars','',0,false,1);finish({data:{items:[{slyusar_id:1,data:{Name:'Employee',Пароль:'hash'}}],total:1}});await Promise.all([a,b]);assert.equal(calls,1);
 const again=f.api.readDirectory('slyusars','',0,false,1);assert.equal(calls,2);finish({data:{items:[],total:0}});await again;
});
test('detaching a mounted input aborts listeners and disconnects its DOM observer',()=>{
 const api={},observers=[];class Observer{constructor(callback){this.callback=callback;observers.push(this)}observe(){}disconnect(){this.disconnected=true}}
 const document=new EventTarget();document.documentElement={};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/directoryRead.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:p=>p.includes('supabase')?{supabase:{}}:{setupDropdownKeyboard(){}},document,AbortController,MutationObserver:Observer,clearTimeout,localStorage:{getItem:()=>''}});
 const input=new EventTarget();input.dataset={};input.isConnected=true;const dropdown=new EventTarget();dropdown.replaceChildren=()=>{};dropdown.classList={add(){}};api.mountDirectoryDropdown('incomes',input,dropdown,()=>{});
 input.isConnected=false;observers[0].callback();assert.equal(input.__directoryController.signal.aborted,true);assert.equal(observers[0].disconnected,true);
});

test('complete name results narrow from cache, truncated pages query the server and close invalidates',async()=>{
 const calls=[];const f=fixture(async(name,args)=>{calls.push(args);return {data:{items:[{work_id:1,data:'Brake repair'},{work_id:2,data:'Brake pad'}],total:args.p_query==='brake'?2:51}}});
 await f.api.readDirectory('works','brake');
 const narrowed=await f.api.readDirectory('works','brake pad');assert.equal(narrowed.total,1);assert.equal(calls.length,1);
 f.emit('sto:other-bases-closed');await f.api.readDirectory('works','brake pad');assert.equal(calls.length,2);
 await f.api.readDirectory('works','brake pads');assert.equal(calls.length,3);
});
test('unchanged metadata sends no write; changed patch and delete carry only target baseline',async()=>{
 const calls=[];const f=fixture(async(name,args)=>{calls.push([name,args]);return {data:name==='traffic_directory_delete'?{status:'deleted',id:8}:{status:'updated',row:{shop_id:8,data:{Name:'New'}}}}});
 assert.equal((await f.api.writeDirectory('shops',8,{Name:'Old'},{Name:'Old'})).status,'unchanged');assert.equal(calls.length,0);
 await f.api.writeDirectory('shops',8,{Name:'New'},{Name:'Old'});
 assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1].p_patch)),{Name:'New'});
 await f.api.deleteDirectory('shops',8,{Name:'New'});assert.equal(calls.length,2);assert.equal(calls[1][1].p_id,8);
});
test('invalid mutation receipts never report success',async()=>{
 for(const response of [{},{status:'deleted',id:9},{status:'deleted',id:null}]){
  const f=fixture(async()=>({data:response}));await assert.rejects(f.api.deleteDirectory('shops',8,{Name:'X'}),/підтвердила/);
 }
 const f=fixture(async()=>({data:{status:'updated',row:{shop_id:9,data:{Name:'X'}}}}));await assert.rejects(f.api.writeDirectory('shops',8,{Name:'X'},{Name:'Old'}),/підтвердження/);
});

test('selected directory reads reject a different row or a non-progressing page',async()=>{
 for(const data of [{items:[{slyusar_id:2,data:{Name:'Other'}}],total:1},{items:[],total:5}]){
  const f=fixture(async()=>({data}));await assert.rejects(f.api.readDirectory('slyusars','',0,false,1),/Некоректна сторінка/);
 }
});

function dropdownFixture(rpc){
 const api={},timers=new Map();let timerId=0;
 class Element extends EventTarget{
  constructor(){super();this.children=[];this.dataset={};this.style={};this.value='';this.isConnected=true;this.scrollTop=0;this.clientHeight=100;this.scrollHeight=100;this.flags=new Set(['hidden-all_other_bases']);this.classList={add:x=>this.flags.add(x),remove:x=>this.flags.delete(x),contains:x=>this.flags.has(x),toggle:(x,on)=>on?this.flags.add(x):this.flags.delete(x)};}
  replaceChildren(){for(const child of this.children)child.parent=null;this.children=[];}
  append(child){child.parent=this;this.children.push(child);}
  contains(node){return node===this||this.children.some(child=>child.contains(node));}
  querySelector(){return this.children.find(child=>'directoryMore' in child.dataset)||null;}
  setAttribute(){}
  remove(){if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}
 }
 const document=new EventTarget();document.documentElement={};document.createElement=()=>new Element();
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/directoryRead.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:p=>p.includes('supabase')?{supabase:{rpc}}:{setupDropdownKeyboard(){}},structuredClone,localStorage:{getItem:()=>''},document,AbortController,MutationObserver:class{observe(){}disconnect(){}},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
 const input=new Element(),dropdown=new Element();
 const emit=(target,type,extra={})=>{const event=new Event(type);Object.assign(event,extra);target.dispatchEvent(event);};
 return{api,input,dropdown,document,emit,flushTimers(){const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());},tick:()=>new Promise(resolve=>setImmediate(resolve))};
}

test('remounting the shared dropdown removes old work choices and prevents detached callbacks',async()=>{
 const selected=[];const f=dropdownFixture(async(_name,args)=>({data:{items:[args.p_kind==='works'?{work_id:1,data:'Repair'}:{income_id:2,data:{Name:'Source'}}],total:1}}));
 f.input.value='rep';f.api.mountDirectoryDropdown('works',f.input,f.dropdown,row=>selected.push(row.work_id));f.emit(f.input,'focus');await f.tick();const old=f.dropdown.children[0];
 f.input.value='';f.api.mountDirectoryDropdown('incomes',f.input,f.dropdown,row=>selected.push(row.income_id));assert.equal(f.dropdown.children.length,0);f.emit(old,'click');await f.tick();assert.deepEqual(selected,[]);
 f.emit(f.input,'focus');await f.tick();f.emit(f.dropdown.children[0],'click');await f.tick();assert.deepEqual(selected,[2]);
});

test('typing clears old choices immediately and ignores their click during debounce',async()=>{
 let calls=0;const selected=[];const f=dropdownFixture(async()=>{calls++;return{data:{items:[{work_id:1,data:'Repair'}],total:1}}});
 f.input.value='rep';f.api.mountDirectoryDropdown('works',f.input,f.dropdown,row=>selected.push(row));f.emit(f.input,'focus');await f.tick();const old=f.dropdown.children[0];
 f.input.value='other';f.emit(f.input,'input');assert.equal(f.dropdown.children.length,0);f.emit(old,'click');await f.tick();assert.equal(selected.length,0);assert.equal(calls,1);
 f.flushTimers();await f.tick();assert.equal(calls,2);
});

test('Escape and outside click cancel delayed opens; Escape also rejects a late response',async()=>{
 let calls=0,finish;const f=dropdownFixture(()=>{calls++;return new Promise(resolve=>finish=resolve)});
 f.api.mountDirectoryDropdown('works',f.input,f.dropdown,()=>{});f.input.value='rep';f.emit(f.input,'input');f.emit(f.input,'keydown',{key:'Escape'});f.flushTimers();assert.equal(calls,0);
 f.emit(f.input,'input');f.emit(f.document,'click');f.flushTimers();assert.equal(calls,0);
 f.emit(f.input,'focus');assert.equal(calls,1);f.emit(f.input,'keydown',{key:'Escape'});finish({data:{items:[{work_id:1,data:'Repair'}],total:1}});await f.tick();assert.equal(f.dropdown.children.length,0);assert.equal(f.dropdown.classList.contains('hidden-all_other_bases'),true);
});

test('scroll appends one page and already visible choices remain selectable without rereads',async()=>{
 const calls=[],selected=[];const f=dropdownFixture(async(_name,args)=>{calls.push(args.p_offset);return{data:{items:[{income_id:args.p_offset+1,data:{Name:'Name '+args.p_offset}}],total:2}}});
 f.api.mountDirectoryDropdown('incomes',f.input,f.dropdown,row=>selected.push(row.income_id));f.emit(f.input,'focus');await f.tick();const first=f.dropdown.children[0];
 f.emit(f.dropdown,'scroll');f.emit(f.dropdown,'scroll');await f.tick();assert.deepEqual(calls,[0,1]);assert.equal(f.dropdown.children.length,2);f.emit(first,'click');await f.tick();assert.deepEqual(selected,[1]);assert.deepEqual(calls,[0,1]);
});

test('a late selection error cannot replace a newer search result',async()=>{
 let reject;const f=dropdownFixture(async(_name,args)=>({data:{items:[{work_id:1,data:args.p_query}],total:1}}));
 f.input.value='rep';f.api.mountDirectoryDropdown('works',f.input,f.dropdown,()=>new Promise((_resolve,no)=>reject=no));f.emit(f.input,'focus');await f.tick();f.emit(f.dropdown.children[0],'click');await f.tick();
 f.input.value='new';f.emit(f.input,'input');f.flushTimers();await f.tick();reject(Error('Obsolete failed read'));await f.tick();assert.match(f.dropdown.children[0].textContent,/new/);
});

test('write/delete conflicts discard a stale name baseline without automatically retrying',async()=>{
 for(const operation of ['write','delete']){
  const calls=[];let version=0;const f=fixture(async(name,args)=>{calls.push(name);return name==='traffic_directory_page'?{data:{items:[{shop_id:8,data:{Name:version?'Changed elsewhere':'Old'}}],total:1}}:{error:{code:'40001',message:'conflict'}};});
  await f.api.readDirectory('shops');version++;
  await assert.rejects(operation==='write'?f.api.writeDirectory('shops',8,{Name:'New'},{Name:'Old'}):f.api.deleteDirectory('shops',8,{Name:'Old'}),e=>e.code==='40001');
  assert.equal(calls.length,2);assert.equal((await f.api.readDirectory('shops')).items[0].data.Name,'Changed elsewhere');assert.equal(calls.length,3);
 }
});
