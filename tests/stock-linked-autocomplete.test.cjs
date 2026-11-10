const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Isolated DOM + transport: exercise the real modal handlers with deferred replies.
// No authentication, Realtime, database connection or writes are started here.
function fixture() {
  const fields = new Map(), requests = [], timers = new Map();
  let timerId = 0, actor = 'actor-one', revision = 0, responder;
  const held = new Set();
  class UiEvent {
    constructor(type, options = {}) { this.type = type; this.bubbles = !!options.bubbles; this.defaultPrevented = false; this.cancelBubble = false; }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.cancelBubble = true; }
  }
  class Element {
    constructor(tag = 'INPUT', value = '') {
      this.tagName = tag; this.value = value; this.dataset = {}; this.style = {};
      this.children = []; this.listeners = {}; this.parentElement = null; this.isConnected = true;
      this.options = []; this.selectedIndex = 0; this.attrs = {}; this.flags = new Set(); this._text = '';
      this.classList = { add: (...x) => x.forEach(k => this.flags.add(k)), remove: (...x) => x.forEach(k => this.flags.delete(k)),
        contains: x => this.flags.has(x), toggle: (x, on) => { on ??= !this.flags.has(x); on ? this.flags.add(x) : this.flags.delete(x); return on; } };
    }
    get className() { return [...this.flags].join(' '); }
    set className(value) { this.flags = new Set(value.split(/\s+/).filter(Boolean)); }
    get innerHTML() { return this._text; }
    set innerHTML(value) { this._text = value; this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children); }
    contains(child) { return this === child || this.children.some(item => item.contains(child)); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); this.isConnected = false; }
    add(option) { this.options.push(option); }
    getBoundingClientRect() { return { width: 300 }; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    removeAttribute(name) { delete this.attrs[name]; }
    scrollIntoView() {}
    addEventListener(type, fn, options = {}) {
      (this.listeners[type] ||= []).push(fn);
      if (options.signal) options.signal.addEventListener('abort', () => this.removeEventListener(type, fn), { once: true });
    }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== fn); }
    dispatchEvent(event) {
      event.target ||= this; event.currentTarget = this;
      for (const fn of [...(this.listeners[event.type] || [])]) fn.call(this, event);
      this['on' + event.type]?.call(this, event);
      if (event.bubbles && !event.cancelBubble && this.parentElement) this.parentElement.dispatchEvent(event);
      return !event.defaultPrevented;
    }
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      return selector === '.custom-dropdown-item' ? all.filter(child => child.flags.has('custom-dropdown-item')) : all;
    }
    focus() { document.activeElement = this; this.dispatchEvent(new UiEvent('focus')); }
    click() { this.dispatchEvent(new UiEvent('click', { bubbles: true })); }
  }
  const document = new Element('DOCUMENT');
  const form = new Element('DIV'); form.id = 'sclad-form'; form.parentElement = document; fields.set(form.id, form);
  for (const id of ['sclad_date', 'sclad_shop', 'sclad_detail_catno', 'sclad_detail', 'sclad_qty_in', 'sclad_price', 'sclad_sum', 'sclad_invoice_no', 'sclad_unit', 'sclad_procent', 'sclad_zapchastyst_pib', 'hidden-sclad-id']) {
    const element = new Element(); element.id = id; form.appendChild(element); fields.set(id, element);
  }
  fields.get('sclad_date').value = '2026-10-26';
  fields.get('sclad_zapchastyst_pib').value = 'Поточний користувач'; fields.get('sclad_zapchastyst_pib').dataset.slyusarId = '1';
  for (const id of ['sclad_part_dd', 'sclad_detail_dd']) {
    const element = new Element('DIV'); element.id = id; element.classList.add('hidden-all_other_bases'); form.appendChild(element); fields.set(id, element);
  }
  document.getElementById = id => fields.get(id) || null;
  document.querySelectorAll = selector => selector.includes('input') || selector.includes('select')
    ? [...fields.values()].filter(element => ['INPUT', 'SELECT'].includes(element.tagName)) : form.querySelectorAll(selector);
  document.createElement = tag => new Element(tag.toUpperCase());
  function pending(kind, args) {
    return new Promise((resolve, reject) => {
      const request = { kind, args, resolve: data => resolve({ data, error: null }), reject };
      requests.push(request);
      if (responder && !held.has(kind)) request.resolve(responder(kind, args));
    });
  }
  const client = {
    rpc: (name, args) => pending(name, args),
    from(table) {
      const args = { table, filters: [], order: [], range: null };
      const query = { select(columns) { args.columns = columns; return query; },
        ilike(column, value) { args.filters.push(['ilike', column, value]); return query; },
        eq(column, value) { args.filters.push(['eq', column, value]); return query; },
        order(column, value) { args.order.push([column, value]); return query; },
        range(from, to) { args.range = [from, to]; return pending('stock', args); } };
      return query;
    },
  };
  const deps = {
    './stockReadRevision': { stockSuggestionRevision: () => revision },
    '../../../vxid/supabaseClient': { supabase: client }, './referenceLookup': {}, './directoryRead': {},
    '../dodatu_inchi_bazu_danux': { CRUD: 'Додати', updateAllBd() {} }, './batchImportSclad': {},
    '../../redahyvatu_klient_machuna/enter_navigation': {}, './sharedAutocomplete': { setupDropdownKeyboard() {} },
  };
  const context = { exports: {}, require: name => { if (!(name in deps)) throw Error('Unexpected dependency: ' + name); return deps[name]; },
    AbortController, structuredClone, Event: UiEvent, document,
    localStorage: { getItem: () => actor },
    Option: function (text, value) { this.text = text; this.value = value; this.dataset = {}; },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id) };
  const source = fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/scladMagasunDetal.ts', 'utf8') +
    '\nexport const testWire=wireLinkedAutocomplete,testDetailWire=wireDetailsAutocompleteWithLiveLoad,testTotal=updateScladTotal;';
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { api: context.exports, fields, requests, document,
    actor(value) { actor = value; }, revise() { revision++; },
    serve(rows, names = rows.map(row => ({ detail_id: row.detail_id, name: row.name }))) {
      responder = (kind, args) => {
        if (kind === 'traffic_stock_position') return rows.find(row => row.sclad_id === args.p_id) || null;
        if (kind === 'traffic_detail_suggestions') {
          const unique = [...new Map(names.map(row => [row.detail_id, row])).values()];
          const hits = unique.filter(row => row.name.toLocaleLowerCase().includes(args.p_query.trim().toLocaleLowerCase()));
          return { items: hits.slice(args.p_offset, args.p_offset + 20), has_more: hits.length > args.p_offset + 20 };
        }
        if (kind !== 'stock') throw Error('Unplanned request: ' + kind);
        const like = (text, pattern) => {
          let source = '^';
          for (let i = 0; i < pattern.length; i++) {
            const ch = pattern[i];
            if (ch === '\\' && i + 1 < pattern.length) source += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            else source += ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          }
          return new RegExp(source + '$', 'iu').test(String(text ?? ''));
        };
        return rows.filter(row => args.filters.every(([op, key, value]) => op === 'eq' ? row[key] === value : like(row[key], value)))
          .sort((a, b) => b.sclad_id - a.sclad_id).slice(args.range[0], args.range[1] + 1)
          .map(row => Object.fromEntries(args.columns.split(',').map(key => [key, row[key]])));
      };
    },
    hold(kind) { held.add(kind); },
    release(request) { request.resolve(responder(request.kind, request.args)); },
    value(id) { return fields.get(id).value; },
    input(id, value) { const field = fields.get(id); field.value = value; field.dispatchEvent(new UiEvent('input', { bubbles: true })); },
    focus(id) { fields.get(id).focus(); }, click(id) { fields.get(id).click(); },
    scrollBottom(id) {
      const dropdown = fields.get(id); dropdown.scrollHeight = 600; dropdown.clientHeight = 300; dropdown.scrollTop = 299;
      dropdown.dispatchEvent(new UiEvent('scroll'));
    },
    choose(item) { for (const type of ['pointerdown', 'mousedown', 'click']) item.dispatchEvent(new UiEvent(type, { bubbles: true })); },
    items(id) { return fields.get(id).children.filter(child => child.classList.contains('custom-dropdown-item')); },
    visible(id) { return !fields.get(id).classList.contains('hidden-all_other_bases'); },
    flush() { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); },
    tick: () => new Promise(resolve => setImmediate(resolve)),
  };
}

