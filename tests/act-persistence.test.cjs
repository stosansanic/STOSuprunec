// Run: node --test tests/act-persistence.test.cjs. No network or production DB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { randomUUID, createHash } = require('node:crypto');
const checksum = value => createHash('md5').update(JSON.stringify(value)).digest('hex');
const root = 'src/ts/';
const savePath = root + 'roboha/zakaz_naraudy/inhi/zberechennya_zmin_y_danux_aktu.ts';
const offlinePath = root + 'roboha/offline/offlineSync.ts';
const copy = value => structuredClone(value);
function extract(file, names) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), 99, true);
  return ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text))
    .map(n => n.getText(ast).replace(/^export /, '')).join('\n');
}
function run(source, context) {
  context.prepareEditorRowReferences ??= async () => {};
  context.actEditorSignature ??= () => "unchanged";
  context.actSaveInputSignature ??= context.actEditorSignature;
  // These extracted-function fixtures exercise the full writer. The real
  // unchanged-save helpers are covered in legacy-act-close.test.cjs.
  context.unchangedActSaveBaseline ??= null;
  context.rememberUnchangedActBaseline ??= () => {};
  context.canReuseUnchangedActBaseline ??= () => false;
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
  return context;
}
function fixture(data, date_off = null) {
  const db = { row: { act_id: 1, data: copy(data), date_off }, writes: [], events: [], beforeWrite: null, used: new Map(), failStock: false, stockCalls: 0 };
  const quantities = value => {
    const body = typeof value === 'string' ? JSON.parse(value) : value;
    const totals = new Map();
    for (const row of body?.Деталі || []) if (row.sclad_id) {
      const id = Number(row.sclad_id);
      totals.set(id, (totals.get(id) || 0) + Number(row.Кількість || 0));
    }
    return totals;
  };
  try { db.used = quantities(data); } catch { /* Malformed act fixtures test rejection. */ }
  const supabase = { async rpc(name, args) {
    assert.ok(['write_act_with_stock','guarded_write_act_with_stock_receipt','guarded_finish_act_payroll','guarded_write_act_json'].includes(name));
    if(name.startsWith('guarded_')) assert.equal(args.p_lock_owner,'test');
    if(name==='guarded_finish_act_payroll') {
      if(checksum(db.row.data)!==args.p_checksum || db.row.data.__act_revision!==args.p_revision) return {error:{code:'40001',message:'conflict'}};
      db.row.data={...db.row.data,__payroll_pending:false,__act_revision:args.p_next_revision};
      db.writes.push({payload:{data:copy(db.row.data)},guardedJson:true});
      return {data:{act_id:1,status:'updated',revision:args.p_next_revision,checksum:checksum(db.row.data)}};
    }
    if(name==='guarded_write_act_json') {
      const current = typeof db.row.data === 'string' ? JSON.parse(db.row.data) : db.row.data;
      if(JSON.stringify(current)!==JSON.stringify(args.p_expected)) return {error:{code:'40001',message:'conflict'}};
      db.row.data=copy(args.p_next);
      db.writes.push({payload:{data:copy(args.p_next)},guardedJson:true});
      return {data:copy(db.row)};
    }
    db.stockCalls++;
    const current = typeof db.row.data === 'string' ? JSON.parse(db.row.data) : db.row.data;
    if (JSON.stringify(current) !== JSON.stringify(args.p_expected)) return { error: new Error('Акт змінився') };
    if (db.row.date_off || current.Заморожений) return { error: new Error('Акт закритий або заморожений') };
    if (db.failStock) return { error: new Error('stock transaction failed') };
    const oldQty = quantities(current), newQty = quantities(args.p_next);
    for (const id of new Set([...oldQty.keys(), ...newQty.keys()])) {
      db.used.set(id, (db.used.get(id) || 0) + (newQty.get(id) || 0) - (oldQty.get(id) || 0));
    }
    db.row.data = copy(args.p_next);
    if (args.p_avans != null) db.row.avans = args.p_avans;
    db.writes.push({ payload: { data: copy(args.p_next) }, atomicStock: true });
    return { data: name==='guarded_write_act_with_stock_receipt' ? {act_id:1,status:'updated',revision:args.p_next.__act_revision,checksum:checksum(args.p_next)} : copy(args.p_next), error: null };
  }, from(table) {
    assert.equal(table, 'acts');
    const filters = [];
    let payload;
    const query = {
      eq(key, val) { filters.push([key, val]); return query; },
      is(key, val) { filters.push([key, val]); return query; },
      update(val) { payload = val; return query; },
      async single() { return { data: copy(db.row), error: null }; },
      select() {
        if (!payload) return query;
        if (db.beforeWrite) { const callback = db.beforeWrite; db.beforeWrite = null; callback(); }
        db.writes.push({ payload: copy(payload), filters: copy(filters) });
        const matches = filters.every(([key, val]) => {
          const actual = key.startsWith('data->>')
            ? (typeof db.row.data === 'object' ? db.row.data?.[key.slice(7)] : null)
            : db.row[key];
          return (actual ?? null) === val;
        });
        if (!matches) return Promise.resolve({ data: [], error: null });
        Object.assign(db.row, copy(payload));
        return Promise.resolve({ data: [copy(db.row)], error: null });
      },
    };
    return query;
  }};
  const ctx = run(fs.readFileSync(root + 'utils/actSafeWrite.ts', 'utf8'), {
    exports: {}, require: () => ({ supabase }), crypto: { randomUUID }, structuredClone,
    window: { dispatchEvent: event => db.events.push(event) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  });
  return { db, api: ctx.exports, supabase };
}
const initial = () => ({ Роботи: [{ Робота: 'Work', recordId: 'w1' }], Деталі: [] });

test('backgrounding an act never saves or closes the draft', async () => {
  const file = root + 'roboha/zakaz_naraudy/actPresence.ts';
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), 99, true);
  const listener = ast.statements.find(node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(ast) === 'document.addEventListener' &&
    node.expression.arguments[0]?.text === 'visibilitychange');
  assert.ok(listener);
  let onVisibility, saves = 0, closes = 0, locks = 0;
  const document = {
    visibilityState: 'hidden',
    addEventListener: (_, handler) => { onVisibility = handler; },
    getElementById: () => ({ disabled: false, click: () => { saves++; } }),
  };
  run(listener.getText(ast), {
    document, currentActId: 1, currentUserName: 'User',
    setTimeout: () => assert.fail('Backgrounding must not schedule a save or close'),
    closeZakazNaraydModal: async () => { closes++; },
    rpcAcquire: async () => { locks++; return { acquired: true }; },
    unlockActInterface() {}, startOwnerHeartbeat() {},
  });
  await onVisibility();
  assert.equal(saves, 0);
  assert.equal(closes, 0);
  assert.equal(locks, 0);
  document.visibilityState = 'visible';
  await onVisibility();
  assert.equal(locks, 1);
  assert.equal(saves, 0);
});

