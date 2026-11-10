// Local form/RPC fixtures only; no production database calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const base = 'src/ts/roboha/dodatu_inchi_bazu/';
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
class Element extends EventTarget {
  constructor(id = '', value = '') { super(); this.id = id; this.value = value; this.isConnected = true; this.disabled = false; this.style = {}; this.dataset = {}; this.textContent = ''; this.inert = false; this.hidden = new Set(); this.classList = { contains: value => this.hidden.has(value), add: value => this.hidden.add(value), remove: value => this.hidden.delete(value) }; }
  focus() {}
  click() { this.dispatchEvent(new Event('click')); }
}
function fixture({ table = 'works', mode = 'Додати', name = 'Робота нова', draft, verify, write, stock = true, references = true } = {}) {
  const state = { CRUD: mode, all_bd: JSON.stringify(draft || { table, work_id: null, data: '' }), updateAllBd(value) { state.all_bd = value; } };
  const actor = { value: JSON.stringify({ Name: 'Admin', slyusar_id: 1 }) };
  const ids = new Map();
  for (const [id, value] of [['search-input-all_other_bases', name], ['sclad_detail_catno', ''], ['save-password-input', ''], ['save-confirm', ''], ['save-cancel', ''], ['other-base-confirmation-title', '']]) ids.set(id, new Element(id, value));
  const panel = new Element('panel'), modal = new Element('modal');
  const names = { works: 'Робота', incomes: 'Джерело', slyusars: 'Співробітники', sclad: 'Склад' };
  const section = new Element(); section.textContent = names[table] || '';
  const fields = [ids.get('search-input-all_other_bases'), ids.get('sclad_detail_catno')];
  panel.querySelectorAll = () => fields;
  panel.querySelector = () => section;
  modal.querySelector = query => ids.get(query.slice(1));
  const document = new EventTarget();
  document.getElementById = id => id === 'save-prompt-modal-all-other-bases' ? modal : ids.get(id);
  document.querySelector = () => panel;
  const calls = { verify: 0, write: [], delete: [], stock: 0, references: 0, log: 0 }, notices = [];
  const dependencies = {
    './inhi/directoryRead': {
      directoryId: kind => ({ works: 'work_id', details: 'detail_id', shops: 'shop_id', incomes: 'income_id', receivers: 'receiver_id', slyusars: 'slyusar_id' })[kind],
      writeDirectory: async (...args) => { calls.write.push(args); return write ? write(...args) : { status: 'created', row: {} }; },
      deleteDirectory: async (...args) => { calls.delete.push(args); return { status: 'deleted', id: args[1] }; },
    },
    '../../vxid/supabaseClient': { supabase: { rpc: async (...args) => { calls.verify++; return verify ? verify(...args) : { data: true }; }, from() { throw Error('Unexpected whole-table query'); } } },
    '../zakaz_naraudy/inhi/vspluvauhe_povidomlenna': { showNotification: (...args) => notices.push(args) },
    './dodatu_inchi_bazu_danux': state,
    './inhi/scladMagasunDetal': { resetShopState() {}, resetDetailState() {} },
    './db_shops_details': { tryHandleStockReferencesCrud: async () => { calls.references++; return references; } },
    './db_sclad': { handleScladCrud: async () => { calls.stock++; return stock; } },
    './inhi/slusar': { getSlusarAdditionalData: () => ({ percent: 0, percentParts: 0, access: 'Слюсар', warehouse: 0 }), saveSlusarData: async () => true },
    '../../utils/auditLogger': { logAction: async () => { calls.log++; } },
  };
  const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(base + 'vikno_pidtverdchennay_inchi_bazu.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
    { exports: api, require: path => dependencies[path], document, localStorage: { getItem: () => actor.value }, CustomEvent: class extends Event { constructor(type, options) { super(type); this.detail = options?.detail; } } });
  const begin = () => { const promise = api.showSavePromptModal(); ids.get('save-password-input').value = 'password'; return promise; };
  return { api, begin, ids, calls, notices, actor, state, panel, modal, click: () => ids.get('save-confirm').click(), cancel: () => ids.get('save-cancel').click() };
}

