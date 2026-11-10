const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

test('menu hover gently scales controls without resizing layout or animating touch/reduced motion', () => {
  const css = require('sass').compile('src/scss/robocha/_menu-tooltips.scss').css;
  assert.match(css, /#menu-items-to-hide > li > button\[data-icon\]/);
  assert.match(css, /transition: transform 220ms cubic-bezier/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.match(css, /transform: scale\(1\.1\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /transition: none/);
  assert.match(css, /transform: none/);
  assert.doesNotMatch(css, /#menu-items-to-hide:hover\s*\{/);
});

function fixture() {
  class Element {
    constructor() { this.attributes = {}; this.dataset = {}; this.style = {}; this.events = {}; this.rect = { left: 290, top: 10, bottom: 54, width: 44, height: 44 }; }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k] || null; }
    removeAttribute(k) { delete this.attributes[k]; }
    get title() { return this.attributes.title || ''; }
    set title(value) { this.attributes.title = value; }
    addEventListener(k, fn) { this.events[k] = fn; }
    contains(el) { return el === this; }
    closest() { return this.dataset.menuTooltip ? this : null; }
    matches() { return true; }
    getBoundingClientRect() { return this.rect; }
    getClientRects() { return [this.rect]; }
  }
  const target = new Element(); target.title = 'Налаштування';
  const menu = new Element();
  const targets = [target];
  menu.contains = el => targets.includes(el);
  menu.querySelectorAll = () => targets.filter(el => el.title);
  const nodes = { 'menu-items-to-hide': menu };
  const document = new Element();
  document.body = { appendChild: el => { nodes[el.id] = el; } };
  document.getElementById = id => nodes[id];
  document.createElement = () => { const el = new Element(); el.rect = { width: 160, height: 36 }; return el; };
  const window = new Element(); window.innerWidth = 320; window.innerHeight = 700;
  let observer, timer;
  const context = { exports: {}, document, window, Element, Node: Element,
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
    setTimeout(fn) { timer = fn; return 1; }, clearTimeout() { timer = null; } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/utils/menuTooltips.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  context.exports.initMenuTooltips();
  return { target, menu, document, window, nodes, targets, Element, api: context.exports,
    mutate: () => observer(), flush: () => timer?.(), tip: nodes['main-menu-tooltip'] };
}

test('native title is replaced by styled hint, scoped to menu and initialized once', () => {
  const f = fixture();
  assert.equal(f.target.title, '');
  assert.equal(f.target.dataset.menuTooltip, 'Налаштування');
  assert.equal(f.tip.hidden, true);
  f.api.initMenuTooltips();
  assert.equal(f.nodes['main-menu-tooltip'], f.tip);
});

test('mouse hint clamps inside viewport and click/Escape dismiss without changing action', () => {
  const f = fixture();
  f.menu.events.pointerover({ target: f.target, pointerType: 'mouse', relatedTarget: null });
  f.flush();
  assert.equal(f.tip.hidden, false);
  assert.equal(f.tip.textContent, 'Налаштування');
  assert.equal(f.tip.style.left, '152px');
  assert.equal(f.tip.style.top, '62px');
  f.menu.events.click();
  assert.equal(f.tip.hidden, true);
  f.menu.events.focusin({ target: f.target });
  assert.equal(f.tip.hidden, false);
  f.document.events.keydown({ key: 'Escape' });
  assert.equal(f.tip.hidden, true);
});

test('touch does not show hints; keyboard descriptions preserve existing IDs; scroll hides', () => {
  const f = fixture();
  f.menu.events.pointerover({ target: f.target, pointerType: 'touch' }); f.flush();
  assert.equal(f.tip.hidden, true);
  f.target.setAttribute('aria-describedby', 'existing');
  f.menu.events.focusin({ target: f.target });
  assert.equal(f.target.getAttribute('aria-describedby'), 'existing main-menu-tooltip');
  f.window.events.scroll();
  assert.equal(f.tip.hidden, true);
  assert.equal(f.target.getAttribute('aria-describedby'), 'existing');
});

test('dynamic menu buttons and changing calendar count receive updated hints', () => {
  const f = fixture();
  f.menu.events.focusin({ target: f.target });
  f.target.title = 'Актів у поточній таблиці: 42'; f.mutate();
  assert.equal(f.tip.textContent, 'Актів у поточній таблиці: 42');
  assert.equal(f.target.title, '');
  const ai = new f.Element(); ai.title = 'AI Асистент'; f.targets.push(ai); f.mutate();
  assert.equal(ai.dataset.menuTooltip, 'AI Асистент');
  assert.equal(ai.title, '');
});
