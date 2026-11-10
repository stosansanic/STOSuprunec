const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Run the real lifecycle/control functions in isolation, without importing the app
// entry point (which starts authentication, Realtime and unrelated UI listeners).
function functions(file, names) {
  const source = fs.readFileSync(`src/ts/roboha/bukhhalteriya/${file}`, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node, `${file}: ${name}`);
    return node.getText(ast);
  }).join('\n');
}
function evaluate(source, context) {
  context.exports ||= {};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context;
}
class Element {
  constructor(value = '') {
    this.value = value; this.dataset = {}; this.listeners = {}; this.attributes = {};
    this.validity = { badInput: false }; this.childElementCount = 0; this.classes = new Set();
    this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name),
      toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.listeners[event.type] || []) fn.call(this, event); }
  click() { this.dispatchEvent({ type: 'click' }); }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { this.focused = true; }
  set innerHTML(value) { this.html = value; this.childElementCount = value ? 1 : 0; }
}
function analyticsFixture() {
  const elements = Object.fromEntries(['analityka-date-from', 'analityka-date-to', 'analityka-dashboard',
    'analityka-report-status', 'search'].map(id => [id, new Element()]));
  const views = ['financial', 'operations'].map(view => {
    const element = new Element(); element.dataset.analyticsView = view; return element;
  });
  const quick = ['week', 'month', 'quarter', 'year'].map(range => {
    const element = new Element(); element.dataset.range = range; return element;
  });
  let actor = 'admin';
  const window = new Element(), calls = [], rendered = [], alerts = [];
  const context = {
    analyticsRequest: 0, analyticsOwner: '', analyticsView: 'financial', isLoading: false,
    cachedFinancial: null, cachedDashboard: null, cachedPostArxiv: [], cachedPosts: [],
    filterDateFrom: null, filterDateTo: null, disposeFinancial: undefined,
    localStorage: { getItem: () => actor }, window,
    document: { getElementById: id => elements[id] || null, querySelectorAll: selector => {
      if (selector === '[data-analytics-view]') return views;
      if (selector.includes('analityka-quick-btn')) return quick;
      if (selector === '.Bukhhalter-add-button') return [elements.search];
      if (selector.includes('#Bukhhalter-analityka-section input')) return [elements['analityka-date-from'], elements['analityka-date-to'], ...views, ...quick];
      return [];
    } },
    accountingToday: () => '2026-10-25', requireAccountingPeriod: (from, to) => {
      if (!from || from > to) throw new Error('Потрібен період');
      return { from, to };
    },
    showNotification: (...args) => alerts.push(args), isCancelled: error => error?.name === 'AbortError',
    cancelAnalyticsDashboardRead() {}, invalidateAnalyticsDashboard() {}, destroyAnalyticsCharts() {},
    renderDashboardLayout() { rendered.push('operations'); }, redrawDashboard() {},
    renderFinancialOverview: (_, report) => { rendered.push(report); return () => {}; },
    readAnalyticsDashboard: async (from, to) => { calls.push({ kind: 'operations', from, to }); return { planning: [], posts_count: 0 }; },
    financialReader: {
      cancel() {}, clear() {},
      async read(from, to, owner, isCurrent) {
        calls.push({ kind: 'financial', from, to, owner, isCurrent });
        return { from, to, generatedAt: '2026-10-25T12:00:00Z' };
      },
    },
  };
  const names = ['setAnalyticsMessage', 'renderAnalyticsEmpty', 'setAnalyticsLoading', 'suspendAnalityka',
    'clearAnalityka', 'applyQuickRange', 'fmtInputDate', 'highlightQuickBtn', 'setupDateFilter',
    'renderCurrentAnalytics', 'initAnalityka', 'searchAnalityka'];
  evaluate(functions('analityka.ts', names), context);
  return { context, elements, views, quick, calls, rendered, alerts,
    setActor(value) { actor = value; }, setPeriod(from = '2026-10-01', to = '2026-10-25') {
      elements['analityka-date-from'].value = from; elements['analityka-date-to'].value = to;
    } };
}

test('analytics opening, presets, date edits and view switches never fetch reports', () => {
  const f = analyticsFixture(); f.context.exports.initAnalityka();
  f.quick[1].click(); f.elements['analityka-date-from'].dispatchEvent({ type: 'change' });
  f.views[1].click(); f.views[0].click(); f.context.exports.initAnalityka();
  assert.equal(f.calls.length, 0);
  assert.equal(f.elements['analityka-date-from'].listeners.change.length, 1);
  assert.equal(f.views[0].listeners.click.length, 1);
});

test('one explicit search loads only its selected view and returning to a view uses its own cached period', async () => {
  const f = analyticsFixture(); f.context.exports.initAnalityka(); f.setPeriod();
  await f.context.exports.searchAnalityka();
  assert.deepEqual(f.calls.map(call => call.kind), ['financial']);
  f.views[1].click(); f.setPeriod('2026-09-01', '2026-09-30');
  await f.context.exports.searchAnalityka(); f.views[0].click();
  assert.deepEqual(f.calls.map(call => call.kind), ['financial', 'operations']);
  assert.equal(f.rendered.at(-1).from, '2026-10-01');
  assert.match(f.elements['analityka-report-status'].textContent, /01\.10\.2026.*25\.10\.2026/);
});