test('works add cannot dispatch hidden stock references; one confirmation verifies and writes once', async () => {
  const f = fixture();
  f.ids.get('sclad_detail_catno').value = 'hidden-stock-catalog';
  const result = f.begin();
  assert.equal(f.api.showSavePromptModal(), result);
  assert.equal(f.panel.inert, true);
  f.click(); f.click();
  assert.equal(await result, true);
  assert.equal(f.calls.verify, 1); assert.equal(f.calls.write.length, 1);
  assert.deepEqual(f.calls.write[0].slice(0, 2), ['works', null]);
  assert.equal(f.calls.write[0][2].data, 'Робота нова');
  assert.equal(f.calls.references + f.calls.stock, 0);
  assert.equal(f.panel.inert, false);
});

test('source edit with no changes makes no password or database request', async () => {
  const f = fixture({ table: 'incomes', mode: 'Редагувати', name: 'Google', draft: { table: 'incomes', income_id: 2, data: { Name: 'Google' } } });
  assert.equal(await f.begin(), true);
  assert.equal(f.calls.verify, 0); assert.equal(f.calls.write.length, 0);
});

test('editing a work uses its selected ID and original name baseline', async () => {
  const f = fixture({ mode: 'Редагувати', name: 'Нова назва', draft: { table: 'works', work_id: 15, data: 'Стара назва' } });
  const result = f.begin(); f.click(); await result;
  const [kind, id, patch, expected] = f.calls.write[0];
  assert.equal(kind, 'works'); assert.equal(id, 15); assert.equal(patch.data, 'Нова назва'); assert.equal(expected.data, 'Стара назва');
});

test('selection change during password verification blocks all writes and keeps the draft', async () => {
  let resolve; const f = fixture({ verify: () => new Promise(done => { resolve = done; }) });
  const result = f.begin(); f.click();
  f.state.all_bd = JSON.stringify({ table: 'works', work_id: 22, data: 'Other' });
  resolve({ data: true }); await flush();
  assert.equal(f.calls.write.length, 0); assert.equal(f.modal.style.display, 'flex');
  assert.match(f.notices.at(-1)[0], /Форма або користувач змінилися/);
  f.cancel(); assert.equal(await result, false);
  assert.match(f.state.all_bd, /Other/);
});

test('actor change during password verification blocks the pending write', async () => {
  let resolve; const f = fixture({ verify: () => new Promise(done => { resolve = done; }) });
  const result = f.begin(); f.click(); f.actor.value = JSON.stringify({ Name: 'Another', slyusar_id: 2 });
  resolve({ data: true }); await flush();
  assert.equal(f.calls.write.length, 0); f.cancel(); assert.equal(await result, false);
});

test('database errors keep the form, selected ID and actual error visible for correction', async () => {
  const f = fixture({ write: async () => { throw { message: 'Запис уже змінено іншим користувачем' }; } });
  const before = f.state.all_bd, result = f.begin(); f.click(); await flush();
  assert.equal(f.modal.style.display, 'flex'); assert.equal(f.panel.classList.contains('hidden-all_other_bases'), false);
  assert.equal(f.state.all_bd, before); assert.equal(f.ids.get('save-confirm').disabled, false);
  assert.match(f.notices.at(-1)[0], /іншим користувачем/);
  f.cancel(); assert.equal(await result, false); assert.equal(f.panel.inert, false);
});

test('edit without a selected ID is rejected before password verification', async () => {
  const f = fixture({ mode: 'Редагувати' });
  assert.equal(await f.begin(), false); assert.equal(f.calls.verify, 0);
  assert.match(f.notices[0][0], /випадаючого списку/);
});

test('catalog stock operations never separately rename or delete reference directories', async () => {
  const f = fixture({ table: 'sclad', mode: 'Видалити', draft: { table: 'sclad' } });
  f.ids.get('sclad_detail_catno').value = '143';
  const result = f.begin(); f.click(); assert.equal(await result, true);
  assert.equal(f.calls.stock, 1); assert.equal(f.calls.references + f.calls.write.length + f.calls.delete.length, 0);
});

test('stock references use one atomic operation and retain the form on failure', async () => {
  const f = fixture({ table: 'sclad', references: false });
  const result = f.begin(); f.click(); await flush();
  assert.equal(f.calls.references, 1); assert.equal(f.calls.stock + f.calls.write.length + f.calls.delete.length, 0);
  assert.equal(f.modal.style.display, 'flex'); assert.equal(f.panel.classList.contains('hidden-all_other_bases'), false);
  f.cancel(); assert.equal(await result, false);
});

