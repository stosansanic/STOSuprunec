// Local regression fixtures only: no production database, credentials or network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const saveFile = 'src/ts/roboha/zakaz_naraudy/inhi/zberechennya_zmin_y_danux_aktu.ts';
const clone = structuredClone;
function functions(file, names) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), 99, true);
  const found = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.deepEqual(found.map(node => node.name.text).sort(), [...names].sort(), 'execute actual production helpers');
  return found.map(node => node.getText(source).replace(/^export /, '')).join('\n');
}

function fixture({ stockId = 9001, pending, register = true } = {}) {
  const part = { Деталь: 'Історична деталь', Каталог: 'OLD-001', Магазин: 'Старий магазин',
    Кількість: 2, Ціна: 150, Сума: 300, recordId: 'legacy-part', ...(stockId == null ? {} : { sclad_id: stockId }) };
  const work = { Робота: 'Ремонт', Слюсар: 'Майстер', slyusar_id: 17, Каталог: '42', Кількість: 1,
    Ціна: 200, Сума: 200, Зарплата: 100, recordId: 'legacy-work', Розраховано: '01.06.2026' };
  const saved = { Деталі: [part], Роботи: [work], Пробіг: 12345, 'Причина звернення': 'Огляд',
    Рекомендації: '', Примітки: '', Аванс: 0, Знижка: 0, 'За деталі': 300, 'За роботу': 200,
    'Загальна сума': 500, 'Прибуток за деталі': 75, 'Прибуток за роботу': 100,
    __act_revision: 'historical-revision', legacyMetadata: { preserved: true },
    ...(pending === undefined ? {} : { __payroll_pending: pending }) };
  const state = {
    actor: 'actor-a', fresh: { act_id: 6, data: clone(saved), date_on: '2026-05-26T06:40:00Z',
      date_off: null, pruimalnyk: 'Приймальник', checksum: 'checksum', avans: 0 },
    items: [{ type: 'detail', name: part.Деталь, catalog: part.Каталог, quantity: 2, price: 150, sum: 300,
      pibMagazin: part.Магазин, sclad_id: stockId, slyusar_id: null, slyusarSum: 0, recordId: part.recordId },
    { type: 'work', name: work.Робота, catalog: '42', quantity: 1, price: 200, sum: 200,
      pibMagazin: work.Слюсар, sclad_id: null, slyusar_id: 17, slyusarSum: 100, recordId: work.recordId }],
    stock: [], stockError: null, readError: null, beforeRead: null, afterRead: null,
    reads: 0, stockReads: [], writes: 0, payrollWrites: 0, references: 0, processing: 0,
    snapshots: [], notices: [], markings: [], pending: false,
  };
  const fields = new Map(Object.entries({
    mileage: { textContent: '12345', innerText: '12345' },
    reason: { textContent: 'Огляд', innerText: 'Огляд' },
    recommendations: { textContent: '', innerText: '' }, notes: { textContent: '', innerText: '' },
    'editable-avans': { value: '0' }, 'editable-discount': { value: '0' },
  }));
  const table = { querySelectorAll: () => state.items.filter(row => row.sclad_id != null)
    .map(row => ({ dataset: { scladId: String(row.sclad_id) } })) };
  const body = { dataset: {}, inert: false, isConnected: true,
    querySelector: () => table, querySelectorAll: () => [] };
  class ActWriteConflict extends Error { constructor() { super('Акт змінився в іншого користувача'); } }
  const context = {
    exports: {}, structuredClone: clone, Error, Map, Set, ActWriteConflict,
    saveContextByActId: new Map(), unchangedActSaveBaseline: null, purchasePricesCache: new Map(),
    isSaving: false, userName: 'Адміністратор', userAccessLevel: 'Адміністратор',
    globalCache: { isActClosed: false, currentActId: 6, initialActItems: clone(state.items), detailsWithId: [], worksWithId: [] },
    navigator: { onLine: true },
    document: { getElementById: id => id === 'body' ? body : fields.get(id) || null, querySelectorAll: () => [] },
    ZAKAZ_NARAYD_BODY_ID: 'body', ACT_ITEMS_TABLE_CONTAINER_ID: 'items', ZAKAZ_NARAYD_SAVE_BTN_ID: 'save',
    EDITABLE_PROBIG_ID: 'mileage', EDITABLE_REASON_ID: 'reason', EDITABLE_RECOMMENDATIONS_ID: 'recommendations', EDITABLE_NOTES_ID: 'notes',
    parseTableRows: () => clone(state.items),
    actEditorSignature: () => JSON.stringify({ visible: state.items.map(({ type, name, catalog, quantity, price, sum, pibMagazin, slyusarSum }) =>
      ({ type, name, catalog, quantity, price, sum, pibMagazin, slyusarSum })), fields: [...fields] }),
    payrollActorScope: () => state.actor,
    isActWritePending: () => state.pending,
    setActWritePending: value => { state.pending = value; },
    trackActEditor() {},
    setActEditorPayrollPending: (...args) => state.markings.push(args),
    markActEditorSaved: (...args) => state.markings.push(args),
    isActFrozen: snapshot => snapshot?.data?.Заморожений === true,
    safeParseJSON: value => typeof value === 'string' ? JSON.parse(value) : clone(value),
    cleanText: value => String(value ?? '').replace(/\u00a0/g, ' ').trim(),
    async readEditorActForDelta() {
      state.reads++;
      state.beforeRead?.();
      if (state.readError) throw state.readError;
      const result = clone(state.fresh);
      state.afterRead?.();
      return result;
    },
    supabase: { from(tableName) {
      assert.equal(tableName, 'sclad');
      return { select(projection) { return { async in(key, ids) {
        state.stockReads.push({ projection, key, ids: Array.from(ids) });
        return { data: clone(state.stock), error: state.stockError };
      } }; } };
    } },
    cacheHiddenColumnsData: snapshot => state.snapshots.push(clone(snapshot)),
    prepareEditorRowReferences: async () => { state.references++; },
    appConfirm: async () => true,
    processItems() { state.processing++; throw new Error('FULL_SAVE_REACHED'); },
    writeEditorActDelta: async () => { state.writes++; throw new Error('UNEXPECTED_WRITE'); },
    commitPayrollSession: async () => { state.payrollWrites++; throw new Error('UNEXPECTED_PAYROLL'); },
    showNotification: (...args) => state.notices.push(args),
  };
  vm.createContext(context);
  const code = functions('src/ts/utils/actSafeWrite.ts', ['stableActJson', 'countNamedActRows']) + '\n' +
    functions(saveFile, ['actSaveInputSignature', 'rememberUnchangedActBaseline', 'canReuseUnchangedActBaseline',
      'loadPurchasePrices', 'getPurchasePrice', 'saveActData', 'saveCurrentAct', 'addSaveHandler']);
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
  if (register) context.addSaveHandler(6, saved);
  return { state, fields, body, context, saved, save: () => context.saveCurrentAct(6) };
}