const position = (patch = {}) => ({ sclad_id: 7, part_number: '80B927225', name: 'Кнопка ручника',
  time_on: '2026-10-20', shops: 'Магазин', kilkist_on: 2, price: 334.5, rahunok: '10730723',
  unit_measurement: 'штук', scladNomer: 2, xto_zamovuv: 6, employee_name: 'Запчастист Тест',
  shop_id: 9, detail_id: 12, kilkist_off: 0, akt: null, ...patch });
async function mount(f) {
  await f.api.testWire();
  await f.api.testDetailWire('sclad_detail', 'sclad_detail_dd');
}
async function drain(f) { f.flush(); await f.tick(); f.flush(); await f.tick(); }
async function search(f, id, text) { f.input(id, text); await drain(f); }
function chooseText(f, dropdown, text) {
  const item = f.items(dropdown).find(row => row.textContent.includes(text));
  assert.ok(item, `Expected ${text} in ${dropdown}: ${f.items(dropdown).map(row => row.textContent).join(' / ')}`);
  f.choose(item);
}
function assertFilled(f, row) {
  for (const [id, key] of Object.entries({ sclad_detail_catno: 'part_number', sclad_detail: 'name', sclad_shop: 'shops',
    sclad_qty_in: 'kilkist_on', sclad_price: 'price', sclad_invoice_no: 'rahunok', sclad_unit: 'unit_measurement',
    sclad_procent: 'scladNomer', sclad_date: 'time_on', sclad_zapchastyst_pib: 'employee_name' })) {
    assert.equal(f.value(id), String(row[key]), id);
  }
  assert.equal(f.api.getCurrentScladId(), String(row.sclad_id));
  assert.equal(f.api.getOriginalScladRecord().sclad_id, row.sclad_id);
  assert.equal(f.fields.get('sclad_zapchastyst_pib').dataset.slyusarId, String(row.xto_zamovuv));
  assert.equal(Number(f.value('sclad_sum').replace(',', '.')), Math.round(row.kilkist_on * row.price * 100) / 100);
}