test('generic delete sends only the selected ID and baseline', async () => {
  const f = fixture({ mode: 'Видалити', name: 'Work', draft: { table: 'works', work_id: 10, data: 'Work' } });
  const result = f.begin(); f.click(); assert.equal(await result, true);
  assert.equal(f.calls.delete.length, 1); assert.equal(f.calls.delete[0][1], 10); assert.equal(f.calls.delete[0][2].data, 'Work');
  assert.equal(f.calls.write.length, 0);
});

test('a stale cross-section draft cannot determine the write target', async () => {
  const f = fixture({ table: 'works', draft: { table: 'sclad' } });
  assert.equal(await f.begin(), false); assert.equal(f.calls.verify, 0); assert.equal(f.calls.stock, 0);
});

test('work dropdown keeps selected identity while renaming and clears it on empty input', async () => {
  const input = new Element('search-input-all_other_bases'), dropdown = new Element();
  let draft, onSelect, onInput;
  const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(base + 'inhi/robota.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports: api, document: { getElementById: id => id.startsWith('search') ? input : dropdown },
    require: path => path.includes('directoryRead') ? { mountDirectoryDropdown: (kind, el, dd, selected, changed) => { assert.equal(kind, 'works'); onSelect = selected; onInput = changed; } } : { updateAllBd: value => { draft = JSON.parse(value); }, updateTableNameDisplay() {} },
  });
  await api.handleRobotaClick();
  input.value = 'Work A'; onSelect({ work_id: 12, data: 'Work A' });
  input.value = 'Work B'; onInput();
  assert.equal(draft.work_id, 12); assert.equal(draft.data, 'Work A');
  input.value = ''; onInput(); assert.equal(draft.work_id, null);
});

test('section initialization and previous-account forms cannot open a save confirmation', async () => {
  for (const attributes of [{ otherBasesLoading: 'true' }, { otherBasesReady: 'false' }, { otherBasesActor: 'previous user' }]) {
    const f = fixture(); Object.assign(f.panel.dataset, attributes);
    assert.equal(await f.begin(), false);
    assert.equal(f.calls.verify, 0); assert.equal(f.calls.write.length, 0);
    assert.equal(f.notices.length, 1);
  }
});

test('clearing the shared search also clears employee-only locks and styles', () => {
  const ids = new Map(), search = new Element('search-input-all_other_bases', 'Protected employee');
  Object.assign(search, { disabled: true, readOnly: true, title: 'Protected' });
  Object.assign(search.style, { backgroundColor: '#f0f0f0', cursor: 'not-allowed' });
  search.dataset.keyboardNavBound = 'true';
  search.cloneNode = () => {
    const clone = new Element(search.id, search.value);
    Object.assign(clone, { disabled: search.disabled, readOnly: search.readOnly, title: search.title });
    Object.assign(clone.style, search.style); Object.assign(clone.dataset, search.dataset);
    return clone;
  };
  search.parentNode = { replaceChild: clone => ids.set(clone.id, clone) };
  ids.set(search.id, search); ids.set('modeToggleLabel', new Element('modeToggleLabel'));
  const api = {}, document = { addEventListener() {}, getElementById: id => ids.get(id), querySelectorAll: () => [] };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(base + 'dodatu_inchi_bazu_danux.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
    { exports: api, require: () => ({ resetScladFormSession() {} }), document });
  api.clearAllData();
  const clean = ids.get(search.id);
  assert.equal(clean.value, ''); assert.equal(clean.readOnly, false); assert.equal(clean.disabled, false);
  assert.equal(clean.title, ''); assert.equal(clean.style.cursor, ''); assert.equal(clean.style.backgroundColor, '');
  assert.equal(clean.dataset.keyboardNavBound, undefined);
  api.updateCRUD('Видалити');
  assert.equal(api.CRUD, 'Видалити'); assert.equal(ids.get('modeToggleLabel').textContent, 'Видалити');
});

