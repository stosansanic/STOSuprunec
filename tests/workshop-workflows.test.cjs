// Isolated fixtures, no production calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { randomUUID } = require('node:crypto');
const root = path.resolve('src/ts');
const copy = value => structuredClone(value);
function loader(stubs = {}, extra = {}) {
  const cache = new Map();
  function load(file) {
    const full = path.resolve(root, file.endsWith('.ts') ? file : file + '.ts');
    if (cache.has(full)) return cache.get(full);
    const module = { exports: {} }; cache.set(full, module.exports);
    const code = ts.transpileModule(fs.readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, structuredClone, URL, crypto: { randomUUID }, navigator: { onLine: true },
      require: name => { const target = path.resolve(path.dirname(full), name + '.ts'); return stubs[target] || load(target); }, ...extra }, { filename: full });
    return module.exports;
  }
  return load;
}
const model = loader()('roboha/workshop/model');
const invoice = loader()('roboha/workshop/invoiceModel');
const rec = (id = 'rec') => ({ id, text: 'Перевірити ГБЦ', state: 'proposed', author: 'Майстер', updatedAt: '2026-09-01T10:00:00Z' });
const defect = () => ({ id: 'defect', assembly: 'Блок', component: 'Циліндр 1', before: '80,41 мм', after: '', tolerance: '80,40–80,42 мм; довідник', finding: 'Зношення', operation: 'Розточування', photoUrl: '', state: 'repair', author: 'Майстер', updatedAt: '2026-09-01T10:00:00Z' });
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function fixture(online = true) {
  const user = { userAccessLevel: 'Адміністратор', userName: 'Майстер', canUserViewActs: async () => true, canUserOpenActs: async () => true };
  const db = { row: { act_id: 1, cars_id: 5, date_off: null, pruimalnyk: 'Майстер', data: { __act_revision: 'baseline', Роботи: Array.from({length: 55}, (_,i) => ({ Робота: 'Робота '+i, Слюсар: 'Майстер', Ціна: 100, Кількість: 1 })), Деталі: [{ Деталь: 'Фільтр', Кількість: 4 }], Аванс: 500, 'Загальна сума': 7000 } }, writes: [], race: null };
  const supabase = { from(table) {
    assert.equal(table, 'acts'); let payload; const filters = [];
    const query = {
      select() {
        if (!payload) return query;
        if (db.race) { const race = db.race; db.race = null; race(); }
        const match = filters.every(([key,value]) => (key.startsWith('data->>') ? db.row.data[key.slice(7)] ?? null : db.row[key] ?? null) === value);
        if (!match) return Promise.resolve({ data: [], error: null });
        db.writes.push(copy(payload)); Object.assign(db.row, copy(payload)); return Promise.resolve({ data: [copy(db.row)], error: null });
      },
      eq(key, value) { filters.push([key,value]); return query; }, is(key,value) { filters.push([key,value]); return query; },
      update(value) { payload = value; return query; }, single: async () => ({ data: copy(db.row), error: null }),
    }; return query;
  }};
  const load = loader({ [path.join(root,'vxid/supabaseClient.ts')]: { supabase }, [path.join(root,'roboha/tablucya/users.ts')]: user }, { navigator: { onLine: online } });
  return { db, user, service: load('roboha/workshop/service'), safe: load('utils/actSafeWrite'), attention: load('roboha/workshop/attentionModel') };
}

