const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const api={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/ai/storageMetadata.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
}).outputText,{exports:api});
test('metadata traverses all pages without downloading objects',async()=>{
 const calls=[];
 const result=await api.readStorageMetadata(async(folder,offset,limit)=>{
  calls.push([folder,offset,limit]);
  if(!folder) return offset===0 ? Array.from({length:200},(_,i)=>({id:null,name:String(i)})) : offset===200 ? [{id:null,name:'200'},{id:'root',name:'root.jpg',metadata:{size:1048576}}] : [];
  return [{id:folder,name:'file.jpg',metadata:{size:1048576}}];
 });
 assert.equal(result.totalFiles,202); assert.equal(result.totalSizeMb,202);
 assert.equal(calls.length,203); assert.ok(calls.every(c=>c[2]===200));
});
test('metadata failures remain failures instead of a false zero',async()=>{
 await assert.rejects(api.readStorageMetadata(async()=>{throw Error('denied')}),/denied/);
});
test('text message write has no storage listing or invalidation',()=>{
 const source=fs.readFileSync('src/ts/roboha/ai/aiChatStorage.ts','utf8');
 const save=source.slice(source.indexOf('export async function saveMessage('),source.indexOf('export async function deleteMessage('));
 assert.doesNotMatch(save,/\.list\(|getStorageStats|invalidateFiles/);
 assert.match(save,/invalidateMessages\(\)/);
 assert.match(source,/event.key === CHAT_REVISION/);
 assert.match(source,/event.key === FILE_REVISION/);
});
