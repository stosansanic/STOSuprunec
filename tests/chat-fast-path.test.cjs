const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), vm=require('node:vm'), ts=require('typescript');
const api={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname,'../src/ts/roboha/ai/chatFastPath.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:api});
test('Ukrainian greetings use the short prompt',()=>{
 for(const text of ['Привіт!','Дякую','Як справи?','Що ти вмієш?',' hi '])assert.equal(api.isTrivialQuery(text),true,text);
});
test('actions and follow-up questions keep tools and context',()=>{
 for(const text of ['Привіт, знайди клієнта','Добре, нагадай завтра','що нового','допоможи знайти авто','скільки актів відкрито','покажи його телефон'])assert.equal(api.isTrivialQuery(text),false,text);
});
