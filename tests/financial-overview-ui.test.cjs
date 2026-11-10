const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function uiModule() {
  const source = fs.readFileSync('src/ts/roboha/bukhhalteriya/financialOverviewUI.ts', 'utf8');
  const context = { exports: {}, Intl, Date, Number, Math, Object, CustomEvent: class {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
  } };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return context.exports;
}

function documentFixture() {
  const doc = { createElement: tag => new Element(tag) };
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
      this.attributes = {}; this.listeners = new Map(); this.className = ''; this.value = ''; this._text = '';
      this.classList = { toggle: (name, enabled) => {
        const classes = new Set(this.className.split(' ').filter(Boolean));
        if (enabled) classes.add(name); else classes.delete(name); this.className = [...classes].join(' ');
      } };
    }
    set textContent(text) { this.children.forEach(child => child.parentNode = null); this.children = []; this._text = String(text); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(_) { throw new Error('Unsanitized HTML is not allowed in financial data rendering'); }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children.forEach(child => child.parentNode = null); this.children = []; this._text = ''; this.append(...nodes); }
    replaceWith(node) {
      const parent = this.parentNode; if (!parent) return;
      const index = parent.children.indexOf(this); node.remove(); parent.children[index] = node; node.parentNode = parent; this.parentNode = null;
    }
    remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; } }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    dispatchEvent(event) { for (const listener of this.listeners.get(event.type) || []) listener(event); return true; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
  }
  return doc.createElement('div');
}

const find = (node, predicate) => predicate(node) ? node : node.children.map(child => find(child, predicate)).find(Boolean);
const all = (node, predicate) => [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => all(child, predicate))];
const cls = name => node => node.className.split(' ').includes(name);

function reportFixture() {
  const current = { turnover: 2000, workRevenue: 1500, partsRevenue: 500, partsCost: 200, workPayroll: 300, partsPayroll: 50,
    payrollAccrued: 350, grossEarnings: 1800, operatingExpenses: 400, profit: 1050, settledReceipts: 1200,
    payrollPaid: 900, suppliersPaid: 300, expensesPaid: 200, totalPaid: 1400, netKnownMovement: -200,
    closedActs: 3, avgCheck: 666.67, excludedExpenses: 100, excludedExpensesPaid: 50 };
  return { formatVersion: 1, complete: true, from: '2026-10-01', to: '2026-10-25', previousFrom: '2026-09-06', previousTo: '2026-09-30',
    generatedAt: '2026-10-25T12:00:00Z', revision: 'rev', current, previous: { ...current, turnover: 1000, profit: 0 },
    employees: [{ id: 7, name: '<img src=x onerror=alert(1)>', role: 'Приймальник', accrued: 350, paidInPeriod: 900, due: 50, overpaid: 0 }], employeeCount: 1,
    expenseCategories: [{ category: 'Оренда', accrued: 400, paid: 200, included: true, cashIncluded: true }, { category: 'Зарплата', accrued: 100, paid: 50, included: false, cashIncluded: false }],
    paymentChannels: [{ method: 'Готівка', incoming: 1200, outgoing: 200 }, { method: 'Не визначено', incoming: 0, outgoing: 1200 }],
    balances: { asOf: '2026-10-25', basis: 'reconstructed_current_records', receivables: 800, suppliers: 250, payroll: 50, expenses: 200,
      totalLiabilities: 500, undatedAdvances: 100, cashBalance: null, freeCash: null },
    inventory: { value: 10000, count: 15, asOf: 'current', measuredAt: '2026-10-25T12:00:00Z' },
    quality: { estimates: true, warnings: [{ code: 'legacy', message: 'Немає дат авансів', count: 1, amount: 100, severity: 'warning' }] } };
}

test('opening balance distinguishes missing input from explicit zero and validates decimal amounts', () => {
  const api = uiModule();
  assert.equal(api.parseFinancialOpening('').amount, null);
  assert.equal(api.parseFinancialOpening('0').amount, 0);
  assert.equal(api.parseFinancialOpening('1 234,50').amount, 1234.5);
  assert.equal(api.parseFinancialOpening('-250.25').amount, -250.25);
  for (const input of ['abc', '1,2,3', '12.345', 'Infinity', '1000000000001']) assert.ok(api.parseFinancialOpening(input).error, input);
});

test('percentage comparisons do not imply percentage growth from zero or negative profit', () => {
  const api = uiModule();
  assert.equal(api.financialComparison(200, 100).tone, 'good');
  assert.match(api.financialComparison(200, 100).text, /100%/);
  assert.equal(api.financialComparison(90, 100, true).tone, 'good');
  assert.doesNotMatch(api.financialComparison(100, 0).text, /%|Infinity/);
  assert.doesNotMatch(api.financialComparison(50, -100).text, /%/);
  assert.equal(api.financialComparison(100, 100).text, 'Без змін');
  assert.equal(api.financialMoney(NaN), '—');
});