function released(f) {
  assert.equal(f.state.pending, false);
  assert.equal(f.context.isSaving, false);
  assert.equal(f.body.inert, false);
}
function unwritten(f) {
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.payrollWrites, 0);
}

for (const stockId of [null, 9001]) test(`unchanged historical act with ${stockId == null ? 'manual part' : 'missing stock ID'} reuses saved content without cost or payroll requests`, async () => {
  const f = fixture({ stockId });
  const before = clone(f.state.fresh);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.save();
    assert.equal(result.changed, false);
    assert.deepEqual(f.state.fresh, before);
  }
  assert.equal(f.state.reads, 2, 'each close attempt confirms the current server snapshot');
  assert.equal(f.state.stockReads.length, 0);
  assert.equal(f.state.processing, 0);
  assert.equal(f.state.references, 0);
  unwritten(f); released(f);
});

test('explicitly completed payroll is eligible but false is never rewritten onto historical JSON', async () => {
  const f = fixture({ pending: false });
  const result = await f.save();
  assert.equal(result.changed, false);
  assert.equal(f.state.fresh.data.__payroll_pending, false);
  assert.equal(f.state.stockReads.length, 0);
  unwritten(f);
});

const dirtyCases = [
  ['work name', f => { f.state.items[1].name = 'Інша робота'; }],
  ['quantity', f => { f.state.items[0].quantity = 3; }],
  ['price', f => { f.state.items[0].price = 175; }],
  ['shop', f => { f.state.items[0].pibMagazin = 'Інший магазин'; }],
  ['catalog', f => { f.state.items[0].catalog = 'OTHER'; }],
  ['hidden stock ID', f => { f.state.items[0].sclad_id = 9002; }],
  ['hidden mechanic ID', f => { f.state.items[1].slyusar_id = 18; }],
  ['salary', f => { f.state.items[1].slyusarSum = 125; }],
  ['discount', f => { f.fields.get('editable-discount').value = '10'; }],
  ['notes', f => { Object.assign(f.fields.get('notes'), { textContent: 'Зміни', innerText: 'Зміни' }); }],
];
for (const [label, mutate] of dirtyCases) test(`${label} change uses the full missing-cost guard instead of the legacy no-op`, async () => {
  const f = fixture();
  mutate(f);
  await assert.rejects(f.save(), /відсутня закупівельна ціна/);
  assert.equal(f.state.stockReads.length, 1);
  assert.equal(f.state.stockReads[0].projection, 'sclad_id, price');
  assert.equal(f.state.stockReads[0].key, 'sclad_id');
  assert.ok(f.state.stockReads[0].ids.length <= 200);
  unwritten(f); released(f);
});

