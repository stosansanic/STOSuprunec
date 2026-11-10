const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');
test('act search emits once after ten quick keystrokes, Enter cancels debounce, Escape clears once',()=>{
 let id=0;const timers=new Map();const input={style:{},value:'',events:{},addEventListener(n,f){this.events[n]=f},focus(){}};
 const icon={addEventListener(){}};const exports={};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/tablucya/pochuk.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{
 exports,document:{getElementById:id=>id==='searchInput'?input:icon},setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id},clearTimeout:id=>timers.delete(id)});
 const search=new exports.SearchHandler(),calls=[];search.setSearchCallback(q=>calls.push(q));
 for(let n=1;n<=10;n++){input.value='0123456789'.slice(0,n);input.events.input()}
 assert.equal(timers.size,1);const timer=[...timers.values()][0];assert.equal(timer.ms,500);timers.clear();timer.fn();assert.deepEqual(calls,['0123456789']);
 input.value='BMW';input.events.input();input.events.keydown({key:'Enter',preventDefault(){}});assert.equal(timers.size,0);assert.deepEqual(calls,['0123456789','BMW']);
 input.events.keydown({key:'Escape'});assert.equal(timers.size,1);const hide=[...timers.values()][0];timers.clear();hide.fn();assert.deepEqual(calls,['0123456789','BMW','']);
});