test('legacy act has an empty auxiliary section without mutation', () => {
  const act = { Роботи: [{ Робота: 'A' }] }; assert.equal(model.readWorkshop(act).recommendations.length, 0); assert.equal(act.__workshop_v1, undefined);
});
test('unknown version and duplicate IDs rejected', () => {
  assert.throws(() => model.readWorkshop({ __workshop_v1: { version: 2, defects: [], recommendations: [] } }));
  assert.throws(() => model.readWorkshop({ __workshop_v1: { version: 1, defects: [], recommendations: [rec(), rec()] } }));
});
test('same-record stale edits rejected; unrelated entries survive', () => {
  const data = {}; const initial = rec(); model.replaceWorkshopEntry(data, 'recommendations', null, initial, equal);
  model.replaceWorkshopEntry(data, 'recommendations', null, rec('other'), equal);
  model.replaceWorkshopEntry(data, 'recommendations', initial, {...initial, state:'approved'}, equal);
  assert.equal(data.__workshop_v1.recommendations.length, 2);
  assert.throws(() => model.replaceWorkshopEntry(data, 'recommendations', initial, {...initial, state:'declined'}, equal));
});
test('duplicate recommendation for one defect rejected', () => {
  const data = {}; model.replaceWorkshopEntry(data, 'recommendations', null, {...rec(),sourceDefectId:'D'}, equal);
  assert.throws(() => model.replaceWorkshopEntry(data, 'recommendations', null, {...rec('other'),sourceDefectId:'D'}, equal));
});
test('unknown states and unsafe photo links rejected', () => {
  assert.throws(() => model.validateEntry('recommendations', {...rec(), state:'toString'}));
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://user:password@example.test/p', 'http://example.test']) assert.throws(() => model.safePhotoUrl(url));
  assert.equal(model.safePhotoUrl('https://example.test/photo'), 'https://example.test/photo');
});
test('defect save preserves 55 works, details, totals, deposit and unrelated JSON', async () => {
  const {db,service} = fixture(); const before = copy(db.row.data);
  await service.saveWorkshopEntry(1,'defects',null,defect());
  for (const key of Object.keys(before).filter(k => k !== '__act_revision')) assert.deepEqual(db.row.data[key],before[key]);
  assert.equal(db.row.data.__workshop_v1.defects.length,1); assert.deepEqual(Object.keys(db.writes[0]),['data']);
});
test('concurrent act write survives auxiliary save retry', async () => {
  const {db,service} = fixture(); db.race = () => { db.row.data.Роботи.push({Робота:'Нова'}); db.row.data.__act_revision='other'; };
  await service.saveWorkshopEntry(1,'recommendations',null,rec());
  assert.equal(db.row.data.Роботи.length,56); assert.equal(db.row.data.__workshop_v1.recommendations.length,1);
});
test('concurrent change to same recommendation is not silently overwritten', async () => {
  const {db,service} = fixture(); const original = rec(); db.row.data.__workshop_v1 = {version:1,defects:[],recommendations:[copy(original)]};
  db.race=()=> { db.row.data.__workshop_v1.recommendations[0].state='declined'; db.row.data.__act_revision='other'; };
  await assert.rejects(service.saveWorkshopEntry(1,'recommendations',original,{...original,state:'completed'}), /інший працівник/);
  assert.equal(db.row.data.__workshop_v1.recommendations[0].state,'declined');
});
test('subsequent ordinary snapshot preserves auxiliary records', async () => {
  const {db,service,safe}=fixture(); await service.saveWorkshopEntry(1,'defects',null,defect());
  const expected=copy(db.row.data); await safe.writeActSnapshot(1,expected,{...expected,Пробіг:12345});
  assert.equal(db.row.data.__workshop_v1.defects[0].component,'Циліндр 1');
});
for (const state of ['closed','frozen']) test(state + ' act: defect blocked, recommendation allowed without changing money', async()=>{
  const {db,service}=fixture(); if(state==='closed') db.row.date_off='2026-09-01'; else db.row.data.Заморожений=true;
  await assert.rejects(service.saveWorkshopEntry(1,'defects',null,defect()));
  const before=copy(db.row.data); await service.saveWorkshopEntry(1,'recommendations',null,rec());
  for(const key of Object.keys(before).filter(k=>k!=='__act_revision')) assert.deepEqual(db.row.data[key],before[key]);
});
test('roles: own receiver, assigned mechanic; no parts-specialist edits', async()=>{
  const {user,service,db}=fixture(); user.userAccessLevel='Приймальник'; user.userName='Інший';
  await assert.rejects(service.saveWorkshopEntry(1,'defects',null,defect()));
  user.userAccessLevel='Слюсар'; user.userName='Майстер'; await service.saveWorkshopEntry(1,'defects',null,defect());
  user.userName='Інший'; await assert.rejects(service.loadWorkshopAct(1));
  user.userAccessLevel='Запчастист'; await assert.rejects(service.saveWorkshopEntry(1,'recommendations',null,rec()));
  assert.equal(db.row.data.__workshop_v1.defects.length,1);
});
test('attention respects frozen/closed/roles/price visibility',()=>{
  const {db,attention}=fixture(); const scope={role:'Приймальник',name:'Майстер',prices:true};
  db.row.data.Роботи[0].Ціна=0; db.row.data.Роботи[0].Слюсар='';
  const result=attention.inspectActAttention(db.row,scope); assert.ok(result.some(i=>i.category==='Ціни')); assert.ok(result.some(i=>i.category==='Виконавці'));
  assert.equal(attention.inspectActAttention(db.row,{...scope,name:'Інший'}).length,0);
  assert.equal(attention.inspectActAttention(db.row,{role:'Слюсар',name:'Інший',prices:false}).length,0);
  assert.ok(!attention.inspectActAttention(db.row,{...scope,prices:false}).some(i=>i.category==='Ціни'));
  db.row.date_off='2026-09-01'; assert.equal(attention.inspectActAttention(db.row,scope).length,0);
  db.row.data.Заморожений=true; assert.equal(attention.inspectActAttention(db.row,scope).length,0);
});
test('attention includes only unfinished explicit recommendations on closed acts',()=>{
  const {db,attention}=fixture(); db.row.date_off='2026-09-01';
  db.row.data.__workshop_v1={version:1,defects:[],recommendations:[rec(),{...rec('done'),state:'completed'}]};
  const result=attention.inspectActAttention(db.row,{role:'Адміністратор',name:'Майстер',prices:true});
  assert.equal(result.length,1); assert.equal(result[0].text,'Незавершених рекомендацій: 1');
});
const goodInvoice=()=>({supplier:'Постачальник',number:'INV-01',date:'2026-09-26',currency:'UAH',total:'25.00',lines:[{catno:'00042',detail:'Фільтр',qty:'2,5',price:'10',unit:'штук',warning:''}]});
test('invoice preserves leading zeros and 75 repeated rows',()=>{
  const doc=goodInvoice(); doc.lines=Array.from({length:75},()=>copy(doc.lines[0]));
  const parsed=invoice.parseInvoiceResponse(JSON.stringify(doc));
  assert.equal(parsed.lines.length,75); assert.equal(parsed.lines[0].catno,'00042');
});
test('invoice rejects truncated response and oversize fields',()=>{
  for(const text of ['{"lines":[', 'some narrative', '{"error":"Не накладна"}', '{"lines":[]}']) assert.throws(()=>invoice.parseInvoiceResponse(text));
  const doc=goodInvoice();doc.lines[0].detail='a'.repeat(2001); assert.throws(()=>invoice.parseInvoiceResponse(JSON.stringify(doc)));
});
test('invoice validates numbers, currency, real date, supplier and number',()=>{
  invoice.validateInvoice(goodInvoice()); assert.equal(invoice.invoiceTotal(goodInvoice()),25);
  for(const value of ['', '1e3', '-1', 'Infinity','12грн','1,2,3']) {
    const doc=goodInvoice();doc.lines[0].qty=value; assert.throws(()=>invoice.validateInvoice(doc));
  }
  for(const [key,value] of [['currency','USD'],['date','2026-02-30'],['number',''],['supplier','']]) {
    const doc=goodInvoice();doc[key]=value; assert.throws(()=>invoice.validateInvoice(doc));
  }
  for(const [key,value] of [['catno',''],['price','0'],['price','-5'],['unit','невідомо']]) {
    const doc=goodInvoice();doc.lines[0][key]=value; assert.throws(()=>invoice.validateInvoice(doc));
  }
});

