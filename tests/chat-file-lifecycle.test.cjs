const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const vm=require('vm');const ts=require('typescript');
function loadStorage(failList=false){
 let deleted=false;const removals=[],lists=[];
 const client={auth:{onAuthStateChange(){}},from(){let after=0,remove=false;const q={select(){return q},eq(){return q},gt(_k,v){after=v;return q},order(){return q},limit(){return q},delete(){remove=true;return q},then(resolve){if(remove){deleted=true;return Promise.resolve({error:null}).then(resolve)}return Promise.resolve({data:Array.from({length:450},(_,i)=>({message_id:i+1,images:['https://host/storage/v1/object/public/ai-photos/1/'+i+'.jpg']})).filter(r=>r.message_id>after).slice(0,200)}).then(resolve)}};return q},storage:{from(){return {async list(_folder,p){lists.push(p.offset);return failList?{error:Error('denied')}:{data:Array.from({length:1205},(_,i)=>({id:String(i),name:i+'.jpg'})).slice(p.offset,p.offset+p.limit)}},async remove(paths){removals.push(paths);return {error:null}}}}}};
 const out={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/ai/aiChatStorage.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{
 exports:out,require:n=>n.includes('supabaseClient')?{supabase:client}:n.includes('messagePageCache')?{createMessagePageCache:()=>({clear(){},read:(_key,f)=>f()})}:{},window:{addEventListener(){}},localStorage:{getItem:()=>'',setItem(){}},crypto:{randomUUID:()=> 'revision'}
 });return {out,removals,lists,deleted:()=>deleted};
}
test('chat deletion reads all metadata before bounded removal, including beyond 1000 files',async()=>{
 const state=loadStorage();assert.equal(await state.out.deleteChat(1),true);assert.equal(state.deleted(),true);
 assert.deepEqual(state.lists,[0,200,400,600,800,1000,1200]);
 assert.equal(new Set(state.removals.flat()).size,1205);assert.ok(state.removals.every(p=>p.length<=100));
});
test('failed metadata read does not delete chat and lose file references',async()=>{
 const state=loadStorage(true);assert.equal(await state.out.deleteChat(1),false);assert.equal(state.deleted(),false);assert.equal(state.removals.length,0);
});
