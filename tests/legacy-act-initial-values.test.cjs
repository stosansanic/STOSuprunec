const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/ts/roboha/zakaz_naraudy/modalMain.ts'), 'utf8');
const file = ts.createSourceFile('modalMain.ts', source, ts.ScriptTarget.Latest, true);
const definition = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'initializeActPaymentInputs');
assert.ok(definition, 'payment hydration must have a directly testable boundary');
const javascript = ts.transpileModule(definition.getText(file), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture(ids = ['editable-avans', 'editable-discount', 'editable-discount-amount']) {
  const controls = new Map(ids.map(id => {
    const input = new EventTarget();
    input.value = '0';
    return [id, input];
  }));
  const body = { querySelector: selector => controls.get(selector.slice(1)) || null };
  const context = { Event, setTimeout() { throw new Error('hydration must not schedule a delayed overwrite'); } };
  vm.createContext(context);
  vm.runInContext(javascript, context);
  return { controls, body, initialize: (act, details) => context.initializeActPaymentInputs(body, act, details) };
}

test('saved advance and discount are present synchronously before the baseline is captured', () => {
  const form = fixture();
  form.initialize({ avans: 1200, discount: 7.5, discount_amount: 75 }, { Аванс: 5, Знижка: 1 });
  assert.equal(form.controls.get('editable-avans').value, '1200');
  assert.equal(form.controls.get('editable-discount').value, '7.5');
  assert.equal(form.controls.get('editable-discount-amount').value, '75');
});

test('legacy JSON values work and explicit column zero overrides legacy values', () => {
  const form = fixture();
  form.initialize({}, { Аванс: 450.5, Знижка: 2.5, ПроцентЗнижки: 25 });
  assert.equal(form.controls.get('editable-avans').value, '450.5');
  assert.equal(form.controls.get('editable-discount').value, '2.5');
  assert.equal(form.controls.get('editable-discount-amount').value, '25');
  form.initialize({ avans: 0, discount: 0, discount_amount: 0 }, { Аванс: 450, Знижка: 5, ПроцентЗнижки: 25 });
  assert.deepEqual([...form.controls.values()].map(input => input.value), ['0', '0', '0']);
});

test('all fields are assigned before input listeners recalculate totals', () => {
  const form = fixture();
  const seen = [];
  for (const input of form.controls.values()) input.addEventListener('input', () => {
    seen.push([...form.controls.values()].map(control => control.value));
  });
  form.initialize({ avans: 200, discount: 10, discount_amount: 60 }, {});
  assert.deepEqual(seen, [['200', '10', '60'], ['200', '10', '60'], ['200', '10', '60']]);
});

test('restricted views without payment controls remain supported', () => {
  const form = fixture([]);
  assert.doesNotThrow(() => form.initialize({}, {}));
});

test('hydration targets only the captured modal body and leaves later edits alone', async () => {
  const first = fixture();
  const second = fixture();
  first.initialize({ avans: 500, discount: 5 }, {});
  second.initialize({ avans: 20, discount: 1 }, {});
  first.controls.get('editable-avans').value = '750';
  await Promise.resolve();
  assert.equal(first.controls.get('editable-avans').value, '750');
  assert.equal(second.controls.get('editable-avans').value, '20');
});

test('render hydrates directly rather than postponing values beyond handler registration', () => {
  const render = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'renderModalContent');
  const directCall = render.body.statements.find(node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText(file) === 'initializeActPaymentInputs');
  assert.ok(directCall, 'hydrate must execute as part of synchronous render');
  assert.equal(directCall.expression.arguments[0].getText(file), 'body');
});