test('choosing an unambiguous catalog fills both identity fields and the complete selected position', async () => {
  const f = fixture(), row = position(); f.serve([row]); await mount(f);
  await search(f, 'sclad_detail_catno', '80B');
  chooseText(f, 'sclad_part_dd', row.part_number); await drain(f);
  assertFilled(f, row);
  assert.equal(f.requests.filter(request => request.kind === 'traffic_stock_position').length, 1);
  assert.equal(f.requests.filter(request => request.kind === 'traffic_detail_employee').length, 0);
});

test('a catalog with different names offers the linked detail choice before fetching one position', async () => {
  const a = position({ name: 'Кнопка ліва' }), b = position({ sclad_id: 8, name: 'Кнопка права', detail_id: 13 });
  const f = fixture(); f.serve([a, b]); await mount(f);
  await search(f, 'sclad_detail_catno', '80B');
  chooseText(f, 'sclad_part_dd', a.part_number); await drain(f);
  assert.equal(f.api.getCurrentScladId(), null);
  assert.equal(f.requests.filter(request => request.kind === 'traffic_stock_position').length, 0);
  assert.equal(f.visible('sclad_detail_dd'), true);
  assert.ok(f.items('sclad_detail_dd').some(row => row.textContent.includes(a.name)));
  chooseText(f, 'sclad_detail_dd', b.name); await drain(f);
  assertFilled(f, b);
});

test('choosing an unambiguous detail name mirrors catalog selection and fills all position values', async () => {
  const f = fixture(), row = position(); f.serve([row]); await mount(f);
  await search(f, 'sclad_detail', 'Кнопка');
  chooseText(f, 'sclad_detail_dd', row.name); await drain(f);
  assertFilled(f, row);
  assert.equal(f.requests.filter(request => request.kind === 'traffic_stock_position').length, 1);
});

test('a shared detail name offers its catalog numbers and preserves the chosen catalog', async () => {
  const a = position({ part_number: 'CAT-A' }), b = position({ sclad_id: 8, part_number: 'CAT-B', price: 999 });
  const f = fixture(); f.serve([a, b]); await mount(f);
  await search(f, 'sclad_detail', a.name);
  chooseText(f, 'sclad_detail_dd', a.name); await drain(f);
  assert.equal(f.api.getCurrentScladId(), null);
  assert.equal(f.visible('sclad_part_dd'), true);
  assert.equal(f.requests.filter(request => request.kind === 'traffic_stock_position').length, 0);
  chooseText(f, 'sclad_part_dd', 'CAT-A'); await drain(f);
  assertFilled(f, a);
});

