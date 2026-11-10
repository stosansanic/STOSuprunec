const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag = 'input') {
    this.tag = tag; this.children = []; this.handlers = {}; this.attributes = {}; this.style = {};
    this.dataset = {}; this.value = ''; this.isConnected = true; this.disabled = false; this.readOnly = false;
    this.scrollHeight = 400; this.clientHeight = 100; this.scrollTop = 0; this.id = tag; this.parentElement = null;
  }
  addEventListener(name, fn, options = {}) {
    (this.handlers[name] ||= []).push(fn);
    options.signal?.addEventListener('abort', () => { this.handlers[name] = this.handlers[name].filter(x => x !== fn); }, { once: true });
  }
  dispatch(name, extra = {}) {
    for (const fn of [...(this.handlers[name] || [])]) fn({ preventDefault() {}, stopImmediatePropagation() {}, ...extra });
  }
  click() { this.dispatch('click'); }
  append(child) { child.parentElement = this; this.children.push(child); }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; children.forEach(child => this.append(child)); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  querySelectorAll(selector) { return this.children.filter(x => selector === '[data-form-options-status]' ? x.dataset.formOptionsStatus !== undefined : x.attributes.role === 'option'); }
  scrollIntoView() {}
}
function harness(overrides = {}) {
  const exports = {}, input = new Element(), list = new Element('ul');
  const selected = [], errors = [], calls = [], timers = new Map(), frames = new Map(); let timerId = 0, frameId = 0;
  const document = { activeElement: input, createElement: tag => new Element(tag) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/redahyvatu_klient_machuna/clientFormDropdown.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    exports, AbortController, document, HTMLTextAreaElement: class extends Element {},
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
  });
  const options = {
    input, list, items: [], label: item => item.label, showOnFocus: true,
    onSelect: item => selected.push(item), onError: error => errors.push(error),
    loadPage: (query, after) => new Promise((resolve, reject) => calls.push({ query, after, resolve, reject })), ...overrides,
  };
  const controller = exports.mountClientFormDropdown(options);
  return {
    input, list, calls, selected, errors, controller, document,
    choices: () => list.children.filter(x => x.attributes.role === 'option'),
    runTimers: () => { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); },
    runFrames: () => { const work = [...frames.values()]; frames.clear(); work.forEach(fn => fn()); },
  };
}
const page = (items, has_more = false, next_cursor = null) => ({ items, has_more, next_cursor });

test('focus followed by click shares one remote request and mounts no eager request', async () => {
  const h = harness(); assert.equal(h.calls.length, 0);
  h.input.dispatch('focus'); h.input.click(); assert.equal(h.calls.length, 1);
  h.calls[0].resolve(page([{ label: 'One' }])); await tick(); assert.equal(h.choices().length, 1);
});

test('scroll loads exactly one next page while a request is pending', async () => {
  const h = harness(); h.input.dispatch('focus'); h.calls[0].resolve(page([{ label: 'One' }], true, 20)); await tick();
  h.list.scrollTop = 300; h.list.dispatch('scroll'); h.list.dispatch('scroll');
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].after, 20);
  h.calls[1].resolve(page([{ label: 'Two' }])); await tick();
  assert.equal(h.choices().length, 2);
});

test('closed dropdown cannot be repopulated by its old pending result', async () => {
  const h = harness(); h.input.dispatch('focus'); h.controller.close();
  h.calls[0].resolve(page([{ label: 'Old' }])); await tick(); assert.equal(h.choices().length, 0);
});

test('detached old choices cannot select after the same dropdown reopens', async () => {
  const h = harness(); h.input.dispatch('focus'); h.calls[0].resolve(page([{ label: 'Old' }])); await tick();
  const old = h.choices()[0]; h.controller.close(); h.input.dispatch('focus');
  h.calls[1].resolve(page([{ label: 'New' }])); await tick();
  old.click(); assert.equal(h.selected.length, 0); assert.equal(h.input.value, '');
  h.choices()[0].click(); assert.equal(h.selected.length, 1); assert.equal(h.input.value, 'New');
});

test('disabled and readonly inputs never load or select remote choices', async () => {
  const h = harness(); h.input.disabled = true; h.input.dispatch('focus'); assert.equal(h.calls.length, 0);
  h.input.disabled = false; h.input.readOnly = true; h.input.dispatch('focus'); assert.equal(h.calls.length, 0);
  h.input.readOnly = false; h.input.dispatch('focus'); h.calls[0].resolve(page([{ label: 'One' }])); await tick();
  h.input.disabled = true; h.choices()[0].click(); assert.equal(h.selected.length, 0);
});

