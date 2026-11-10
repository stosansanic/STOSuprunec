const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const api={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/ai/messagePageCache.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
}).outputText,{exports:api,structuredClone});
test('chat pages reuse concurrent reads, isolate returned rows and expire',async()=>{
 let time=0,calls=0,resolve;const cache=api.createMessagePageCache(()=> 'user',()=>time);
 const fetch=()=>{calls++;return new Promise(r=>resolve=r)};
 const first=cache.read('1',fetch),second=cache.read('1',fetch);assert.equal(calls,1);
 resolve([{id:1,images:['photo']}]);const a=await first,b=await second;
 a[0].images.push('changed');assert.equal(b[0].images.length,1);
 assert.equal((await cache.read('1',fetch))[0].images.length,1);assert.equal(calls,1);
 time=15000;const expired=cache.read('1',fetch);assert.equal(calls,2);resolve([]);await expired;
});
test('chat cache drops pending responses after invalidation or account change',async()=>{
 let owner='one',resolve;const cache=api.createMessagePageCache(()=>owner);
 const old=cache.read('1',()=>new Promise(r=>resolve=r));cache.clear();resolve([]);await assert.rejects(old);
 const changed=cache.read('1',()=>new Promise(r=>resolve=r));owner='two';resolve([]);await assert.rejects(changed);
 let calls=0;await cache.read('1',async()=>{calls++;return []});await cache.read('1',async()=>{calls++;return []});assert.equal(calls,1);
 owner='one';await cache.read('1',async()=>{calls++;return []});assert.equal(calls,2);
});
test('chat cache does not cache failures, unknown owners or more than twenty pages',async()=>{
 let owner='',calls=0;const cache=api.createMessagePageCache(()=>owner);
 const fetch=async()=>{calls++;return []};await cache.read('1',fetch);await cache.read('1',fetch);assert.equal(calls,2);
 owner='known';await assert.rejects(cache.read('error',async()=>{throw Error('denied')}));await cache.read('error',fetch);
 for(let i=0;i<21;i++) await cache.read(String(i),fetch);
 const previous=calls;await cache.read('0',fetch);assert.equal(calls,previous+1);
});
