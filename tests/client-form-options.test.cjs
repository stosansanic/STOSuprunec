const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function repository(rpc, scope, rpcName) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/redahyvatu_klient_machuna/clientFormOptions.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports, require: () => ({ supabase: { rpc } }) });
  return exports.createClientFormOptions(scope, rpcName);
}
const response = (items, has_more = false) => ({ data: { items, has_more, next_cursor: items.length ? Number(items.at(-1).id) : null }, error: null });
const page = (id, extra = {}) => response([{ id, ...extra }]);

test('form shares identical pending queries and keeps client/cursor scopes separate', async () => {
  const calls = []; let finish;
  const r = repository(async (_name, args) => { calls.push(args); if (calls.length === 1) return new Promise(resolve => finish = resolve); return page((args.p_after || 0) + 1); });
  const a = r.read('carModel', 'a', null, null), b = r.read('carModel', 'a', null, null);
  assert.equal(calls.length, 1); finish(page(1)); assert.equal(await a, await b);
  await r.read('carModel', 'a', null, null); assert.equal(calls.length, 1);
  await r.read('carModel', 'a', 20, null); await r.read('carModel', 'a', null, '9'); assert.equal(calls.length, 2);
  // The completed first result can also answer a later cursor without network.
  assert.equal(calls[1].p_client, '9');
});

test('old form response cannot refill the cache after invalidation', async () => {
  const resolves = []; const r = repository(() => new Promise(resolve => resolves.push(resolve)));
  const old = r.read('client', 'a', null, null); r.clear(); const fresh = r.read('client', 'a', null, null);
  resolves[1](page(2)); const value = await fresh; resolves[0](page(1)); await assert.rejects(old, /Дані форми змінилися/);
  assert.equal(await r.read('client', 'a', null, null), value);
});

test('errors are retryable; missing migration has explicit instruction, no broad fallback', async () => {
  let calls = 0; const r = repository(async () => ++calls === 1 ? { error: { code: 'PGRST202' } } : page(1));
  await assert.rejects(r.read('client', '', null, null), /SQL/);
  assert.equal((await r.read('client', '', null, null)).items.length, 1);
  assert.equal(calls, 2);
});

test('broken continuation and malformed responses are rejected', async () => {
  const r = repository(async () => ({ data: { items: [], has_more: true, next_cursor: 20 } }));
  await assert.rejects(r.read('client', '', 20, null), /сторінка/);
});

test('client scope retains exact bigint ID rather than rounding through Number', async () => {
  let args; const r = repository(async (_name, input) => { args = input; return page(1); });
  await r.read('carModel', '', null, '9007199254740993123');
  assert.equal(args.p_client, '9007199254740993123');
});

test('detail cache and pending are isolated by actor and invalidation', async () => {
  let actor = 'one', calls = 0, finish; const r = repository(async () => page(1), () => actor);
  const read = () => { calls++; return new Promise(resolve => finish = resolve); };
  const a = r.readEntity('client', '1', read), b = r.readEntity('client', '1', read); assert.equal(calls, 1); finish({ name: 'one' }); await a; await b;
  await r.readEntity('client', '1', read); assert.equal(calls, 1);
  actor = 'two'; const next = r.readEntity('client', '1', read); assert.equal(calls, 2); finish({ name: 'two' }); await next;
  r.clear(); const stale = r.readEntity('client', '1', read); actor = 'three'; finish({ name: 'old' }); await assert.rejects(stale);
});

test('complete client results answer narrowed queries locally without another request', async () => {
  let calls = 0; const r = repository(async () => { calls++; return response([{ id: 1, fullName: 'Іван Петренко' }, { id: 2, fullName: 'Іваненко' }]); });
  await r.read('client', 'Іва', null, null);
  const narrowed = await r.read('client', 'Іван П', null, null);
  assert.equal(calls, 1); assert.equal(narrowed.items.length, 1); assert.equal(narrowed.items[0].id, 1);
});

test('complete phone results preserve alternate phones during local narrowing', async () => {
  let calls = 0; const r = repository(async () => { calls++; return page(1, { phone: '+380 (67) 123-45-67', phones: ['+380 (67) 123-45-67', '+380 (99) 654-32-10'] }); });
  await r.read('phone', '+38', null, null);
  const narrowed = await r.read('phone', '+380 (99)', null, null);
  assert.equal(calls, 1); assert.equal(narrowed.items[0].phone, '+380 (99) 654-32-10');
});

test('incomplete results are not treated as all possible matches', async () => {
  let calls = 0; const r = repository(async () => { calls++; return calls === 1 ? response([{ id: 1, fullName: 'Alpha' }], true) : page(22, { fullName: 'Alice' }); });
  await r.read('client', 'a', null, null);
  const narrowed = await r.read('client', 'ali', null, null);
  assert.equal(calls, 2); assert.equal(narrowed.items[0].id, 22);
});