test('leaving an edited act discards the draft without a persistence call', async () => {
  class Input {}
  const field = Object.assign(new Input(), { id: 'notes', value: 'saved', getAttribute: () => 'notes' });
  const body = { isConnected: true, querySelectorAll: () => [field] };
  let prompts = 0, hidden = false, released = false;
  const guard = run(fs.readFileSync(root + 'utils/actEditorGuard.ts', 'utf8'), {
    exports: {}, require: () => ({ confirmDiscardChanges: async () => { prompts++; return true; } }),
    window: { addEventListener() {} }, HTMLInputElement: Input,
    HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
  }).exports;
  guard.trackActEditor(1, body);
  field.value = 'unsaved draft';
  assert.equal(guard.hasUnsavedActChanges(), true);
  const ctx = run(extract(root + 'roboha/zakaz_naraudy/modalUI.ts', ['closeZakazNaraydModal']), {
    ...guard, ZAKAZ_NARAYD_MODAL_ID: 'modal', globalCache: { currentActId: 1 },
    document: { getElementById: () => ({ classList: { add: () => { hidden = true; } } }) },
    cleanupAllSnakeBorders() {}, localStorage: { removeItem() {} },
    cleanupSlusarsOnSubscription() {}, releaseEditorStockSubscription() {}, resetDiscountCache() {},
    unsubscribeFromActPresence: async () => { released = true; },
  });
  await ctx.closeZakazNaraydModal();
  assert.equal(prompts, 1);
  assert.equal(hidden, true);
  assert.equal(released, true);
  assert.equal(guard.hasUnsavedActChanges(), false);
});