test('offline auxiliary save does not write or pretend it was saved', async()=>{
  const {db,service}=fixture(false);
  await assert.rejects(service.saveWorkshopEntry(1,'defects',null,defect()),/потрібен інтернет/);
  assert.equal(db.writes.length,0); assert.equal(db.row.data.__workshop_v1,undefined);
});

test('invoice origin check batches duplicates and rejects database errors', async()=>{
  let result={data:[],error:null}; let calls=0;
  const load=loader({[path.join(root,'vxid/supabaseClient.ts')]:{supabase:{rpc:async(name,args)=>{calls++; assert.equal(name,'traffic_invoice_origins');assert.deepEqual(Array.from(args.p_origins),['origin']);return result;}}}});
  const {assertInvoiceOriginsNotPresent}=load('roboha/workshop/invoicePersistence');
  await assertInvoiceOriginsNotPresent(['origin','origin']);assert.equal(calls,1);
  result={data:['origin'],error:null};await assert.rejects(assertInvoiceOriginsNotPresent(['origin']),/вже записано/);
  result={data:null,error:{code:'42501'}};await assert.rejects(assertInvoiceOriginsNotPresent(['origin']),/Запис зупинено/);
});

function extractFunction(relative,name,globals){
  const file=path.join(root,relative),source=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,99,true);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
  assert.ok(fn);const module={exports:{}};
  vm.runInNewContext(ts.transpileModule(fn.getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{module,exports:module.exports,...globals});
  return module.exports[name];
}