test('typing debounces remote work and cancels pending debounce on escape', async () => {
  const h = harness({ showOnFocus: false, minLength: 2 });
  h.input.value = 'a'; h.input.dispatch('input'); h.input.value = 'ab'; h.input.dispatch('input');
  h.runTimers(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].query, 'ab');
  h.input.value = 'abc'; h.input.dispatch('input'); h.input.dispatch('keydown', { key: 'Escape' }); h.runTimers(); assert.equal(h.calls.length, 1);
  h.calls[0].resolve(page([{ label: 'Old' }])); await tick(); assert.equal(h.choices().length, 0);
});

test('late selection failures cannot show an error in a new query', async () => {
  let rejectSelection; const h = harness({ onSelect: () => new Promise((_resolve, reject) => rejectSelection = reject) });
  h.input.dispatch('focus'); h.calls[0].resolve(page([{ label: 'One' }])); await tick(); h.choices()[0].click();
  h.input.dispatch('focus'); rejectSelection(Error('old error')); await tick(); assert.equal(h.errors.length, 0);
  h.calls[1].resolve(page([])); await tick();
});

test('current selection failures remain visible and cannot silently fail', async () => {
  const h = harness({ onSelect: async () => { throw Error('selection failed'); } });
  h.input.dispatch('focus'); h.calls[0].resolve(page([{ label: 'One' }])); await tick(); h.choices()[0].click(); await tick();
  assert.equal(h.errors.length, 1); assert.match(h.errors[0].message, /selection failed/);
});

test('a duplicate-only page does not drain the remote catalogue automatically', async () => {
  const h = harness({ deduplicate: true, items: [{ label: 'One' }] });
  h.list.scrollHeight = 40; h.list.clientHeight = 100;
  h.input.dispatch('focus'); h.calls[0].resolve(page([{ label: 'One' }], true, 20)); await tick(); h.runFrames();
  assert.equal(h.calls.length, 2); // One viewport fill after the initial local item.
  h.calls[1].resolve(page([{ label: 'One' }], true, 40)); await tick(); h.runFrames();
  assert.equal(h.calls.length, 2); assert.equal(h.choices().length, 1);
});

test('nonprogressing remote continuation is rejected without an automatic request loop', async () => {
  const h = harness(); h.input.dispatch('focus'); h.calls[0].resolve(page([{ label: 'One' }], true, 0)); await tick();
  assert.equal(h.choices().length, 0); assert.match(h.list.children[0].textContent, /Некоректна/);
  h.list.scrollTop = 300; h.list.dispatch('scroll'); h.runFrames(); assert.equal(h.calls.length, 1);
});

test('failed read retries on click without duplicate list items', async () => {
  const h = harness(); h.input.dispatch('focus'); h.calls[0].reject(Error('offline')); await tick();
  h.input.click(); assert.equal(h.calls.length, 2); h.calls[1].resolve(page([{ label: 'One' }])); await tick();
  assert.equal(h.choices().length, 1);
});

test('changing actor prevents response rendering and old option selection', async () => {
  let active = true; const h = harness({ isCurrent: () => active });
  h.input.dispatch('focus'); h.calls[0].resolve(page([{ label: 'One' }])); await tick(); const old = h.choices()[0];
  active = false; old.click(); assert.equal(h.selected.length, 0);
  h.controller.close(); h.input.dispatch('focus'); assert.equal(h.calls.length, 1);
});

test('keyboard enter selects once and does not restart a network search', async () => {
  const h = harness(); h.input.dispatch('focus'); h.calls[0].resolve(page([{ label: 'One' }])); await tick();
  h.input.dispatch('keydown', { key: 'ArrowDown' }); h.input.dispatch('keydown', { key: 'Enter' });
  assert.equal(h.selected.length, 1); assert.equal(h.calls.length, 1);
});

test('dispose removes handlers and clears pending debounce plus accessible state', async () => {
  const h = harness(); h.input.value = 'value'; h.input.dispatch('input'); h.controller.dispose(); h.runTimers();
  h.input.dispatch('focus'); assert.equal(h.calls.length, 0); assert.equal(h.input.getAttribute('aria-controls'), null);
});

test('identical client names remain distinct selectable records', async () => {
  const h = harness(); h.input.dispatch('focus'); h.calls[0].resolve(page([{ id: 1, label: 'Іван' }, { id: 2, label: 'Іван' }])); await tick();
  assert.equal(h.choices().length, 2); h.choices()[1].click(); assert.equal(h.selected[0].id, 2);
});

test('selection errors remain visible when the form synchronously closes all dropdowns', async () => {
  let rejectSelection, h;
  h = harness({ onSelect: () => { h.controller.close(); return new Promise((_resolve, reject) => rejectSelection = reject); } });
  h.input.dispatch('focus'); h.calls[0].resolve(page([{ label: 'One' }])); await tick(); h.choices()[0].click();
  rejectSelection(Error('current selected record unavailable')); await tick();
  assert.equal(h.errors.length, 1); assert.match(h.errors[0].message, /record unavailable/);
});