test('the same catalog and name in different invoices never chooses a receipt implicitly', async () => {
  const a = position({ rahunok: 'INVOICE-A', shops: 'Магазин А' }), b = position({ sclad_id: 8, rahunok: 'INVOICE-B', shops: 'Магазин Б', price: 500 });
  const f = fixture(); f.serve([a, b]); await mount(f);
  await search(f, 'sclad_detail_catno', a.part_number);
  chooseText(f, 'sclad_part_dd', a.part_number); await drain(f);
  assert.equal(f.api.getCurrentScladId(), null);
  assert.equal(f.requests.filter(request => request.kind === 'traffic_stock_position').length, 0);
  const dropdown = ['sclad_detail_dd', 'sclad_part_dd'].find(id => f.visible(id) && f.items(id).some(row => row.textContent.includes('INVOICE-A')));
  assert.ok(dropdown, 'Receipt choice must display invoice information');
  chooseText(f, dropdown, 'INVOICE-A'); await drain(f);
  assertFilled(f, a);
});

test('partial pages never imply uniqueness and every lookup has an explicit short projection and row boundary', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => position({ sclad_id: 100 + index, rahunok: 'INV-' + index }));
  rows[0].name = 'Інша назва поза першою сторінкою';
  const f = fixture(); f.serve(rows); await mount(f);
  await search(f, 'sclad_detail_catno', '80B');
  chooseText(f, 'sclad_part_dd', rows[0].part_number); await drain(f);
  assert.equal(f.api.getCurrentScladId(), null);
  assert.equal(f.requests.filter(request => request.kind === 'traffic_stock_position').length, 0);
  for (const request of f.requests.filter(request => request.kind === 'stock')) {
    assert.ok(request.args.range && request.args.range[1] - request.args.range[0] <= 20);
    assert.ok(!request.args.columns.includes('*') && !request.args.columns.split(',').includes('data'));
  }
});

test('computed sum uses quantity and price, handles decimal/zero and never creates a request', async () => {
  const f = fixture();
  for (const [quantity, price, expected] of [['2', '334.5', 669], ['0.3', '0.1', 0.03], ['0', '334.5', 0], ['2', '0', 0]]) {
    f.fields.get('sclad_qty_in').value = quantity; f.fields.get('sclad_price').value = price;
    f.api.testTotal();
    assert.equal(Number(f.value('sclad_sum').replace(',', '.')), expected);
  }
  assert.equal(f.requests.length, 0);
});

test('name suggestions use only bounded stock reads and leave a new typed name available for creation', async () => {
  const f = fixture(), row = position(); f.serve([row]); await mount(f);
  await search(f, 'sclad_detail', 'Кнопка');
  assert.ok(f.items('sclad_detail_dd').some(item => item.textContent.includes(row.name)));
  assert.ok(f.requests.length > 0);
  for (const request of f.requests) {
    assert.equal(request.kind, 'stock', 'Suggestions must not read the separate details directory');
    assert.equal(request.args.table, 'sclad');
    assert.ok(request.args.range[1] - request.args.range[0] <= 20);
    assert.ok(!request.args.columns.includes('*'));
  }
  await search(f, 'sclad_detail', 'Нова деталь без попереднього надходження');
  assert.equal(f.value('sclad_detail'), 'Нова деталь без попереднього надходження');
  assert.equal(f.api.getCurrentScladId(), null);
  assert.equal(f.requests.some(request => request.kind === 'traffic_stock_position'), false);
});

test('focus and click coalesce one short read, cached reopen has no network, and actor/revision changes invalidate it', async () => {
  const f = fixture(), row = position(); f.serve([row]); f.hold('stock'); await mount(f);
  f.fields.get('sclad_detail_catno').value = '80B';
  f.focus('sclad_detail_catno'); f.click('sclad_detail_catno'); await drain(f);
  assert.equal(f.requests.length, 1, 'Focus and click must share the in-flight lookup');
  f.release(f.requests[0]); await drain(f);
  assert.ok(f.items('sclad_part_dd').length);
  f.document.click(); f.click('sclad_detail_catno'); await drain(f);
  assert.equal(f.requests.length, 1, 'An unchanged cached query should not read again');
  f.actor('actor-two'); f.click('sclad_detail_catno'); await drain(f);
  assert.equal(f.requests.length, 2, 'An actor must not reuse another actor\'s lookup');
  f.release(f.requests[1]); await drain(f);
  f.revise(); f.click('sclad_detail_catno'); await drain(f);
  assert.equal(f.requests.length, 3, 'A stock change invalidates cached suggestions');
  f.release(f.requests[2]); await drain(f);
});