test('opening an act does not save; clicking Save explicitly persists it', async () => {
  let onSave, writes = 0;
  const button = { addEventListener: (_, callback) => { onSave = callback; } };
  const body = { querySelector: () => ({querySelectorAll: () => []}), querySelectorAll: () => [], dataset: {} };
  const ctx = run(extract(savePath, ['addSaveHandler']), {
    structuredClone, saveContextByActId: new Map(), countNamedActRows: () => 1,
    document: { getElementById: id => id === 'body' ? body : {
      cloneNode: () => button, parentNode: { replaceChild() {} },
    } },
    ZAKAZ_NARAYD_BODY_ID: 'body', ZAKAZ_NARAYD_SAVE_BTN_ID: 'save', ACT_ITEMS_TABLE_CONTAINER_ID: 'table',
    parseTableRows: () => [{}], trackActEditor() {}, isSaving: false,
    saveCurrentAct: async id => { assert.equal(id, 1); writes++; },
    notifyActSaved: async () => {}, showNotification() {},
  });
  ctx.addSaveHandler(1, initial());
  assert.equal(writes, 0);
  await onSave();
  assert.equal(writes, 1);
});

// Read the actual defaults from the creation flow, not an invented empty array.
function newActDefaults() {
  const file = root + 'roboha/redahyvatu_klient_machuna/pidtverdutu_sberihannya_zakaz_naryad.ts';
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), 99, true);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'actData') initializer = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return vm.runInNewContext(`(${initializer})`, { reason: '' });
}
test('new act placeholder rows do not block the first save handler', () => {
  const body = { querySelector: () => ({querySelectorAll: () => []}), querySelectorAll: () => [], dataset: {} };
  const { api } = fixture({});
  const ctx = run(extract(savePath, ['addSaveHandler']), {
    ...api, structuredClone, saveContextByActId: new Map(),
    document: { getElementById: id => id === 'body' ? body : null },
    ZAKAZ_NARAYD_BODY_ID: 'body', ZAKAZ_NARAYD_SAVE_BTN_ID: 'save', ACT_ITEMS_TABLE_CONTAINER_ID: 'table',
    parseTableRows: () => [], trackActEditor() {},
  });
  ctx.addSaveHandler(1, newActDefaults());
  assert.equal(body.dataset.saveReadyAct, '1');
});
test('new act: first work/detail, repeated save, 40 more rows, deletion, and reopen baseline', async () => {
  const original = newActDefaults();
  const { api, db, supabase } = fixture(original);
  const body = { querySelector: () => ({querySelectorAll: () => []}), querySelectorAll: () => [], dataset: {}, inert: false };
  const contexts = new Map();
  let items = [];
  const row = (type, name) => ({ type, name, quantity: 1, price: 10, sum: 10, pibMagazin: '', catalog: '123', sclad_id: null, slyusar_id: null, slyusarSum: 0, recordId: name });
  const noop = () => {};
  const asyncNoop = async () => {};
  const ctx = run(extract(savePath, [
    'addSaveHandler', 'saveCurrentAct', 'saveActData', 'processItems',
    'buildShopRowsFromDetails', 'buildSlyusarRowsFromWorks', 'recalculateMergedTotals', 'assertRowsPersisted',
  ]), {
    ...run(extract(root + 'utils/payrollSafeWrite.ts', ['floorPayrollSalary']), {}),
    ...api, supabase, structuredClone, saveContextByActId: contexts,
    isSaving: false, isActWritePending: () => false, setActWritePending: noop,
    globalCache: { isActClosed: false, worksWithId: [], detailsWithId: [] },
    document: { getElementById: id => id === 'body' ? body : id === 'save' ? null : { value: '0', innerText: '', textContent: '0' }, querySelectorAll: () => [] },
    ZAKAZ_NARAYD_BODY_ID: 'body', ZAKAZ_NARAYD_SAVE_BTN_ID: 'save', ACT_ITEMS_TABLE_CONTAINER_ID: 'table',
    EDITABLE_PROBIG_ID: 'p', EDITABLE_REASON_ID: 'r', EDITABLE_RECOMMENDATIONS_ID: 'c', EDITABLE_NOTES_ID: 'n',
    parseTableRows: () => items, trackActEditor: noop, actEditorSignature: () => JSON.stringify(items), markActEditorSaved: noop,
    loadPurchasePrices: asyncNoop, safeParseJSON: api.readActJson, isActFrozen: () => false,
    cacheHiddenColumnsData: noop, cleanText: x => x || '', getPurchasePrice: () => 0,
    userAccessLevel: 'Адміністратор', userName: 'test',
    navigator: { onLine: true }, window: { confirm: () => assert.fail('new act must not ask to delete template rows') },
    showNotification: noop, savePruimalnykToActs: asyncNoop, updateScladActNumbers: asyncNoop,
    syncShopsOnActSave: asyncNoop, syncSlyusarsOnActSave: asyncNoop, syncPruimalnikHistory: asyncNoop,
    readTableNewNumbers: () => new Map(), invalidateGlobalDataCache: noop, loadGlobalData: asyncNoop,
    cleanupEmptyRows: asyncNoop, refreshQtyWarningsIn: asyncNoop, updateCalculatedSumsInFooter: noop, refreshActRowInTable: asyncNoop,
  });
  ctx.addSaveHandler(1, original);
  // Confirm an untouched new act can also be saved without a false deletion prompt.
  await ctx.saveCurrentAct(1);
  items = [row('work', 'first work'), row('detail', 'first detail')];
  await ctx.saveCurrentAct(1);
  assert.equal(db.row.data.Роботи.length, 1);
  assert.equal(db.row.data.Деталі.length, 1);
  await ctx.saveCurrentAct(1);
  items.push(...Array.from({ length: 40 }, (_, i) => row('work', `extra ${i}`)));
  await ctx.saveCurrentAct(1);
  assert.equal(db.row.data.Роботи.length, 41);
  items = items.filter(item => item.name !== 'first detail');
  await ctx.saveCurrentAct(1);
  assert.equal(db.row.data.Деталі.length, 0);
  assert.equal(db.row.data.Роботи.length, 41);
  ctx.addSaveHandler(1, db.row.data);
  await ctx.saveCurrentAct(1);
  assert.equal(db.row.data.Роботи.length, 41);
  assert.equal(body.inert, false);
  ctx.syncPruimalnikHistory = async () => { throw new Error('payroll network failure'); };
  items.push(row('work', 'kept despite payroll failure'));
  await assert.rejects(ctx.saveCurrentAct(1), /Позиції акта збережено/);
  assert.equal(db.row.data.__payroll_pending, true);
  assert.equal(db.row.data.Роботи.length, 42);
  assert.equal(body.inert, false);
  ctx.syncPruimalnikHistory = asyncNoop;
  ctx.addSaveHandler(1, db.row.data); // retry after reopening also works
  await ctx.saveCurrentAct(1);
  assert.equal(db.row.data.__payroll_pending, false);
  assert.equal(db.row.data.Роботи.length, 42);

  // Exercise the actual editor save orchestration, including retries and failure.
  const part = { ...row('detail', 'Болт'), quantity: 12, sclad_id: 10 };
  items.push(part);
  await ctx.saveCurrentAct(1);
  assert.equal(db.used.get(10), 12);
  part.quantity = 6;
  await ctx.saveCurrentAct(1);
  assert.equal(db.used.get(10), 6);
  assert.equal(12 - db.used.get(10), 6);
  await ctx.saveCurrentAct(1);
  assert.equal(db.used.get(10), 6, 'repeated save must not return six again');
  part.quantity = 9;
  db.failStock = true;
  await assert.rejects(ctx.saveCurrentAct(1), /stock transaction failed/);
  assert.equal(db.used.get(10), 6);
  assert.equal(db.row.data.Деталі[0].Кількість, 6);
  db.failStock = false;
  await ctx.saveCurrentAct(1);
  assert.equal(db.used.get(10), 9);
  db.used.set(10, 11); // Two more units belong to another act.
  items = items.filter(item => item !== part);
  await ctx.saveCurrentAct(1);
  assert.equal(db.used.get(10), 2, 'deleting this act part retains other act consumption');
});

