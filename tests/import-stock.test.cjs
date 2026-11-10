const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function extract(file, name) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), 99, true);
  return ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)
    .getText(ast).replace(/^export /, '');
}
const batchSource = extract('src/ts/roboha/dodatu_inchi_bazu/inhi/batchImportSclad.ts', 'batchUpdateActWithDetails');
function fixture(initial = []) {
  const state = { data: { Деталі: initial, 'За деталі': 0 }, writes: [] };
  const context = { structuredClone, console: { error() {} }, actsDataCache: new Map(),
    readActJson: x => x,
    readActSnapshot: async () => ({ data: structuredClone(state.data) }),
    writeActSnapshotWithStock: async (id, expected, next) => {
      state.writes.push({ id, expected: structuredClone(expected), next: structuredClone(next) });
      state.data = structuredClone(next);
      return { data: state.data };
    },
  };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(batchSource, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  return { state, context, save: context.batchUpdateActWithDetails };
}
const detail = (id, quantity) => ({ sclad_id: id, Деталь: 'Болт ГБЦ', Каталог: '4891024', Кількість: quantity, Ціна: 72, Сума: quantity * 72 });
const qty = data => data.Деталі.reduce((sum, row) => sum + row.Кількість, 0);
test('12 imported parts are sent to the atomic act/stock writer; retry has zero delta', async () => {
  const f = fixture();
  assert.equal(await f.save('1243', [detail(1, 12)]), true);
  assert.equal(qty(f.state.writes[0].next) - qty(f.state.writes[0].expected), 12);
  assert.equal(await f.save('1243', [detail(1, 12)]), true);
  assert.equal(qty(f.state.writes[1].next) - qty(f.state.writes[1].expected), 0);
  assert.equal(f.state.data.Деталі.length, 1);
});
test('quantity reduction from twelve to six returns six parts', async () => {
  const f = fixture([detail(1, 12)]);
  await f.save('1243', [detail(1, 6)]);
  assert.equal(qty(f.state.writes[0].next) - qty(f.state.writes[0].expected), -6);
});
test('two purchases with the same catalog keep distinct stock IDs', async () => {
  const f = fixture([detail(1, 12)]);
  await f.save('1243', [detail(2, 4)]);
  assert.equal(f.state.data.Деталі.length, 2);
  assert.equal(f.state.data.Деталі[0].sclad_id, 1);
  assert.equal(f.state.data.Деталі[1].sclad_id, 2);
});
test('failed atomic save reports failure and leaves cache untouched', async () => {
  const f = fixture();
  f.context.writeActSnapshotWithStock = async () => { throw new Error('conflict'); };
  assert.equal(await f.save('1243', [detail(1, 12)]), false);
  assert.equal(f.context.actsDataCache.size, 0);
  assert.equal(f.state.data.Деталі.length, 0);
});
test('ordinary warehouse edit does not reset consumption when the input is absent', () => {
  const source = fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/db_sclad.ts', 'utf8');
  const mode = { CRUD: 'Редагувати' };
  const deps = {
    './dodatu_inchi_bazu_danux': mode,
    './inhi/scladMagasunDetal': { getOriginalScladRecord: () => null, getSlyusarIdByPib: () => null },
  };
  const context = { exports: {}, require: name => deps[name] || {}, document: { getElementById: () => null },
    localStorage: { getItem: () => null } };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
  assert.equal(Object.hasOwn(context.exports.readScladFormValues(), 'kilkist_off'), false);
  mode.CRUD = 'Додати';
  assert.equal(context.exports.readScladFormValues().kilkist_off, 0);
});