test('warehouse insert reports the exact new row ID even for identical catalogue rows',async()=>{
  let nextId=100,fail=false;const notifications=[];
  const save=extractFunction('roboha/dodatu_inchi_bazu/db_sclad.ts','handleScladCrud',{
    invalidateStockReads:()=>{},CRUD:'Додати',readScladFormValues:()=>({part_number:'0001'}),validateCatalogNumber:()=>true,validateScladPayload:()=>{},
    showToast:(text)=>notifications.push(text),logAction:async()=>{},
    supabase:{from:()=>({insert:()=>({select:async()=>fail?{data:null,error:{message:'fail'}}:{data:[{sclad_id:nextId++}],error:null}})})},
  });
  const ids=[];assert.equal(await save({skipAuditLog:true,onInserted:id=>ids.push(id)}),true);
  assert.equal(await save({skipAuditLog:true,onInserted:id=>ids.push(id)}),true);
  assert.deepEqual(ids,[100,101]);fail=true;
  await assert.rejects(save({skipAuditLog:true,onInserted:id=>ids.push(id)}),error=>error.message==='fail');assert.deepEqual(ids,[100,101]);
});

test('isolated Gemini OCR sends only the chosen document/prompt and rejects truncated output',async()=>{
  let reason='STOP',request;const text=JSON.stringify(goodInvoice());
  const recognize=extractFunction('roboha/ai/aiChat.ts','recognizeInvoiceDocument',{
    globalCache:{generalSettings:{aiEnabled:true}},loadAllGeminiKeys:async()=>['fake-test-key'],getKeyProvider:()=> 'gemini',
    currentKeyIndex:0,geminiKeySettingIds:[],getGeminiModelUrl:()=> 'https://example.invalid/mock',AbortController,
    window:{setTimeout,clearTimeout},FileReader:class{readAsDataURL(){this.result='data:image/png;base64,ZmFrZQ==';this.onload();}},
    fetch:async(url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({candidates:[{finishReason:reason,content:{parts:[{text}]}}]})};},
  });
  assert.equal(await recognize({type:'image/png',size:4},invoice.invoicePrompt),text);
  assert.deepEqual(Object.keys(request).sort(),['contents','generationConfig']);assert.equal(request.contents.length,1);
  assert.equal(request.contents[0].parts[1].inlineData.data,'ZmFrZQ==');
  reason='MAX_TOKENS';await assert.rejects(recognize({type:'image/png',size:4},'test'),/неповне/);
  await assert.rejects(recognize({type:'image/png',size:11*1024*1024},'test'),/10 МБ/);
});
test('workshop modules use no browser persistence and only named read RPCs',()=>{
  for(const file of fs.readdirSync(path.join(root,'roboha/workshop')).filter(f=>f.endsWith('.ts'))) {
    const source=fs.readFileSync(path.join(root,'roboha/workshop',file),'utf8');
    // Auth context is read solely to partition in-memory caches. Domain data must
    // never be persisted in browser storage, even after adding aggregate readers.
    assert.doesNotMatch(source,/sessionStorage|indexedDB|localStorage\s*\.\s*(?:setItem|removeItem|clear)/,file);
    for(const match of source.matchAll(/localStorage\??\.getItem\(([^)]+)\)/g)) assert.match(match[1], /^(['"])userAuthData\1$/,file);
    for(const match of source.matchAll(/\.rpc\("([^"]+)"/g)) assert.ok(["sto_previous_recommendations_v1","sto_act_attention_page_v1","traffic_invoice_origins","traffic_attention_overview"].includes(match[1]),file);
  }
});
test('OCR is isolated from chat tools/history and checks truncation',()=>{
  const file=path.join(root,'roboha/ai/aiChat.ts'), source=fs.readFileSync(file,'utf8');
  const ast=ts.createSourceFile(file,source,99,true);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='recognizeInvoiceDocument');
  assert.ok(fn); const code=fn.getText(ast);
  assert.doesNotMatch(code,/callGemini\(|WithFunctionCalling|chatHistory|fcTools|buildSkillPrompt|gatherSTOContext/);
  assert.match(code,/finishReason !== "STOP"/); assert.match(code,/file\.size/);
});
test('warehouse escapes document-sourced text before HTML insertion',()=>{
  const file=path.join(root,'roboha/dodatu_inchi_bazu/inhi/batchImportSclad.ts');
  const source=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,99,true);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='escapeBatchValue').getText(ast);
  const ctx={};vm.createContext(ctx);vm.runInContext(ts.transpileModule(fn,{compilerOptions:{target:99}}).outputText,ctx);
  assert.equal(ctx.escapeBatchValue('</textarea><img src=x onerror="evil()">'),'&lt;/textarea&gt;&lt;img src=x onerror=&quot;evil()&quot;&gt;');
  assert.match(source,/escapeBatchValue\(row.detail\)/);
});

test('workflow dialogs center, lock only an open background, and act launcher stays removed',()=>{
  const css=require('sass').compile(path.resolve('src/scss/robocha/_workflows.scss')).css;
  assert.match(css,/html:has\(\.workflow-dialog\[open\]\),\s*body:has\(\.workflow-dialog\[open\]\)\s*\{\s*overflow: hidden !important;/);
  const rule=css.match(/\.workflow-dialog\s*\{([^}]+)\}/)[1];
  for(const expected of ['position: fixed','inset: 0','margin: auto','overflow: auto','overscroll-behavior: contain']) assert.ok(rule.includes(expected),expected);
  const modal=fs.readFileSync(path.join(root,'roboha/zakaz_naraudy/modalMain.ts'),'utf8');
  assert.doesNotMatch(modal,/workshop-launch|canUserAddRowToAct/);
  const serviceBook=fs.readFileSync(path.join(root,'roboha/service_book/serviceBook.ts'),'utf8');
  assert.match(serviceBook,/openWorkshop/);
});

test('attention action follows dashboard once, retaining its handler without switching chat tabs',()=>{
  const source=fs.readFileSync(path.join(root,'roboha/ai/aiChat.ts'),'utf8');
  assert.equal((source.match(/id="ai-attention-btn"/g)||[]).length,1);
  assert.match(source, /id="tab-dashboard"[^>]*>📊 Дашборд<\/button>\s*<button id="ai-attention-btn"[^>]*>❗ Увага<\/button>/);
  const markup=source.match(/<button id="ai-attention-btn"[^>]*>/)[0];
  assert.match(markup,/title="Що потребує уваги"/);assert.doesNotMatch(markup,/data-tab=/);
  assert.match(source,/await openAttentionOverview\(\)/);
  const css=require('sass').compile(path.resolve('src/scss/robocha/ai/_ai.scss')).css;
  assert.match(css,/\.ai-chat-tabs\s*\{[^}]*flex-wrap: nowrap/);
  assert.match(css,/\.ai-chat-tab\s*\{[^}]*white-space: nowrap/);
});