test('partially rendered real rows still block saving even when placeholders exist', () => {
  const { api } = fixture({});
  const body = { querySelector: () => ({querySelectorAll: () => []}), querySelectorAll: () => [], dataset: {} };
  const ctx = run(extract(savePath, ['addSaveHandler']), {
    ...api, structuredClone, saveContextByActId: new Map(),
    document: { getElementById: id => id === 'body' ? body : null },
    ZAKAZ_NARAYD_BODY_ID: 'body', ZAKAZ_NARAYD_SAVE_BTN_ID: 'save', ACT_ITEMS_TABLE_CONTAINER_ID: 'table',
    parseTableRows: () => [], trackActEditor() {},
  });
  const data = newActDefaults(); data.Роботи.push({ Робота: 'Real work' });
  ctx.addSaveHandler(1, data);
  assert.equal(body.dataset.saveReadyAct, undefined);
});

test('manifest caches successful downloads and uses them after DNS failure or HTTP 503', async () => {
  let cached;
  let mode = 'online';
  const ctx = run(extract('public/sw.js', ['networkFirstManifest']), {
    CACHE_NAME: 'test', Response,
    caches: { open: async () => ({
      put: async (_request, response) => { cached = response; },
      match: async () => cached?.clone(),
    }) },
    fetch: async () => {
      if (mode === 'dns') throw new Error('ERR_NAME_NOT_RESOLVED');
      if (mode === '503') return new Response('unavailable', { status: 503 });
      return new Response('{"name":"STO"}', { headers: { 'Content-Type': 'application/manifest+json' } });
    },
  });
  for (const next of ['online', 'dns', '503']) {
    mode = next;
    const response = await ctx.networkFirstManifest('/manifest.json');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { name: 'STO' });
  }
  cached = undefined;
  assert.equal((await ctx.networkFirstManifest('/manifest.json')).status, 503);
});