test('duplicate submit is coalesced and a late result after leaving cannot replace the report', async () => {
  const f = analyticsFixture(); f.context.exports.initAnalityka(); f.setPeriod();
  let resolve;
  f.context.financialReader.read = (...args) => { f.calls.push(args); return new Promise(done => { resolve = done; }); };
  const pending = f.context.exports.searchAnalityka();
  await f.context.exports.searchAnalityka();
  assert.equal(f.calls.length, 1);
  f.context.exports.suspendAnalityka();
  resolve({ from: '2026-10-01', to: '2026-10-25', generatedAt: '2026-10-25T12:00:00Z' });
  await pending;
  assert.equal(f.context.cachedFinancial, null);
  assert.equal(f.elements.search.disabled, false);
});

test('data change and reconnect invalidate without polling or automatic reload', async () => {
  const f = analyticsFixture(); f.context.exports.initAnalityka(); f.setPeriod();
  await f.context.exports.searchAnalityka();
  let clears = 0; f.context.financialReader.clear = () => clears++;
  for (const type of ['sto:accounting-changed', 'sto:stock-saved', 'online']) f.context.window.dispatchEvent({ type });
  assert.equal(clears, 3); assert.equal(f.calls.length, 1);
  assert.match(f.elements['analityka-report-status'].textContent, /Дані змінилися/);
});

test('auth owner change clears cached money and period on the next analytics activation', async () => {
  const f = analyticsFixture(); f.context.exports.initAnalityka(); f.setPeriod();
  await f.context.exports.searchAnalityka(); f.setActor('different admin'); f.context.exports.initAnalityka();
  assert.equal(f.context.cachedFinancial, null);
  assert.equal(f.elements['analityka-date-from'].value, '');
  assert.equal(f.calls.length, 1);
});

function clearFixture(kind) {
  const isParts = kind === 'details';
  const prefix = isParts ? 'poAktam' : 'details';
  const ids = [`Bukhhalter-${kind}-date-open`, `Bukhhalter-${kind}-date-close`, `${prefix}-status-filter-toggle`,
    isParts ? 'poAktam-payment-filter-toggle' : 'payment-filter-toggle', 'percentage-filter-toggle',
    'Bukhhalter-podlegle-name-select', 'Bukhhalter-podlegle-act-select', 'Bukhhalter-podlegle-work-input'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element('old-filter')]));
  const fields = Object.values(elements), section = { querySelectorAll: () => fields };
  elements[`Bukhhalter-${kind}-section`] = section;
  const buttons = ['open', 'close', 'paid'].map(mode => { const e = new Element(); e.dataset.filter = mode; return e; });
  const pending = new Map([[8, () => { context.extraReads++; }]]);
  const context = {
    Event: class { constructor(type) { this.type = type; } },
    byId: id => elements[id] || null, document: { querySelectorAll: () => buttons },
    clearTimeout: timer => pending.delete(timer), extraReads: 0,
    shopPaymentBusy: false, hasDetailsDataLoaded: true, reportGeneration: 0, reportPage: {},
    reportLoading: true, reportSearchFailed: false, detailsVisibleCount: 5,
    hiddenDetails: new Set(), detailsScroll: { reset() {} }, appliedReportFilter: {}, appliedReportScope: 'a',
    currentStatusFilter: 'open', currentPaymentFilterDetails: 'paid', detailsDateFilterMode: 'paid',
    currentDetailsScladFilter: 7, availableDetailsScladNomers: [7], detailsData: [1], allDetailsData: [1],
    autoDetailsSearchTimer: 8, updateDetailsTable() {}, updateReportPagination() {}, showNotification() {},
    payrollPaymentInFlight: false, hasPodlegleDataLoaded: true, payrollReport: {},
    currentPaymentFilter: 'paid', currentPercentageFilter: 'percent', podlegleDateFilterMode: 'paid',
    podlegleData: [1], allPodlegleData: [1], payrollReportGeneration: 0, payrollVisibleCount: 5,
    payrollReportLoading: true, hiddenPayrollKeys: new Set(), clearPayrollReportCache() {},
    payrollScroll: { reset() {} }, updatePayrollPager() {}, lastSearchDateOpen: '2026-01-01',
    lastSearchDateClose: '2026-01-31', updatepodlegleTable() {}, autoPodlegleSearchTimer: 8,
  };
  evaluate(functions(isParts ? 'poAktam.ts' : 'zarplata.ts', [isParts ? 'clearDetailsForm' : 'clearpodlegleForm']), context);
  return { context, pending, elements, buttons };
}

