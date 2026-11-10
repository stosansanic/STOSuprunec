const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function fixture() {
  let employee = 'employee-a', value = true, fail = false, hold = false, auth;
  const calls = [], held = [], listeners = {};
  const item = { hidden: true };
  const client = {
    auth: { onAuthStateChange(callback) { auth = callback; } },
    from(table) {
      let operation = 'read';
      const query = {
        select(columns) { calls.push({ table, columns, operation }); return query; },
        eq() { return query; },
        update() { operation = 'update'; calls.push({ table, operation }); return query; },
        async insert() { calls.push({ table, operation: 'insert' }); return { error: fail ? new Error('write failed') : null }; },
        maybeSingle() {
          const answer = { data: value === undefined ? null : { data: value, Приймальник: value, setting_id: 11 }, error: fail ? new Error('read failed') : null };
          return hold ? new Promise(resolve => held.push(() => resolve(answer))) : Promise.resolve(answer);
        },
        then(resolve, reject) { return Promise.resolve({ error: fail ? new Error('write failed') : null }).then(resolve, reject); },
      };
      return query;
    },
  };
  const exports = {};
  const context = {
    exports, require: () => ({ supabase: client }),
    localStorage: { getItem: () => employee },
    window: { addEventListener(name, callback) { (listeners[name] ??= []).push(callback); }, dispatchEvent() {} },
    document: { getElementById: () => item }, Event: class {}, console,
  };
  const source = fs.readFileSync('src/ts/utils/novaPoshtaMenu.ts', 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return {
    api: exports, calls, held, item,
    value(v) { value = v; }, employee(v) { employee = v; }, hold(v) { hold = v; }, fail(v) { fail = v; },
    auth(event, user) { auth(event, user ? { user: { id: user } } : null); },
    event(name, payload = {}) { for (const callback of listeners[name] ?? []) callback(payload); },
  };
}

test('NP visibility coalesces concurrent reads and reuses one scalar across 100 act opens', async () => {
  const f = fixture(); f.hold(true);
  const reads = Array.from({ length: 100 }, () => f.api.readNovaPoshtaSetting('Адміністратор'));
  assert.equal(f.calls.length, 1); f.held.shift()();
  assert.ok((await Promise.all(reads)).every(Boolean));
  for (let i = 0; i < 100; i++) assert.equal(await f.api.readNovaPoshtaSetting('Адміністратор'), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].columns, '"data"');
});

test('NP visibility preserves disabled/missing defaults and unsupported role has no request', async () => {
  const f = fixture();
  assert.equal(await f.api.readNovaPoshtaSetting('Слюсар'), false); assert.equal(f.calls.length, 0);
  f.value(false); assert.equal(await f.api.readNovaPoshtaSetting('Приймальник'), false);
  f.api.invalidateNovaPoshtaSettingCache(); f.value(null);
  assert.equal(await f.api.readNovaPoshtaSetting('Приймальник'), true);
});

test('Realtime visibility wins over in-flight read and clearing a toggle preserves default', async () => {
  const f = fixture(); f.hold(true);
  const read = f.api.readNovaPoshtaSetting('Адміністратор');
  f.api.syncNovaPoshtaSetting({ setting_id: 11, data: false });
  f.held.shift()(); assert.equal(await read, false);
  assert.equal(await f.api.readNovaPoshtaSetting('Адміністратор'), false);
  f.api.syncNovaPoshtaSetting({ setting_id: 11, data: null });
  assert.equal(await f.api.readNovaPoshtaSetting('Адміністратор'), true);
  assert.equal(f.calls.length, 1);
});

test('employee switch rejects old response and isolates visibility cache', async () => {
  const f = fixture(); f.hold(true);
  const old = f.api.readNovaPoshtaSetting('Адміністратор');
  f.employee('employee-b'); f.value(false);
  const fresh = f.api.readNovaPoshtaSetting('Адміністратор');
  const rejection = assert.rejects(old, /Користувач змінився/);
  f.held.shift()(); await rejection;
  f.held.shift()(); assert.equal(await fresh, false);
  assert.equal(await f.api.readNovaPoshtaSetting('Адміністратор'), false);
  assert.equal(f.calls.length, 2);
});

test('another role toggle does not discard a pending visibility read', async () => {
  const f = fixture(); f.hold(true);
  const admin = f.api.readNovaPoshtaSetting('Адміністратор');
  f.api.syncNovaPoshtaSetting({ setting_id: 25, Приймальник: false });
  const sameAdmin = f.api.readNovaPoshtaSetting('Адміністратор');
  assert.equal(f.calls.length, 1);
  f.held.shift()();
  assert.equal(await admin, true); assert.equal(await sameAdmin, true);
  assert.equal(await f.api.readNovaPoshtaSetting('Приймальник'), false);
  assert.equal(f.calls.length, 1);
});

test('auth, reconnect and persisted page restore invalidate without making requests', async () => {
  const f = fixture(); f.auth('INITIAL_SESSION', 'google-a');
  await f.api.readNovaPoshtaSetting('Адміністратор');
  f.auth('TOKEN_REFRESHED', 'google-a');
  await f.api.readNovaPoshtaSetting('Адміністратор'); assert.equal(f.calls.length, 1);
  for (const invalidate of [
    () => f.auth('SIGNED_OUT', null),
    () => f.auth('SIGNED_IN', 'google-b'),
    () => f.event('online'),
    () => f.event('pageshow', { persisted: true }),
    () => f.event('storage', { key: 'userAuthData' }),
  ]) {
    const before = f.calls.length; invalidate(); assert.equal(f.calls.length, before);
    await f.api.readNovaPoshtaSetting('Адміністратор'); assert.equal(f.calls.length, before + 1);
  }
});

test('failed reads are retryable and local successful writes update scalar cache', async () => {
  const f = fixture(); f.fail(true);
  await assert.rejects(f.api.readNovaPoshtaSetting('Адміністратор'), /read failed/);
  f.fail(false); await f.api.readNovaPoshtaSetting('Адміністратор');
  await f.api.saveNovaPoshtaSetting('Адміністратор', false);
  const before = f.calls.length;
  assert.equal(await f.api.readNovaPoshtaSetting('Адміністратор'), false);
  assert.equal(f.calls.length, before);
  f.fail(true); await assert.rejects(f.api.saveNovaPoshtaSetting('Адміністратор', true));
  assert.equal(await f.api.readNovaPoshtaSetting('Адміністратор'), false);
});