test('failed database read leaves editor unlocked and never reports a successful write', async () => {
  const original = newActDefaults();
  const { api } = fixture(original);
  const body = { querySelector: () => ({querySelectorAll: () => []}), querySelectorAll: () => [], dataset: { saveReadyAct: '1' }, inert: false };
  const query = { select() { return query; }, eq() { return query; }, async single() { return { data: null, error: { message: 'Failed to fetch' } }; } };
  let pending = false;
  const ctx = run(extract(savePath, ['saveActData']), {
    ...api, supabase: { from: () => query }, isSaving: false, isActWritePending: () => false,
    globalCache: { isActClosed: false }, document: { getElementById: () => body },
    ZAKAZ_NARAYD_BODY_ID: 'body', ACT_ITEMS_TABLE_CONTAINER_ID: 'table',
    setActWritePending: value => { pending = value; }, loadPurchasePrices: async () => {},
  });
  await assert.rejects(ctx.saveActData(1, original), /Введені дані залишаються/);
  assert.equal(body.inert, false);
  assert.equal(pending, false);
  assert.equal(body.dataset.saveReadyAct, '1');
});

test('large/old acts save and can save again; filters never contain the full JSON', async () => {
  for (const count of [0, 20, 40, 1000]) {
    const data = { ...initial(), Роботи: Array.from({ length: count }, (_, i) => ({ Робота: `Work ${i}`, recordId: `w${i}` })), opened: '1926-01-01' };
    const { api, db } = fixture(data);
    const first = await api.writeActSnapshot(1, data, data);
    const next = copy(first.data);
    next.Роботи.push({ Робота: 'New', recordId: 'new' });
    await api.writeActSnapshot(1, first.data, next);
    assert.equal(db.row.data.Роботи.length, count + 1);
    assert.ok(JSON.stringify(db.writes[1].filters).length < 200);
  }
});
test('two concurrent saves: only one can replace the same snapshot', async () => {
  for (const legacy of [false, true]) {
    const data = initial();
    const { api, db } = fixture(legacy ? JSON.stringify(data) : data);
    const outcomes = await Promise.allSettled([
      api.writeActSnapshot(1, data, { ...data, Деталі: [{ Деталь: 'A' }] }),
      api.writeActSnapshot(1, data, { ...data, Деталі: [{ Деталь: 'B' }] }),
    ]);
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1);
    assert.equal(db.row.data.Роботи.length, 1);
  }
});
test('stale snapshot cannot remove a new work', async () => {
  const old = initial();
  const fresh = copy(old); fresh.Роботи.push({ Робота: 'New' });
  const { api, db } = fixture(fresh);
  await assert.rejects(api.writeActSnapshot(1, old, old), /Акт змінився/);
  assert.equal(db.writes.length, 0);
});
test('phone field retries a collision and preserves new rows on a closed act', async () => {
  const { api, db } = fixture(initial(), '2026-09-20');
  db.beforeWrite = () => { db.row.data.Роботи.push({ Робота: 'New' }); db.row.data.__act_revision = 'concurrent'; };
  await api.patchActData(1, data => { data.Дзвінок = 'yes'; }, { allowClosed: true, allowFrozen: true });
  assert.equal(db.row.data.Роботи.length, 2);
  assert.equal(db.row.data.Дзвінок, 'yes');
});
test('normal save rejects closed/frozen acts and malformed JSON', async () => {
  for (const [data, closed] of [[initial(), '2026-09-20'], [{ ...initial(), Заморожений: true }, null], ['{broken', null]]) {
    const { api, db } = fixture(data, closed);
    await assert.rejects(api.writeActSnapshot(1, data, initial()));
    assert.equal(db.writes.length, 0);
  }
});
test('unfreeze retains all rows with guarded state change', async () => {
  const data = { ...initial(), Заморожений: true };
  const { api, db } = fixture(data);
  await api.writeActSnapshot(1, data, { ...data, Заморожений: false }, { allowFrozen: true });
  assert.equal(db.row.data.Заморожений, false);
  assert.equal(db.row.data.Роботи.length, 1);
});
test('closing between read and PATCH prevents the write', async () => {
  const data = initial(); const { api, db } = fixture(data);
  db.beforeWrite = () => { db.row.date_off = '2026-09-20'; };
  await assert.rejects(api.writeActSnapshot(1, data, { ...data, Роботи: [] }), /Акт змінився/);
  assert.equal(db.row.data.Роботи.length, 1);
});
test('offline old or conflicting snapshots never overwrite acts', async () => {
  const old = initial(); const fresh = copy(old); fresh.Роботи.push({ Робота: 'New' });
  const { api, db } = fixture(fresh);
  const ctx = run(extract(offlinePath, ['processSingleItem']), { ...api, assertOfflineScope() {}, OfflineOwnerChanged: class extends Error {} });
  await assert.rejects(ctx.processSingleItem({ owner: 'fixture-owner', operation: 'update_act', recordId: 1, payload: { data: old } }), /Стара офлайн/);
  await assert.rejects(ctx.processSingleItem({ owner: 'fixture-owner', operation: 'update_act', recordId: 1, payload: { data: old, expectedData: old } }), /Акт змінився/);
  assert.equal(db.writes.length, 0);
});
test('offline confirmed duplicate response is idempotent; new valid change saves', async () => {
  const old = initial(); const { api, db } = fixture(old);
  const ctx = run(extract(offlinePath, ['processSingleItem']), { ...api, assertOfflineScope() {}, OfflineOwnerChanged: class extends Error {} });
  const payload = { data: { ...old, Примітки: 'new' }, expectedData: old, avans: 0 };
  await ctx.processSingleItem({ owner: 'fixture-owner', operation: 'update_act', recordId: 1, payload });
  await ctx.processSingleItem({ owner: 'fixture-owner', operation: 'update_act', recordId: 1, payload });
  assert.equal(db.writes.length, 1);
});
test('offline quantity change returns six exactly once through the stock writer', async () => {
  const old = { Деталі: [{ Деталь: 'Болт', sclad_id: 10, Кількість: 12 }] };
  const { api, db } = fixture(old);
  const ctx = run(extract(offlinePath, ['processSingleItem']), { ...api, assertOfflineScope() {}, OfflineOwnerChanged: class extends Error {} });
  const next = { Деталі: [{ Деталь: 'Болт', sclad_id: 10, Кількість: 6 }] };
  const item = { owner: 'fixture-owner', operation: 'update_act', recordId: 1, payload: { data: next, expectedData: old, avans: 50 } };
  await ctx.processSingleItem(item);
  await ctx.processSingleItem(item);
  assert.equal(db.used.get(10), 6);
  assert.equal(db.row.avans, 50);
  assert.equal(db.stockCalls, 1);
});
test('offline conflicts are retained, not discarded at retry limit', async () => {
  const { api } = fixture(initial());
  const entries = [];
  const ctx = run(extract(offlinePath, ['processQueue']), {
    ...api, isSyncing: false, navigator: { onLine: true }, MAX_RETRIES: 5,
    offlineScope: () => 'fixture-scope', assertOfflineScope() {}, OfflineOwnerChanged: class extends Error {},
    getSyncQueue: async () => [{ id: 7, recordId: 1, retries: 5 }],
    processSingleItem: async () => { throw new api.ActWriteConflict(); },
    removeSyncQueueItem: async () => assert.fail('must not delete recovery data'),
    addToSyncQueue: async item => entries.push(item), showNotification() {}, notifyStatusListeners() {},
  });
  await ctx.processQueue();
  assert.equal(entries[0].id, 7);
  assert.ok(entries[0].blockedReason);
});
test('save rejects missing or wrong-act DOM before doing any database work', async () => {
  for (const body of [null, { querySelector: () => null }, { querySelector: () => ({}), dataset: { saveReadyAct: '2' } }]) {
    const ctx = run(extract(savePath, ['saveActData']), {
      isSaving: false, isActWritePending: () => false, globalCache: { isActClosed: false },
      document: { getElementById: () => body }, ZAKAZ_NARAYD_BODY_ID: 'body', ACT_ITEMS_TABLE_CONTAINER_ID: 'table',
    });
    await assert.rejects(ctx.saveActData(1, initial()), /не завантажена/);
  }
});
test('DOM save rejects stale arrays, and canceled empty-act save never writes', async () => {
  for (const stale of [true, false]) {
    const old = initial(); const fresh = copy(old);
    if (stale) fresh.Роботи.push({ Робота: 'New' });
    const { api, supabase, db } = fixture(fresh);
    const body = { querySelector: () => ({querySelectorAll: () => []}), querySelectorAll: () => [], dataset: { saveReadyAct: '1' }, inert: false };
    const ctx = run(extract(savePath, ['saveActData']), {
      ...api, supabase, isSaving: false, isActWritePending: () => false, globalCache: { isActClosed: false },
      document: { getElementById: id => id === 'body' ? body : { innerText: '', textContent: '' } },
      ZAKAZ_NARAYD_BODY_ID: 'body', ACT_ITEMS_TABLE_CONTAINER_ID: 'table',
      EDITABLE_PROBIG_ID: 'p', EDITABLE_REASON_ID: 'r', EDITABLE_RECOMMENDATIONS_ID: 'c', EDITABLE_NOTES_ID: 'n',
      setActWritePending() {}, loadPurchasePrices: async () => {}, safeParseJSON: api.readActJson,
      isActFrozen: () => false, cacheHiddenColumnsData() {}, cleanText: x => x || '',
      parseTableRows: () => [], window: { confirm: () => false },
    });
    await assert.rejects(ctx.saveActData(1, old), stale ? /Акт змінився/ : /порожнього акту скасовано/);
    assert.equal(db.writes.length, 0);
    assert.equal(body.inert, false);
  }
});

test('safe writes invalidate both known cars without an extra metadata read', async () => {
 const data = initial();const {api,db}=fixture(data);db.row.cars_id=7;
 db.beforeWrite=()=>{db.row.cars_id=8};
 await api.writeActSnapshot(1,data,data);
 assert.equal(db.events[0].type,'sto:act-saved');
 assert.deepEqual(Array.from(db.events[0].detail.affectedCarIds),[7,8]);
 const unknown=fixture(data);await unknown.api.writeActSnapshot(1,data,data);
 assert.equal(unknown.db.events[0].detail.affectedCarIds,undefined);
});