test('a changed manual part also proceeds through the full save path', async () => {
  const f = fixture({ stockId: null });
  f.state.items[0].price = 175;
  await assert.rejects(f.save(), /FULL_SAVE_REACHED/);
  assert.equal(f.state.processing, 1);
  assert.equal(f.state.stockReads.length, 0);
  unwritten(f); released(f);
});

test('absence of the opening input baseline cannot skip cost validation', async () => {
  const f = fixture();
  f.context.unchangedActSaveBaseline = null;
  await assert.rejects(f.save(), /відсутня закупівельна ціна/);
  assert.equal(f.state.stockReads.length, 1);
  unwritten(f); released(f);
});

test('incomplete table initialization never creates an eligible baseline', async () => {
  const f = fixture({ register: false });
  f.state.items.pop();
  f.context.addSaveHandler(6, f.saved);
  await assert.rejects(f.save(), /не завантажена повністю/);
  assert.equal(f.state.reads, 0);
  assert.equal(f.state.stockReads.length, 0);
  unwritten(f);
});

test('changed remote financial rows conflict before stock loading', async () => {
  const f = fixture();
  f.state.fresh.data.Деталі[0].Кількість = 3;
  await assert.rejects(f.save(), /Акт змінився/);
  assert.equal(f.state.stockReads.length, 0);
  unwritten(f); released(f);
});

for (const target of ['original', 'fresh']) test(`${target} pending payroll cannot be acknowledged by an unchanged editor`, async () => {
  const f = fixture({ pending: target === 'original' ? true : false });
  if (target === 'fresh') f.state.fresh.data.__payroll_pending = true;
  await assert.rejects(f.save(), /відсутня закупівельна ціна/);
  assert.equal(f.state.stockReads.length, 1);
  assert.equal(f.state.fresh.data.__payroll_pending, true);
  unwritten(f); released(f);
});

test('failed control read cannot pretend the historical act is safe to close', async () => {
  const f = fixture(); f.state.readError = new Error('Failed to fetch');
  await assert.rejects(f.save(), /Немає підтвердженого з’єднання/);
  assert.equal(f.state.stockReads.length, 0);
  unwritten(f); released(f);
});

