const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function report(from = '2026-10-01', to = '2026-10-31') {
  const totals = Object.fromEntries([
    'turnover', 'workRevenue', 'partsRevenue', 'partsCost', 'workPayroll', 'partsPayroll',
    'payrollAccrued', 'grossEarnings', 'operatingExpenses', 'profit', 'settledReceipts',
    'payrollPaid', 'suppliersPaid', 'expensesPaid', 'totalPaid', 'netKnownMovement',
    'closedActs', 'avgCheck', 'excludedExpenses', 'excludedExpensesPaid',
  ].map(key => [key, 0]));
  return { formatVersion: 1, complete: true, from, to, previousFrom: '2026-08-31', previousTo: '2026-09-30',
    generatedAt: '2026-10-25T12:00:00Z', revision: 'version-1', current: totals, previous: {...totals},
    employees: [], employeeCount: 0, expenseCategories: [], paymentChannels: [],
    balances: { asOf: to, basis: 'reconstructed_current_records', receivables: 0, suppliers: 0,
      payroll: 0, expenses: 0, totalLiabilities: 0, undatedAdvances: 0, cashBalance: null, freeCash: null },
    inventory: { value: 0, count: 0, asOf: 'current', measuredAt: '2026-10-25T12:00:00Z' },
    quality: { estimates: true, warnings: [] } };
}
function fixture() {
  const requests = [];
  let response = { data: report(), error: null };
  let hold = false;
  const client = { rpc(name, args) {
    const request = { name, args };
    requests.push(request);
    return { abortSignal(signal) {
      request.signal = signal;
      return new Promise(resolve => {
        request.resolve = value => resolve(value || response);
        if (!hold) request.resolve();
      });
    } };
  } };
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync('src/ts/roboha/bukhhalteriya/financialOverviewRead.ts', 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: () => ({ supabase: client }), structuredClone,
    AbortController, DOMException, Date, Number, Set, Map, Error });
  return { reader: exports.createFinancialOverviewRead(client), requests,
    respond(data, error = null) { response = { data, error }; }, hold() { hold = true; } };
}

test('financial search coalesces, revalidates with one revision, and clones cached data', async () => {
  const f = fixture(); f.hold();
  const first = f.reader.read('2026-10-01', '2026-10-31', 'owner');
  const second = f.reader.read('2026-10-01', '2026-10-31', 'owner');
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve();
  const [a, b] = await Promise.all([first, second]);
  a.current.turnover = 900;
  assert.equal(b.current.turnover, 0);
  const next = f.reader.read('2026-10-01', '2026-10-31', 'owner');
  assert.equal(f.requests[1].args.p_known_revision, 'version-1');
  f.requests[1].resolve({ data: { formatVersion: 1, not_modified: true, revision: 'version-1' }, error: null });
  assert.equal((await next).current.turnover, 0);
  assert.equal(f.requests.length, 2);
});

test('financial cache isolates periods and users; invalidation removes revisions', async () => {
  const f = fixture();
  await f.reader.read('2026-10-01', '2026-10-31', 'owner');
  f.respond(report('2026-10-02', '2026-10-31'));
  await f.reader.read('2026-10-02', '2026-10-31', 'owner');
  assert.equal(f.requests[1].args.p_known_revision, null);
  f.respond(report());
  await f.reader.read('2026-10-01', '2026-10-31', 'other');
  assert.equal(f.requests[2].args.p_known_revision, null);
  f.reader.clear();
  await f.reader.read('2026-10-01', '2026-10-31', 'other');
  assert.equal(f.requests[3].args.p_known_revision, null);
});

test('cancelled, old-actor and old-period responses cannot replace financial snapshots', async () => {
  const f = fixture(); f.hold();
  const first = f.reader.read('2026-10-01', '2026-10-31', 'owner');
  const second = f.reader.read('2026-10-02', '2026-10-31', 'owner');
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[0].resolve();
  await assert.rejects(first, { name: 'AbortError' });
  f.reader.cancel(); f.requests[1].resolve();
  await assert.rejects(second, { name: 'AbortError' });
  let current = true;
  const third = f.reader.read('2026-10-01', '2026-10-31', 'owner', () => current);
  current = false; f.requests[2].resolve();
  await assert.rejects(third, { name: 'AbortError' });
});

test('invalid intervals never issue an RPC; partial totals are not cached', async () => {
  const f = fixture();
  for (const [from, to] of [['2026-02-30', '2026-03-01'], ['2026-11-01', '2026-10-01'], ['', '2026-10-31']]) {
    await assert.rejects(f.reader.read(from, to, 'a'), /період/);
  }
  assert.equal(f.requests.length, 0);
  const broken = report(); delete broken.current.profit;
  f.respond(broken);
  await assert.rejects(f.reader.read('2026-10-01', '2026-10-31', 'a'), /неповні дані/);
  f.respond(report());
  await f.reader.read('2026-10-01', '2026-10-31', 'a');
  assert.equal(f.requests[1].args.p_known_revision, null);
});

test('missing SQL tells user which file to install; not-modified needs a matching snapshot', async () => {
  const f = fixture();
  f.respond(null, { code: 'PGRST202' });
  await assert.rejects(f.reader.read('2026-10-01', '2026-10-31', 'a'), /financial-overview\.sql/);
  f.respond({ formatVersion: 1, not_modified: true, revision: 'unknown' });
  await assert.rejects(f.reader.read('2026-10-01', '2026-10-31', 'a'), /актуальність/);
});