test('rapid typing is debounced and an older reply cannot replace a newer dropdown', async () => {
  const a = position({ part_number: 'CAT-OLD' }), b = position({ sclad_id: 8, part_number: 'CAT-NEW' });
  const f = fixture(); f.serve([a, b]); f.hold('stock'); await mount(f);
  f.input('sclad_detail_catno', 'C'); f.input('sclad_detail_catno', 'CA'); f.input('sclad_detail_catno', 'CAT-OLD');
  await drain(f);
  assert.equal(f.requests.length, 1);
  await search(f, 'sclad_detail_catno', 'CAT-NEW');
  assert.equal(f.requests.length, 2);
  f.release(f.requests[1]); await drain(f);
  f.release(f.requests[0]); await drain(f);
  assert.equal(f.value('sclad_detail_catno'), 'CAT-NEW');
  assert.ok(f.items('sclad_part_dd').every(item => !item.textContent.includes('CAT-OLD')));
  assert.ok(f.items('sclad_part_dd').some(item => item.textContent.includes('CAT-NEW')));
});

test('an in-flight full position cannot overwrite typing, manual edits, reset, another actor or changed stock', async t => {
  const scenarios = {
    'catalog typing': f => f.input('sclad_detail_catno', 'MANUAL-CAT'),
    'detail typing': f => f.input('sclad_detail', 'Власна назва'),
    'manual price': f => f.input('sclad_price', '123.45'),
    'manual quantity': f => f.input('sclad_qty_in', '9'),
    'manual invoice': f => f.input('sclad_invoice_no', 'MANUAL-INVOICE'),
    'manual shop': f => f.input('sclad_shop', 'Власний магазин'),
    'same-name employee with another ID': f => { f.fields.get('sclad_zapchastyst_pib').dataset.slyusarId = '22'; },
    'clear form': f => f.api.clearScladForm(),
    'clear then restore the same field values': f => {
      const previous = [...f.fields].map(([id, field]) => [id, field.value]);
      f.api.clearScladForm();
      for (const [id, value] of previous) f.fields.get(id).value = value;
    },
    'new modal session': f => f.api.resetScladFormSession(),
    'changed actor': f => f.actor('actor-two'),
    'stock revision': f => f.revise(),
  };
  for (const [name, mutate] of Object.entries(scenarios)) await t.test(name, async () => {
    const f = fixture(), row = position(); f.serve([row]); f.hold('traffic_stock_position'); await mount(f);
    await search(f, 'sclad_detail_catno', '80B');
    chooseText(f, 'sclad_part_dd', row.part_number); await drain(f);
    const pending = f.requests.find(request => request.kind === 'traffic_stock_position');
    assert.ok(pending);
    mutate(f);
    const values = [...f.fields].map(([id, field]) => [id, field.value]);
    f.release(pending); await drain(f);
    assert.equal(f.api.getCurrentScladId(), null, 'A stale position must not install an editable row ID');
    assert.equal(f.api.getOriginalScladRecord(), null, 'A stale position must not install a CAS baseline');
    for (const [id, value] of values) assert.equal(f.value(id), value, id);
  });
});

test('a late linked-candidate reply cannot reopen the menu or replace manually changed fields', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => position({ sclad_id: 100 + index, rahunok: 'INV-' + index }));
  const f = fixture(); f.serve(rows); await mount(f);
  await search(f, 'sclad_detail_catno', '80B'); f.hold('stock');
  chooseText(f, 'sclad_part_dd', rows[0].part_number); await drain(f);
  const request = f.requests.at(-1);
  assert.equal(request.kind, 'stock');
  f.input('sclad_invoice_no', 'MANUAL');
  f.release(request); await drain(f);
  assert.equal(f.value('sclad_invoice_no'), 'MANUAL');
  assert.equal(f.api.getCurrentScladId(), null);
  assert.equal(f.visible('sclad_detail_dd'), false);
  assert.equal(f.requests.some(row => row.kind === 'traffic_stock_position'), false);
});

