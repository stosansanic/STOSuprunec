const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const flush = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor(tag, doc) {
    this.tagName = tag; this.doc = doc; this.children = []; this.listeners = {}; this.style = {};
    this.attributes = {}; this.disabled = false; this.hidden = false; this.value = ''; this.isConnected = false;
    this.classList = { add() {} };
  }
  append(...items) { for (const item of items) { item.parent = this; item.isConnected = true; this.children.push(item); } }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
  contains(item) { return item === this || this.children.some(child => child.contains(item)); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { (this.listeners[name] ??= new Set()).add(fn); }
  removeEventListener(name, fn) { this.listeners[name]?.delete(fn); }
  emit(name, extra = {}) { for (const fn of this.listeners[name] ?? []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...extra }); }
  focus() { this.doc.activeElement = this; }
  select() { this.selected = true; }
  click() { this.emit('click'); }
}
function harness() {
  const doc = new Element('document'); doc.doc = doc; doc.body = new Element('body', doc);
  doc.createElement = tag => new Element(tag, doc);
  const win = new Element('window', doc);
  let owner = 'actor-a', actor = { name: 'Worker', access: 'admin', slyusar_id: 12 };
  const calls = [], timers = new Map(); let timerId = 0;
  const supabase = { rpc(name, args) {
    const call = { name, args };
    const response = new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
    response.abortSignal = signal => { call.signal = signal; return response; };
    calls.push(call); return response;
  } };
  const deps = {
    '../../vxid/supabaseClient': { supabase },
    '../tablucya/users': { getSavedUserDataFromLocalStorage: () => actor },
  };
  const context = { exports: {}, require: key => { assert.ok(key in deps, key); return deps[key]; },
    document: doc, window: win, localStorage: { getItem: () => owner }, AbortController,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/bukhhalteriya/accountingPaymentConfirmation.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
  const find = predicate => descendants(doc.body).find(predicate);
  return { api: context.exports, doc, win, calls, timers,
    input: () => find(e => e.tagName === 'input'),
    confirm: () => find(e => e.tagName === 'button' && e.textContent !== 'Скасувати'),
    cancel: () => find(e => e.tagName === 'button' && e.textContent === 'Скасувати'),
    error: () => find(e => e.className === 'login-error-message'),
    actor: value => { actor = value; }, owner: value => { owner = value; },
    enter() { doc.emit('keydown', { key: 'Enter', target: this.input() }); },
  };
}

test('opening/cancelling does not read the database and restores focus', async () => {
  const h = harness(); const previous = new Element('button', h.doc); previous.isConnected = true; previous.focus();
  const result = h.api.confirmAccountingPayment('pay', '3 завантажені позиції');
  assert.equal(h.calls.length, 0); assert.equal(h.api.isAccountingPaymentBusy(), true);
  h.cancel().click(); assert.equal(await result, false);
  assert.equal(h.calls.length, 0); assert.equal(h.doc.body.children.length, 0);
  assert.equal(h.doc.activeElement, previous); assert.equal(h.api.isAccountingPaymentBusy(), false);
  assert.equal(h.doc.listeners.keydown.size, 0); assert.equal(h.win.listeners.storage.size, 0);
});
test('empty password does not issue a query', async () => {
  const h = harness(), result = h.api.confirmAccountingPayment('pay');
  h.confirm().click(); h.enter(); assert.equal(h.calls.length, 0); assert.equal(h.error().hidden, false);
  h.cancel().click(); await result;
});
test('double click and repeated Enter share one pending password check', async () => {
  const h = harness(), result = h.api.confirmAccountingPayment('pay'); h.input().value = 'secret';
  h.confirm().click(); h.confirm().click(); h.enter();
  assert.equal(h.calls.length, 1); assert.equal(h.confirm().disabled, true);
  assert.deepEqual({ ...h.calls[0].args }, { input_slyusar_id: 12, input_password: 'secret' });
  h.calls[0].resolve({ data: true, error: null }); assert.equal(await result, true);
  assert.equal(h.doc.body.children.length, 0); assert.equal(h.timers.size, 0);
});
test('wrong password can be retried explicitly; no automatic retries', async () => {
  const h = harness(), result = h.api.confirmAccountingPayment('pay'); h.input().value = 'wrong'; h.enter();
  h.calls[0].resolve({ data: false }); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.confirm().disabled, false); assert.match(h.error().textContent, /Невірний пароль/);
  h.input().value = 'right'; h.enter(); assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ data: true }); assert.equal(await result, true);
});
test('cancel aborts validation and ignores a late successful response', async () => {
  const h = harness(), result = h.api.confirmAccountingPayment('unpay'); h.input().value = 'secret'; h.enter();
  const input = h.input(); h.cancel().click(); assert.equal(await result, false); assert.equal(input.value, '');
  assert.equal(h.calls[0].signal.aborted, true);
  const next = h.api.confirmAccountingPayment('pay'); h.calls[0].resolve({ data: true }); await flush();
  assert.equal(h.doc.body.children.length, 1); assert.equal(h.api.isAccountingPaymentBusy(), true);
  h.cancel().click(); assert.equal(await next, false);
});
test('only one modal exists across accounting tabs', async () => {
  const h = harness(), first = h.api.confirmAccountingPayment('pay');
  assert.equal(await h.api.confirmAccountingPayment('unpay'), false); assert.equal(h.doc.body.children.length, 1);
  h.cancel().click(); assert.equal(await first, false);
});
test('actor change while verifying invalidates confirmation', async () => {
  const h = harness(), result = h.api.confirmAccountingPayment('pay'); h.input().value = 'secret'; h.enter();
  h.owner('actor-b'); h.actor({ name: 'Other', access: 'admin', slyusar_id: 17 });
  h.calls[0].resolve({ data: true }); assert.equal(await result, false);
});
test('filter or selection change during password check invalidates confirmation', async () => {
  const h = harness(); let current = true;
  const result = h.api.confirmAccountingPayment('pay', '2 позиції', () => current);
  h.input().value = 'secret'; h.enter(); current = false; h.calls[0].resolve({ data: true });
  assert.equal(await result, false);
});
test('stale selection and missing actor are rejected without opening or queries', async () => {
  const h = harness(); assert.equal(await h.api.confirmAccountingPayment('pay', '', () => false), false);
  h.actor(null); assert.equal(await h.api.confirmAccountingPayment('pay'), false);
  assert.equal(h.doc.body.children.length, 0); assert.equal(h.calls.length, 0);
});
test('cross-tab logout and Escape settle once and clean listeners', async () => {
  const h = harness(), first = h.api.confirmAccountingPayment('pay');
  h.win.emit('storage', { key: 'userAuthData' }); assert.equal(await first, false);
  const second = h.api.confirmAccountingPayment('pay'); h.doc.emit('keydown', { key: 'Escape' });
  assert.equal(await second, false); assert.equal(h.doc.listeners.keydown.size, 0);
});
test('network failure retains dialog for explicit retry and never approves', async () => {
  const h = harness(), result = h.api.confirmAccountingPayment('pay'); h.input().value = 'secret'; h.enter();
  h.calls[0].reject(new Error('offline')); await flush();
  assert.equal(h.confirm().disabled, false); assert.match(h.error().textContent, /Не вдалося/);
  assert.equal(h.calls.length, 1); h.cancel().click(); assert.equal(await result, false);
});
test('verification has a bounded timeout and abort signal', async () => {
  const h = harness(), result = h.api.confirmAccountingPayment('pay'); h.input().value = 'secret'; h.enter();
  const timer = [...h.timers.values()][0]; assert.equal(timer.ms, 20000); timer.fn();
  assert.equal(h.calls[0].signal.aborted, true); h.calls[0].resolve({ error: { message: 'AbortError' } }); await flush();
  assert.equal(h.calls.length, 1); h.cancel().click(); assert.equal(await result, false);
});
test('global operation lock covers confirmation and saving and releases after errors', async () => {
  const h = harness(); let release, calls = 0;
  const first = h.api.withAccountingPaymentOperation(async () => { calls++; await new Promise(resolve => release = resolve); });
  await h.api.withAccountingPaymentOperation(async () => calls++); assert.equal(calls, 1);
  release(); await first; assert.equal(h.api.isAccountingPaymentBusy(), false);
  await assert.rejects(h.api.withAccountingPaymentOperation(async () => { throw Error('conflict'); }), /conflict/);
  assert.equal(h.api.isAccountingPaymentBusy(), false);
  await h.api.withAccountingPaymentOperation(async () => calls++); assert.equal(calls, 2);
});