test('offline state never returns an unchanged success', async () => {
  const f = fixture(); f.context.navigator.onLine = false;
  await assert.rejects(f.save());
  unwritten(f); released(f);
});

test('actor change while the control read is pending cannot reuse a prior user baseline', async () => {
  const f = fixture(); f.state.afterRead = () => { f.state.actor = 'actor-b'; };
  await assert.rejects(f.save(), /Користувач змінився/);
  assert.equal(f.state.stockReads.length, 0);
  unwritten(f); released(f);
});

for (const [name, mutate] of [
  ['closed remotely', f => { f.state.fresh.date_off = '2026-11-02T08:00:00Z'; }],
  ['frozen remotely', f => { f.state.fresh.data.Заморожений = true; }],
]) test(`${name} is rejected before the no-op path`, async () => {
  const f = fixture(); mutate(f);
  await assert.rejects(f.save(), /закритий|Заморожений/);
  assert.equal(f.state.stockReads.length, 0);
  unwritten(f); released(f);
});

test('editing a linked stock row with a failed price read retains the failure guard', async () => {
  const f = fixture(); f.state.items[0].quantity = 3; f.state.stockError = { message: 'offline' };
  await assert.rejects(f.save(), /Не вдалося перевірити закупівельні ціни/);
  assert.equal(f.state.stockReads.length, 1);
  unwritten(f); released(f);
});

for (const lateEdit of [false, true]) test(lateEdit
  ? 'an input changed during the write is not swallowed by the refreshed baseline'
  : 'a successful full save refreshes the unchanged baseline for the next close attempt', async () => {
  const f = fixture();
  f.state.stock = [{ sclad_id: 9001, price: 112.5 }];
  Object.assign(f.fields.get('notes'), { textContent: 'Новий запис', innerText: 'Новий запис' });
  const totals = { totalDetailsSum: 300, totalWorksSum: 200, grandTotalSum: 500,
    totalWorksProfit: 100, totalDetailsMargin: 75 };
  Object.assign(f.context, {
    processItems() { f.state.processing++; return { ...totals, details: clone(f.saved.Деталі),
      works: clone(f.saved.Роботи), detailRowsForShops: [] }; },
    buildShopRowsFromDetails: () => [],
    recalculateMergedTotals: () => totals,
    assertRowsPersisted: (expected, actual) => assert.deepEqual(actual, expected),
    async writeEditorActDelta(_id, before, next) {
      assert.deepEqual(before, f.state.fresh.data);
      f.state.writes++;
      f.state.fresh.data = clone(next);
      if (lateEdit) Object.assign(f.fields.get('notes'), { textContent: 'Ще не збережено', innerText: 'Ще не збережено' });
      return { act_id: 6, data: clone(next), receipt: { status: 'updated' } };
    },
    readTableNewNumbers: () => new Map(),
    actQuantitySnapshot: { seed() {} },
    invalidateEditorStockRows() {}, cleanupEmptyRows: async () => {}, refreshQtyWarningsIn: async () => {},
    updateCalculatedSumsInFooter() {}, refreshActRowInTable: async () => {},
  });
  const saved = await f.save();
  assert.equal(saved.changed, true);
  assert.equal(f.state.fresh.data.Примітки, 'Новий запис');
  assert.equal(f.state.writes, 1);
  assert.equal(f.state.stockReads.length, 1);
  f.state.stock = [];
  if (lateEdit) {
    await assert.rejects(f.save(), /відсутня закупівельна ціна/);
    assert.equal(f.fields.get('notes').textContent, 'Ще не збережено');
    assert.equal(f.state.stockReads.length, 2, 'unsaved asynchronous input remains subject to full validation');
  } else {
    const repeated = await f.save();
    assert.equal(repeated.changed, false);
    assert.equal(f.state.stockReads.length, 1, 'a successful save recaptures the input and JSON baseline');
  }
  assert.equal(f.state.writes, 1);
  assert.equal(f.state.payrollWrites, 0);
  released(f);
});
