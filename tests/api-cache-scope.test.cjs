const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),{webcrypto}=require('node:crypto');
function worker() {
 const listeners={},cache=new Map();let online=true,body='employee A';
 const context=vm.createContext({URL,Request,Response,Headers,TextEncoder,crypto:webcrypto,
  self:{location:{origin:'https://app.example'},addEventListener:(name,fn)=>listeners[name]=fn},
  caches:{open:async()=>({put:async(k,v)=>cache.set(k.url,v.clone()),match:async k=>cache.get(k.url)?.clone()})},
  fetch:async()=>{if(!online)throw Error('offline');return new Response(body)}
 });
 vm.runInContext(fs.readFileSync('public/sw.js','utf8'),context);
 return {context,cache,listeners,setOnline:v=>online=v,setBody:v=>body=v,
  scope:(id,scope)=>listeners.message({data:{type:'STO_API_SCOPE',scope},source:{id},ports:[{postMessage(){}}]})};
}
test('same JWT and URL do not share cached responses across internal employees',async()=>{
 const w=worker(),request=new Request('https://demo.supabase.co/rest/v1/acts',{headers:{authorization:'Bearer same'}});
 w.scope('tab','a'.repeat(64));await w.context.networkFirstWithApiCache(request,'tab');w.setOnline(false);
 const cached=await w.context.networkFirstWithApiCache(request,'tab');assert.equal(await cached.text(),'employee A');
 assert.equal(cached.headers.get('X-Offline-Fallback'),'true');assert.ok(cached.headers.get('X-Sto-Cached-At'));
 w.scope('tab','b'.repeat(64));assert.equal((await w.context.networkFirstWithApiCache(request,'tab')).status,503);
 w.setOnline(true);w.setBody('employee B');await w.context.networkFirstWithApiCache(request,'tab');
 assert.equal(w.cache.size,2);
});
test('unknown employee and no-store requests never populate or consume private cache',async()=>{
 const w=worker(),request=new Request('https://demo.supabase.co/rest/v1/acts');
 await w.context.networkFirstWithApiCache(request,'unknown');assert.equal(w.cache.size,0);
 w.scope('tab','a'.repeat(64));await w.context.networkFirstWithApiCache(new Request(request,{cache:'no-store'}),'tab');assert.equal(w.cache.size,0);
 w.setOnline(false);assert.equal((await w.context.networkFirstWithApiCache(request,'unknown')).status,503);
 let intercepted=false;w.listeners.fetch({request:{url:'https://demo.supabase.co/storage/v1/private',method:'GET'},respondWith(){intercepted=true}});assert.equal(intercepted,false);
});
test('client hashes employee context and waits for worker acknowledgement before REST GET',async()=>{
 const api={},calls=[];let raw='private employee auth';
 const context={exports:api,URL,Request,Response,TextEncoder,crypto:webcrypto,MessageChannel,setTimeout,clearTimeout,
  localStorage:{getItem:()=>raw},navigator:{serviceWorker:{controller:{postMessage(message,ports){calls.push(message);ports[0].postMessage({scope:message.scope})}}}},
  fetch:async(input,init)=>{calls.push(init);return new Response('ok')}
 };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/vxid/apiCacheScope.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
 await api.scopedSupabaseFetch('https://demo.supabase.co/rest/v1/acts');
 assert.match(calls[0].scope,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(calls).includes(raw));assert.equal(calls.length,2);
 raw='';calls.length=0;await api.scopedSupabaseFetch('https://demo.supabase.co/rest/v1/acts');assert.equal(calls[0].cache,'no-store');
});
