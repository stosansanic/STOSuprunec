const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function fixture() {
  class Element {
    constructor() { this.children = []; this.style = {}; this.attributes = {}; this.ownText = ''; this.isConnected = true; }
    set textContent(value) { this.ownText = value; this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(' '); }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    prepend(child) { child.parent = this; this.children.unshift(child); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    querySelectorAll() { return []; }
  }
  const exports = {}, prompts = [], events = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/utils/actEditorGuard.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports, document: { createElement: () => new Element() },
    window: { addEventListener: (name, listener) => { events[name] = listener; } },
    require: () => ({ notify() {}, confirmDiscardChanges: async options => { prompts.push(options); return false; } }),
  });
  const body = new Element();
  exports.trackActEditor(1514, body);
  return { api: exports, body, prompts, events, Element };
}

test('confirmed payroll sync leaves no informational notice and allows leaving a saved act', async () => {
  const f = fixture();
  f.api.setActEditorPayrollPending(1514, true);
  assert.equal(f.body.children.length, 1);
  assert.match(f.body.textContent, /заблоковані/);
  f.api.setActEditorPayrollPending(1514, false);
  assert.equal(f.body.children.length, 0);
  assert.equal(await f.api.confirmActNavigation(), true);
  assert.equal(f.prompts.length, 0);
  f.events.beforeunload({ preventDefault() { assert.fail('A saved draft must not block leaving'); } });
});

test('a real failed commit retains the pending guard and its specific reason', async () => {
  const f = fixture();
  f.api.setActEditorPayrollPending(1514, true, 'Налаштування працівника змінилися.');
  assert.match(f.body.textContent, /Налаштування працівника змінилися/);
  assert.match(f.body.textContent, /Перевірте причину нижче/);
  assert.doesNotMatch(f.body.textContent, /Натисніть «Зберегти зміни»/);
  assert.equal(await f.api.confirmActNavigation(), false);
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0].subtitle, /Налаштування працівника змінилися/);
  assert.doesNotMatch(f.prompts[0].subtitle, /повторіть «Зберегти зміни»/i);
  let prevented = false;
  f.events.beforeunload({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test('switching acts and delayed previous-act updates cannot leak payroll notices', () => {
  const f = fixture();
  f.api.setActEditorPayrollPending(1514, true, 'Previous error');
  const nextBody = new f.Element();
  f.api.trackActEditor(1515, nextBody);
  f.api.setActEditorPayrollPending(1514, true, 'Stale response');
  assert.equal(nextBody.children.length, 0);
  f.api.forgetActEditor();
  f.api.trackActEditor(1514, f.body);
  assert.equal(f.body.children.length, 0);
});
