const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const source = fs.readFileSync('src/ts/roboha/bukhhalteriya/bukhhalteriya.ts', 'utf8');
const ast = ts.createSourceFile('accounting.ts', source, ts.ScriptTarget.ES2020, true);
const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runMassPaymentCalculation');
function harness(tab = 'details') {
  const loading = [], routes = [], notices = [];
  let busy = false, release;
  class Button {}
  const button = new Button();
  const perform = name => async () => { busy = true; routes.push(name); await new Promise(resolve => release = resolve); busy = false; };
  const context = {
    exports: {}, HTMLButtonElement: Button, document: { activeElement: button, querySelector: () => button },
    isAccountingPaymentBusy: () => busy, getActiveBukhhalterTab: () => tab,
    setButtonLoadingEl: (_, value) => loading.push(value), showNotification: (...args) => notices.push(args),
    runMassPaymentCalculationForPodlegle: perform('podlegle'), runMassPaymentCalculationForMagazine: perform('magazine'),
    runMassPaymentCalculationForDetails: perform('details'), runMassPaymentCalculationForvutratu: perform('vutratu'),
  };
  vm.runInNewContext(ts.transpileModule(fn.getText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
  return { run: context.exports.runMassPaymentCalculation, loading, routes, notices, release: () => release(), setBusy: value => busy = value };
}
test('dispatcher rejects busy calls before changing the calculation button', async () => {
  const h = harness(); h.setBusy(true); await h.run(); assert.deepEqual(h.loading, []); assert.deepEqual(h.routes, []);
});
test('dispatcher chooses the actual active tab and duplicate call cannot replace button label', async () => {
  for (const tab of ['podlegle', 'magazine', 'details', 'vutratu']) {
    const h = harness(tab), first = h.run(); await h.run();
    assert.deepEqual(h.routes, [tab]); assert.deepEqual(h.loading, [true]);
    h.release(); await first; assert.deepEqual(h.loading, [true, false]);
  }
});
test('analytics never accidentally settles a hidden accounting tab', async () => {
  const h = harness('analityka'); await h.run(); assert.deepEqual(h.routes, []); assert.equal(h.notices.length, 1);
  assert.deepEqual(h.loading, [true, false]);
});
