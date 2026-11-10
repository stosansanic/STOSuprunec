const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/bukhhalteriya/reportCacheFilter.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: api, require: () => ({}) });
const row = entries => ({ id: 1, data: { Name: 'Worker', Історія: { '2026-10-01': entries } } });
test('adjacent pages merge semantically equal payment entries with JSONB key order', () => {
  const first = row([{ Акт: '12', Записи: [{ recordId: 'r', Зарплата: 25, __payroll_payments: [{ id: 'p', amount: 25, date: '21.10.2026' }] }] }]);
  const next = row([{ Записи: [{ __payroll_payments: [{ date: '21.10.2026', amount: 25, id: 'p' }], Зарплата: 25, recordId: 'r' }], Акт: '12' }, { Акт: '13', Записи: [] }]);
  const merged = api.mergeHistoryRows([first, next], r => r.id);
  assert.equal(merged.length, 1); assert.equal(merged[0].data.Історія['2026-10-01'].length, 2);
  assert.equal(first.data.Історія['2026-10-01'].length, 1);
});
test('changed wage, removed payment or altered array order still reject stale pages', () => {
  const entry = { Акт: '12', Записи: [{ recordId: 'a', Зарплата: 25 }, { recordId: 'b', Зарплата: 30 }], Розраховано: null };
  for (const mutate of [e => e.Записи[0].Зарплата++, e => e.Записи.reverse(), e => delete e.Розраховано, e => e.Розраховано = 'today']) {
    const next = structuredClone(entry); mutate(next);
    assert.equal(api.mergeHistoryRows([row([entry]), row([next])], r => r.id), null);
  }
});