test('literal wildcard characters in catalog search do not broaden a query to other rows', async () => {
  const a = position({ part_number: 'A%_100' }), b = position({ sclad_id: 8, part_number: 'ABC100' });
  const f = fixture(); f.serve([a, b]); await mount(f);
  await search(f, 'sclad_detail_catno', 'A%_');
  assert.equal(f.items('sclad_part_dd').length, 1);
  assert.ok(f.items('sclad_part_dd')[0].textContent.includes(a.part_number));
  chooseText(f, 'sclad_part_dd', a.part_number); await drain(f);
  assertFilled(f, a);
});

test('lazy scrolling retrieves only the next linked page and can select a receipt outside the first page', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => position({ sclad_id: 100 + index, rahunok: 'INVOICE-' + index }));
  rows[0].name = 'Назва з наступної сторінки';
  const f = fixture(); f.serve(rows); await mount(f);
  await search(f, 'sclad_detail_catno', '80B');
  chooseText(f, 'sclad_part_dd', rows[0].part_number); await drain(f);
  const count = f.requests.length;
  assert.equal(f.items('sclad_detail_dd').length, 20);
  f.scrollBottom('sclad_detail_dd'); await drain(f);
  assert.equal(f.requests.length, count + 1);
  assert.deepEqual(f.requests.at(-1).args.range, [20, 40]);
  assert.ok(f.requests.at(-1).args.filters.some(([, field, value]) => field === 'part_number' && value === rows[0].part_number));
  assert.equal(f.items('sclad_detail_dd').length, 25);
  chooseText(f, 'sclad_detail_dd', rows[0].name); await drain(f);
  assertFilled(f, rows[0]);
});

test('replacing a previously filled receipt with an ambiguous source cannot leave its old payable values', async () => {
  const old = position({ part_number: 'OLD', name: 'Стара деталь' });
  const a = position({ sclad_id: 8, part_number: 'NEW', name: 'Нова ліва' });
  const b = position({ sclad_id: 9, part_number: 'NEW', name: 'Нова права' });
  const f = fixture(); f.serve([old, a, b]); await mount(f);
  await search(f, 'sclad_detail_catno', 'OLD'); chooseText(f, 'sclad_part_dd', 'OLD'); await drain(f);
  assertFilled(f, old);
  await search(f, 'sclad_detail_catno', 'NEW'); chooseText(f, 'sclad_part_dd', 'NEW'); await drain(f);
  assert.equal(f.api.getCurrentScladId(), null);
  assert.equal(f.api.getOriginalScladRecord(), null);
  assert.equal(f.value('sclad_qty_in'), '', 'Previous quantity cannot be submitted for an unresolved receipt');
  assert.equal(f.value('sclad_price'), '', 'Previous price cannot be submitted for an unresolved receipt');
  assert.equal(f.value('sclad_sum'), '');
  chooseText(f, 'sclad_detail_dd', b.name); await drain(f);
  assertFilled(f, b);
});

test('pending or failed replacement selection cannot submit values from a previously filled receipt', async () => {
  const old = position({ part_number: 'OLD' }), row = position({ sclad_id: 8, part_number: 'NEW' });
  const f = fixture(); f.serve([old, row]); await mount(f);
  await search(f, 'sclad_detail_catno', 'OLD'); chooseText(f, 'sclad_part_dd', 'OLD'); await drain(f);
  assertFilled(f, old);
  f.hold('traffic_stock_position');
  await search(f, 'sclad_detail_catno', 'NEW'); chooseText(f, 'sclad_part_dd', 'NEW'); await drain(f);
  assert.equal(f.api.getCurrentScladId(), null);
  assert.equal(f.value('sclad_qty_in'), ''); assert.equal(f.value('sclad_price'), '');
  f.requests.at(-1).reject(new Error('Transport failed')); await drain(f);
  assert.equal(f.api.getCurrentScladId(), null);
  assert.equal(f.api.getOriginalScladRecord(), null);
  assert.equal(f.value('sclad_qty_in'), ''); assert.equal(f.value('sclad_price'), '');
  assert.equal(f.value('sclad_sum'), '');
  assert.match(f.fields.get('sclad_part_dd').textContent, /Не вдалося/);
});