test('cash is unknown until entered; local estimates include known movement and commitments without requests', () => {
  const api = uiModule(), container = documentFixture();
  const cleanup = api.renderFinancialOverview(container, reportFixture());
  const cards = all(container, cls('fo-card'));
  const cash = cards.find(card => card.textContent.includes('Розрахунковий залишок'));
  const free = cards.find(card => card.textContent.includes('Після поточних зобов’язань'));
  assert.equal(find(cash, cls('fo-card-value')).textContent, '—');
  const input = find(container, cls('fo-cash-input'));
  input.value = '1 000,50'; input.dispatchEvent({ type: 'input' });
  assert.equal(find(cash, cls('fo-card-value')).textContent, `≈ ${api.financialMoney(800.5)}`);
  assert.equal(find(free, cls('fo-card-value')).textContent, `≈ ${api.financialMoney(300.5)}`);
  input.value = 'wrong'; input.dispatchEvent({ type: 'input' });
  assert.equal(find(cash, cls('fo-card-value')).textContent, '—');
  assert.equal(input.attributes['aria-invalid'], 'true');
  cleanup(); assert.equal(container.children.length, 0);
});

test('rendering treats employee data as text and only safe source reports have drilldowns', () => {
  const api = uiModule(), container = documentFixture(), events = [];
  container.addEventListener('sto:financial-drilldown', event => events.push(event.detail));
  const cleanup = api.renderFinancialOverview(container, reportFixture());
  assert.equal(find(container, cls('fo-person-name')).textContent, '<img src=x onerror=alert(1)>');
  assert.equal(all(container, node => node.tagName === 'IMG').length, 0);
  const turnover = all(container, node => node.tagName === 'BUTTON').find(button => button.textContent.includes('Загальний оборот'));
  turnover.dispatchEvent({ type: 'click' });
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [{ kind: 'turnover', from: '2026-10-01', to: '2026-10-25' }]);
  assert.equal(all(container, node => node.tagName === 'BUTTON' && /Борг клієнтів|Гроші в залишках|img src|Виплачено зарплати/.test(node.textContent)).length, 0);
  cleanup(); turnover.dispatchEvent({ type: 'click' }); assert.equal(events.length, 1);
});

test('payroll grand totals use full server totals when employee list is bounded', () => {
  const api = uiModule(), container = documentFixture(), report = reportFixture();
  report.employeeCount = 201; report.current.payrollAccrued = 123456; report.current.payrollPaid = 99999;
  api.renderFinancialOverview(container, report);
  const salaryTable = find(container, node => node.tagName === 'TABLE' && node.attributes['aria-label']?.startsWith('Нарахування'));
  const footer = find(salaryTable, node => node.tagName === 'TFOOT');
  assert.match(footer.textContent, /123/); assert.ok(footer.textContent.includes(api.financialMoney(123456)));
  assert.ok(footer.textContent.includes(api.financialMoney(99999)));
  assert.equal(footer.lastElementChild.lastElementChild.textContent, '—');
  assert.match(container.textContent, /Показано 1 із 201 працівників/);
});

test('uncertain profit and excluded manual sums are visible next to affected cards', () => {
  const api = uiModule(), container = documentFixture(), report = reportFixture();
  report.quality.warnings.push({ code: 'missing_parts_cost', message: 'Немає собівартості', count: 2, amount: 0, severity: 'warning' });
  report.expenseCategories.push({ category: 'Обладнання', accrued: 500, paid: 500, included: false, cashIncluded: true });
  api.renderFinancialOverview(container, report);
  const cards = all(container, cls('fo-card'));
  const profit = cards.find(card => card.textContent.includes('Попередній прибуток'));
  assert.match(find(profit, cls('fo-card-value')).textContent, /^≈/);
  assert.ok(profit.textContent.includes(`Окремо, без віднімання: ${api.financialMoney(100)}`));
  const paid = cards.find(card => card.textContent.includes('Сплачено за період'));
  assert.ok(paid.textContent.includes(`Не включено оплат: ${api.financialMoney(50)}`));
  assert.match(container.textContent, /Лише рух грошей/);
});

for (const code of ['payroll_coverage', 'unassigned_salary', 'invalid_act_values']) {
  test(`${code} makes affected financial totals visibly provisional`, () => {
    const api = uiModule(), container = documentFixture(), report = reportFixture();
    report.quality.warnings.push({ code, message: 'Потребує перевірки', count: 1, amount: 0, severity: 'warning' });
    api.renderFinancialOverview(container, report);
    const cards = all(container, cls('fo-card'));
    const profit = cards.find(card => card.textContent.includes('Попередній прибуток'));
    assert.ok(profit, 'Profit must be explicitly provisional');
    assert.match(find(profit, cls('fo-card-value')).textContent, /^≈/);
    const gross = cards.find(card => card.textContent.includes('Заробіток до зарплат'));
    if (code === 'invalid_act_values') {
      assert.match(find(gross, cls('fo-card-value')).textContent, /^≈/);
      assert.match(find(profit, cls('fo-card-note')).textContent, /Суми актів/);
      assert.match(find(gross, cls('fo-card-note')).textContent, /Суми актів/);
    } else {
      assert.doesNotMatch(find(gross, cls('fo-card-value')).textContent, /^≈/);
    }
  });
}