test('parts clear removes old warehouse scope and cancels pending search before financial prefill', () => {
  const f = clearFixture('details'); f.context.exports.clearDetailsForm();
  for (const callback of f.pending.values()) callback();
  assert.equal(f.context.currentDetailsScladFilter, null);
  assert.equal(f.context.availableDetailsScladNomers.length, 0);
  assert.equal(f.context.autoDetailsSearchTimer, null);
  assert.equal(f.context.extraReads, 0);
  assert.equal(f.context.detailsDateFilterMode, 'open');
});

test('payroll clear cancels old debounce and resets employee, payment and percentage filters before financial prefill', () => {
  const f = clearFixture('podlegle'); f.context.exports.clearpodlegleForm();
  for (const callback of f.pending.values()) callback();
  assert.equal(f.context.autoPodlegleSearchTimer, null);
  assert.equal(f.context.extraReads, 0);
  assert.equal(f.context.currentPaymentFilter, 'all');
  assert.equal(f.context.currentPercentageFilter, 'all');
  assert.equal(f.elements['Bukhhalter-podlegle-name-select'].value, '');
});

function drilldownFixture() {
  const source = fs.readFileSync('src/ts/roboha/bukhhalteriya/bukhhalteriya.ts', 'utf8');
  const ast = ts.createSourceFile('bukhhalteriya.ts', source, ts.ScriptTarget.Latest, true);
  const registration = ast.statements.find(node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'document.addEventListener' &&
    node.expression.arguments[0]?.text === 'sto:financial-drilldown');
  assert.ok(registration);
  const elements = {}, listeners = {}, calls = [], modes = {};
  const element = id => elements[id] ||= new Element('old');
  let resolve, paymentBusy = false;
  const clear = tab => {
    modes[tab] = 'open';
    for (const control of Object.values(elements)) control.value = '';
  };
  const context = {
    currentTab: 'analityka', financialNavigationBusy: false, userAccessLevel: 'Адміністратор',
    Event: class { constructor(type) { this.type = type; } },
    isAccountingPaymentBusy: () => paymentBusy, showNotification() {},
    clearpodlegleForm: () => clear('podlegle'), clearDetailsForm: () => clear('details'), clearvutratuForm: () => clear('vutratu'),
    document: { addEventListener: (name, listener) => { listeners[name] = listener; }, getElementById: element,
      querySelector: selector => {
        const match = /^#Bukhhalter-(\w+)-section .*data-filter="(\w+)"/.exec(selector);
        assert.ok(match, selector);
        return { click() { modes[match[1]] = match[2]; } };
      } },
    switchTab: (_, tab) => { context.currentTab = tab; },
    addRecord() {
      calls.push({ tab: context.currentTab, mode: modes[context.currentTab],
        fields: Object.fromEntries(Object.entries(elements).map(([id, control]) => [id, control.value])) });
      return new Promise(done => { resolve = done; });
    },
  };
  evaluate(registration.getText(ast), context);
  return { context, calls, elements, emit: detail => listeners['sto:financial-drilldown']({ detail }),
    finish: async () => { resolve?.(); await Promise.resolve(); }, setPaymentBusy: value => { paymentBusy = value; } };
}

test('financial drilldowns prefill the chosen period, closed acts and correct detail mode before one search', async () => {
  for (const [kind, tab, mode] of [['turnover', 'vutratu', 'close'], ['workRevenue', 'vutratu', 'close'],
    ['partsRevenue', 'details', 'close'], ['payroll', 'podlegle', 'close'], ['expenses', 'vutratu', 'open']]) {
    const f = drilldownFixture();
    f.emit({ kind, from: '2026-10-01', to: '2026-10-25' });
    assert.equal(f.calls.length, 1, kind);
    const request = f.calls[0];
    assert.equal(request.tab, tab); assert.equal(request.mode, mode);
    assert.equal(request.fields[`Bukhhalter-${tab}-${tab === 'vutratu' ? 'date-from' : 'date-open'}`], '2026-10-01');
    assert.equal(request.fields[`Bukhhalter-${tab}-${tab === 'vutratu' ? 'date-to' : 'date-close'}`], '2026-10-25');
    const statusId = tab === 'podlegle' ? 'details-status-filter-toggle' : tab === 'details' ? 'poAktam-status-filter-toggle' : 'vutratu-status-filter-toggle';
    assert.equal(request.fields[statusId], kind === 'expenses' ? '2' : '0');
    if (tab === 'vutratu') assert.equal(request.fields['vutratu-type-filter-toggle'], kind === 'expenses' ? '1' : '0');
    await f.finish(); assert.equal(f.context.financialNavigationBusy, false);
  }
});

test('drilldown cannot start during payment, for nonadmins or outside the Analytics view', () => {
  const detail = { kind: 'turnover', from: '2026-10-01', to: '2026-10-25' };
  const f = drilldownFixture(); f.setPaymentBusy(true); f.emit(detail);
  f.setPaymentBusy(false); f.context.userAccessLevel = 'Слюсар'; f.emit(detail);
  f.context.userAccessLevel = 'Адміністратор'; f.context.currentTab = 'details'; f.emit(detail);
  assert.equal(f.calls.length, 0);
});