// Exercise the real section controller with its surrounding DOM/auth dependencies
// supplied directly, without reproducing the modal's unrelated export/template UI.
function sectionFixture(getSession) {
  const source = fs.readFileSync(base + 'dodatu_inchi_bazu_danux.ts', 'utf8');
  const start = source.indexOf('  const selectSection = async');
  const end = source.indexOf('  toggleButtons.forEach((button) => {', start);
  assert.ok(start > 0 && end > start);
  const modal = new Element(), mode = new Element(), wrap = new Element(), stock = new Element();
  const buttons = ['Робота', 'Джерело', 'Співробітники'].map(name => { const button = new Element(); button.textContent = name; return button; });
  const actor = { value: 'actor A' }, calls = { auth: 0, clear: 0, works: 0, source: 0, staff: 0, busy: [], notices: [] };
  const document = new EventTarget();
  document.getElementById = id => ({ modeToggleLabel: mode, 'global-search-wrap': wrap, 'sclad-form': stock })[id];
  const api = {};
  const setup = `let sectionRequest = 0, modalRevision = 0, readySection = null, pendingSection = null;`;
  const expose = `exports.select = selectSection; exports.invalidate = () => { modalRevision++; };`;
  vm.runInNewContext(ts.transpileModule(setup + source.slice(start, end) + expose, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports: api, document, modal_all_other_bases: modal, toggleButtons: buttons, CRUD: 'Редагувати',
    isOtherBasesSavePending: () => false, actorScope: () => actor.value,
    setSectionLoading: value => calls.busy.push(value), clearAllData: () => { calls.clear++; },
    toggleImportButton() {}, toggleExportWorksButton() {}, updateCRUD() {},
    showAppMessage: value => calls.notices.push(value), showNotification: value => calls.notices.push(value),
    handleRobotaClick: async () => { calls.works++; }, handleDhereloClick: async () => { calls.source++; }, handleSlusarClick: async () => { calls.staff++; },
    supabase: { auth: { getSession: async () => { calls.auth++; return getSession ? getSession() : { data: { session: {} } }; } } },
    CustomEvent: class extends Event { constructor(type, options) { super(type); this.detail = options?.detail; } },
  });
  return { api, modal, mode, buttons, actor, calls };
}

test('repeated active/pending tab clicks reuse the form and make no extra auth/setup calls', async () => {
  let resolve;
  const f = sectionFixture(() => new Promise(done => { resolve = done; }));
  const first = f.api.select(f.buttons[0]);
  await f.api.select(f.buttons[0]);
  assert.equal(f.calls.auth, 1); assert.equal(f.calls.clear, 1);
  resolve({ data: { session: {} } }); await first;
  await f.api.select(f.buttons[0]);
  assert.equal(f.calls.auth, 1); assert.equal(f.calls.works, 1); assert.equal(f.calls.clear, 1);
});

test('late tab authorization cannot initialize the previous section or unlock the current pending form', async () => {
  const pending = [];
  const f = sectionFixture(() => new Promise(resolve => pending.push(resolve)));
  const work = f.api.select(f.buttons[0]), source = f.api.select(f.buttons[1]);
  pending[0]({ data: { session: {} } }); await work;
  assert.equal(f.calls.works, 0); assert.deepEqual(f.calls.busy, [true, true]);
  pending[1]({ data: { session: {} } }); await source;
  assert.equal(f.calls.source, 1); assert.deepEqual(f.calls.busy, [true, true, false]);
});

test('close and actor changes invalidate a pending section setup', async () => {
  for (const invalidate of [f => f.api.invalidate(), f => { f.actor.value = 'actor B'; }]) {
    let resolve; const f = sectionFixture(() => new Promise(done => { resolve = done; }));
    const opening = f.api.select(f.buttons[0]); invalidate(f);
    resolve({ data: { session: {} } }); await opening;
    assert.equal(f.calls.works, 0);
  }
});

test('switching sections resets shared mode locks and mode cycling follows current CRUD', async () => {
  const f = sectionFixture(); f.mode.disabled = true; f.mode.style.cursor = 'not-allowed';
  await f.api.select(f.buttons[0]);
  assert.equal(f.mode.disabled, false); assert.equal(f.mode.style.cursor, 'pointer');
  const source = fs.readFileSync(base + 'dodatu_inchi_bazu_danux.ts', 'utf8');
  const start = source.indexOf('  const handleModeSwitch = () => {');
  const end = source.indexOf('\n  if (modeLabel)', start);
  let next;
  vm.runInNewContext(ts.transpileModule(source.slice(start, end) + '\nhandleModeSwitch();', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, {
    CRUD: 'Видалити', modes: ['Додати', 'Редагувати', 'Видалити'], modeLabel: f.mode, modal_all_other_bases: f.modal,
    isOtherBasesSavePending: () => false, updateCRUD: value => { next = value; },
  });
  assert.equal(next, 'Додати');
});
