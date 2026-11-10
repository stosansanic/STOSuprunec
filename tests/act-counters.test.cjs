const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function fixture() {
  let rows = [];
  const elements = Object.fromEntries(['act-counters', 'open-act-count', 'act-search-summary', 'dateRangePicker']
    .map(id => [id, { hidden: true, value: 'Відкриті', attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; } }]));
  elements['table-container-modal-sakaz_narad'] = {
    querySelectorAll(selector) {
      assert.equal(selector, ':scope > table > tbody > tr[data-act-id]');
      return rows;
    },
  };
  const context = { exports: {}, document: { getElementById: id => elements[id] },
    require() { throw new Error('Counter must not import database/network code'); } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/tablucya/actCounters.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return { api: context.exports, elements,
    setRows(ids) { rows = ids.map(id => ({ dataset: { actId: String(id) } })); } };
}

test('badge follows current rows after status, date, search and clearing filters', () => {
  const f = fixture();
  for (const [filter, ids] of [
    ['Відкриті', [1, 2, 3]], ['Закриті', [40, 41]], ['Заморожені ❄️', [90]],
    ['01.09.2026 - 26.09.2026', [2, 40, 90]], ['search result', [40]],
    ['no matches', []], ['Відкриті', [1, 2, 3]],
  ]) {
    f.elements.dateRangePicker.value = filter;
    f.setRows(ids);
    f.api.refreshActCounters();
    assert.equal(f.elements['open-act-count'].textContent, String(ids.length));
    assert.equal(f.elements['act-counters'].hidden, false);
    assert.equal(f.elements.dateRangePicker.value, filter);
  }
});

test('badge counts every displayed act beyond 1000 rows, without duplicate IDs', () => {
  const f = fixture();
  f.setRows([...Array.from({ length: 1503 }, (_, i) => i + 1), 1]);
  f.api.refreshActCounters();
  assert.equal(f.elements['open-act-count'].textContent, '1503');
});

test('badge refresh follows row deletion/replacement and labels the current table', () => {
  const f = fixture();
  f.setRows([10, 11]); f.api.refreshActCounters();
  f.setRows([11]); f.api.refreshActCounters();
  assert.equal(f.elements['open-act-count'].textContent, '1');
  assert.equal(f.elements['open-act-count'].attributes['aria-label'], 'Актів у поточній таблиці: 1');
  assert.match(f.elements.dateRangePicker.attributes.title, /поточній таблиці: 1/);
});

test('loading/errors hide the last count instead of reporting a false zero', () => {
  const f = fixture();
  f.setRows([1, 2]); f.api.refreshActCounters();
  f.api.updateActSearchSummary('BMW', 2, 10);
  f.api.hideActCounters();
  assert.equal(f.elements['act-counters'].hidden, true);
  assert.equal(f.elements['act-search-summary'].hidden, true);
  f.setRows([]); f.api.refreshActCounters();
  assert.equal(f.elements['open-act-count'].textContent, '0');
  assert.equal(f.elements['act-counters'].hidden, false);
});

test('search summary includes zero matches and disappears after clearing search', () => {
  const f = fixture();
  f.api.updateActSearchSummary('BMW', 0, 42);
  assert.equal(f.elements['act-search-summary'].textContent, 'Знайдено 0 із 42');
  assert.equal(f.elements['act-search-summary'].hidden, false);
  f.api.updateActSearchSummary(' ', 42, 42);
  assert.equal(f.elements['act-search-summary'].hidden, true);
});

test('table updates the badge after committing rows, empty results, sorting and row removal', () => {
  const source = fs.readFileSync('src/ts/roboha/tablucya/tablucya.ts', 'utf8');
  assert.match(source, /container\.appendChild\(table\);\s*(?:renderActPageNavigation\(container\);\s*)?refreshActCounters\(\)/);
  assert.match(source, /showNoDataMessage\([^;]+;\s*refreshActCounters\(\)/);
  assert.match(source, /oldTbody\.replaceWith\(newTbody\);\s*refreshActCounters\(\)/);
  assert.match(source, /rows\.forEach\(\(row\) => row\.remove\(\)\);\s*refreshActCounters\(\)/);
});

test('paged table badge uses the full server result count, never the visible fifty',()=>{
 const f=fixture();f.elements['table-container-modal-sakaz_narad'].dataset={actTotal:'1005'};
 f.setRows(Array.from({length:50},(_,i)=>i+1));f.api.refreshActCounters();assert.equal(f.elements['open-act-count'].textContent,'1005');
 f.api.hideActCounters();assert.equal(f.elements['table-container-modal-sakaz_narad'].dataset.actTotal,undefined);
});
