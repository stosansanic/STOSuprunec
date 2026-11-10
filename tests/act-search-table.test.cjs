const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');
function fixture(read){
 const ast=ts.createSourceFile('table.ts',fs.readFileSync('src/ts/roboha/tablucya/tablucya.ts','utf8'),99,true);
 const names=['loadActsTable','renderActPageNavigation'];const source=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast).replace(/^export /,'')).join('\n');
 const element=tag=>({tag,children:[],style:{},dataset:{},isConnected:true,setAttribute(){},remove(){this.isConnected=false},append(...nodes){this.children.push(...nodes)},appendChild(node){this.children.push(node)},querySelector(selector){return selector==='tbody'||selector==='table > tbody'?element('tbody'):null},set innerHTML(_){this.children=[]},classList:{add(){}}});
 const container=element('main'),calls=[],notes=[];const ctx={exports:{},userAccessLevel:"Адміністратор",tableLoadGeneration:0,activeActPage:null,stopActLazyLoading:null,activeActSort:'id',actsGlobal:[],clientsGlobal:[],carsGlobal:[],modifiedActIdsGlobal:new Set(),actNotificationCounts:new Map(),
 statusRecords:new Map(),statusPageOwner:'',statusPageGeneration:-1,statusPageShowSuma:true,
 localStorage:{getItem:()=> 'test-actor'},finishActStatusPageLoad:()=>{ctx.statusPageFinished=(ctx.statusPageFinished||0)+1;},
 isUserAuthenticated:()=>true,canUserViewActs:async()=>true,canUserSeePriceColumns:async()=>true,hideActCounters:()=>{},createActTableRow:act=>act,createTable:()=>element('table'),IntersectionObserver:class {constructor(callback){this.callback=callback;ctx.observer=this}observe(row){this.target=row}unobserve(){}disconnect(){this.disconnected=true}},renderSkeletonRows:()=>{},
 document:{getElementById:id=>id==='table-container-modal-sakaz_narad'?container:{value:'Відкриті'},createElement:element},
 readActSearchPage:async(input,reuse)=>{calls.push({input,reuse});return read(input)},fetchActNotificationCounts:async ids=>{notes.push(ids);return new Map()},
 updateSmartSearchHint:()=>{},getSmartSearchHint:()=>'',parseSmartSearch:()=>[],updateActSearchSummary:(q,found,total)=>ctx.summary={q,found,total},refreshActCounters:()=>{},
 showNoDataMessage:()=>{},showTableLoadError:()=>{throw Error('Unexpected table error')},console};
 container.querySelectorAll=()=>ctx.actsGlobal;
 vm.createContext(ctx);vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,ctx);
 return {ctx,container,calls,notes};
}
test('act table appends five at the bottom and coalesces repeated intersection events',async()=>{
 const f=fixture(input=>({items:Array.from({length:input.limit||50},(_,i)=>({act_id:1005-input.offset-i})),clients:[],cars:[],total:1005,matched:1005,has_more:true,next_offset:input.offset+(input.limit||50)}));
 await f.ctx.loadActsTable(null,null,'open','',false);
 assert.equal(f.calls.length,1);assert.equal(f.ctx.actsGlobal.length,50);assert.equal(f.container.dataset.actTotal,'1005');
 assert.equal(f.ctx.statusPageOwner,'test-actor');assert.equal(f.ctx.statusPageGeneration,f.ctx.tableLoadGeneration);assert.equal(f.ctx.statusPageFinished,1);
 const nav=f.container.children.find(x=>x.className==='act-lazy-loading');assert.equal(nav.children.length,0);
 assert.equal(f.ctx.observer.target.act_id,961);
 f.ctx.observer.callback([{isIntersecting:true}]);f.ctx.observer.callback([{isIntersecting:true}]);
 await new Promise(r=>setImmediate(r));
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].input.limit,5);assert.equal(f.calls[1].input.offset,50);
 assert.equal(f.ctx.actsGlobal.length,55);assert.equal(f.ctx.actsGlobal[0].act_id,1005);assert.equal(f.ctx.actsGlobal[54].act_id,951);
 assert.equal(nav.textContent,'Показано 55 із 1005');assert.equal(f.ctx.observer.target.act_id,956);
});

test('act table trusts server work/detail matching without re-filtering stripped projections',async()=>{
 const f=fixture(()=>({items:[{act_id:1,data:{}}],clients:[],cars:[],total:1005,matched:1,has_more:false,next_offset:null}));
 await f.ctx.loadActsTable(null,null,'open','робота:масло',false);
 assert.equal(f.calls.length,1);assert.equal(f.ctx.actsGlobal[0].act_id,1);assert.equal(f.ctx.summary.found,1);assert.equal(f.ctx.summary.total,1005);
});

test('late search page cannot overwrite the newer search or its counters',async()=>{
 const pending=new Map();const f=fixture(input=>new Promise(resolve=>pending.set(input.query,resolve)));
 const page=id=>({items:[{act_id:id,data:{}}],clients:[],cars:[],total:1005,matched:1,has_more:false,next_offset:null});
 const first=f.ctx.loadActsTable(null,null,'open','first',false);
 while(!pending.has('first')) await Promise.resolve();
 const second=f.ctx.loadActsTable(null,null,'open','second',false);
 while(!pending.has('second')) await Promise.resolve();
 pending.get('second')(page(2));await second;pending.get('first')(page(1));await first;
 assert.equal(f.ctx.actsGlobal[0].act_id,2);assert.equal(f.ctx.summary.q,'second');assert.equal(f.notes.length,1);
});

test('refresh after last-page deletion navigates to the final valid page',async()=>{
 const f=fixture(input=>({items:input.offset===100?[]:[{act_id:1}],clients:[],cars:[],total:100,matched:100,has_more:false,next_offset:null}));
 await f.ctx.loadActsTable(null,null,'open','',false,100);
 assert.deepEqual(f.calls.map(x=>x.input.offset),[100,50]);assert.equal(f.ctx.actsGlobal[0].act_id,1);
});