test('an orphan final page cannot make a search complete', async () => {
  let calls = 0; const r = repository(async (_name, args) => { calls++; return page((args.p_after || 0) + 1, { fullName: 'Alpha' }); });
  await r.read('client', 'a', 20, null);
  await r.read('client', 'al', null, null);
  assert.equal(calls, 2);
});

test('all contiguous pages allow cached lazy narrowing with the same 20 row limit', async () => {
  let calls = 0; const r = repository(async (_name, args) => {
    calls++; const after = args.p_after || 0;
    return response(Array.from({ length: 20 }, (_, index) => ({ id: after + index + 1, fullName: 'Alpha ' + index })), after === 0);
  });
  await r.read('client', 'a', null, null); await r.read('client', 'a', 20, null);
  const first = await r.read('client', 'al', null, null), second = await r.read('client', 'al', 20, null);
  assert.equal(calls, 2); assert.equal(first.items.length, 20); assert.equal(first.has_more, true);
  assert.equal(second.items.length, 20); assert.equal(second.has_more, false);
});

test('VIN restore skips empty requests, ignores owner and caches normalized exact VIN only', async () => {
  const calls = []; const r = repository(async (name, args) => { calls.push({ name, ...args }); return page(1, { label: 'AB 12-CD', is_deleted: true }); });
  const empty = await r.read('carVinRestore', '  ', null, '3'); assert.equal(empty.items.length, 0); assert.equal(calls.length, 0);
  const first = await r.read('carVinRestore', 'ab 12-cd', null, '3');
  assert.equal(first.items[0].is_deleted, true); assert.equal(calls[0].p_client, undefined); assert.equal(calls[0].name, 'traffic_client_car_vin_option'); assert.equal(calls[0].p_query, 'ab12-cd');
  await r.read('carVinRestore', 'AB12-CD', null, '4'); assert.equal(calls.length, 1);
  await r.read('carVinRestore', 'AB12CD', null, '4'); assert.equal(calls.length, 2);
});

test('an unmatched VIN prefix does not hide a later exact deleted VIN', async () => {
  let calls = 0; const r = repository(async (_name, args) => { calls++; return args.p_query === 'abc123' ? page(7, { label: 'ABC 123', is_deleted: true }) : response([]); });
  await r.read('carVinRestore', 'abc', null, '5');
  const result = await r.read('carVinRestore', 'abc123', null, '5');
  assert.equal(calls, 2); assert.equal(result.items[0].id, 7);
});

test('VIN exact result can answer a continuation without losing formatted label matches', async () => {
  let calls = 0; const r = repository(async () => { calls++; return page(7, { label: 'ABC 123' }); });
  await r.read('carVinRestore', 'abc123', null, null);
  const result = await r.read('carVinRestore', 'abc123', 1, null);
  assert.equal(calls, 1); assert.equal(result.items[0].id, 7);
});

test('cache capacity evicts old entries while keeping recently reused details', async () => {
  let calls = 0; const r = repository(async () => response([]));
  const read = id => r.readEntity('client', String(id), async () => { calls++; return { id }; });
  for (let id = 0; id < 128; id++) await read(id);
  await read(0); await read(128); assert.equal(calls, 129);
  await read(0); assert.equal(calls, 129);
  await read(1); assert.equal(calls, 130);
});

test('very long paged searches stay bounded and cannot be mistaken for a complete catalogue', async () => {
  let calls = 0; const r = repository(async (_name, args) => {
    calls++; const after = args.p_after || 0;
    return response(Array.from({ length: 20 }, (_, index) => ({ id: after + index + 1, fullName: 'Alpha' })), after < 320);
  });
  for (let after = 0; after <= 320; after += 20) await r.read('client', 'a', after || null, null);
  await r.read('client', 'al', null, null); assert.equal(calls, 18);
});

test('invalid cursor inputs are rejected before querying the database', async () => {
  let calls = 0; const r = repository(async () => { calls++; return response([]); });
  for (const cursor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '12']) await assert.rejects(r.read('client', '', cursor, null));
  assert.equal(calls, 0);
});

test('oversized, unordered, duplicate and unsafe result pages are rejected', async () => {
  const pages = [response(Array.from({ length: 21 }, (_, i) => ({ id: i + 1 }))), response([{ id: 2 }, { id: 1 }]), response([{ id: 1 }, { id: 1 }]), response([{ id: Number.MAX_SAFE_INTEGER + 1 }]), { data: { items: [{ id: 1 }], has_more: false, next_cursor: 2 } }];
  for (const result of pages) {
    const r = repository(async () => result);
    await assert.rejects(r.read('client', '', null, null));
  }
});

test('planner custom RPC remains compatible with the shared repository', async () => {
  let name; const r = repository(async (rpcName) => { name = rpcName; return page(1, { fullName: 'Client', phones: [] }); }, () => 'planner', 'traffic_planner_client_options');
  await r.read('client', '', null, null); assert.equal(name, 'traffic_planner_client_options');
});

