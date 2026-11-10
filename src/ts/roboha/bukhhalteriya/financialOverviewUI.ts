import type { FinancialOverview, FinancialWarning } from './financialOverviewTypes';

export type FinancialDrilldownKind = 'turnover' | 'workRevenue' | 'partsRevenue' | 'expenses' | 'payroll';
export interface FinancialDrilldown {
  kind: FinancialDrilldownKind;
  from: string;
  to: string;
}

const moneyFormatter = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const percentFormatter = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });

export function financialMoney(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${moneyFormatter.format(Object.is(value, -0) ? 0 : value)} грн`;
}

/** A negative/zero comparison baseline must not produce misleading percentages. */
export function financialComparison(current: number, previous: number, lowerIsBetter = false): {
  text: string;
  tone: 'good' | 'bad' | 'neutral';
  description: string;
} {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return { text: 'Немає порівняння', tone: 'neutral', description: '' };
  const delta = Math.round((current - previous) * 100) / 100;
  const description = `Попередній період: ${financialMoney(previous)}. Зміна: ${delta > 0 ? '+' : ''}${financialMoney(delta)}.`;
  if (delta === 0) return { text: 'Без змін', tone: 'neutral', description };
  const tone = (lowerIsBetter ? delta < 0 : delta > 0) ? 'good' : 'bad';
  const text = previous > 0
    ? `${delta > 0 ? '↑ +' : '↓ '}${percentFormatter.format(delta / previous * 100)}%`
    : `Було ${financialMoney(previous)}`;
  return { text, tone, description };
}

/** Blank is unknown, never a zero opening balance. No financial input is persisted. */
export function parseFinancialOpening(value: string): { amount: number | null; error: string | null } {
  const normalized = value.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!normalized) return { amount: null, error: null };
  if (!/^[+-]?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) {
    return { amount: null, error: 'Введіть суму з не більш як двома знаками після коми.' };
  }
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || Math.abs(amount) > 1_000_000_000_000) {
    return { amount: null, error: 'Перевірте введену суму.' };
  }
  return { amount, error: null };
}

function dateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function timestampLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(date)
    : '';
}

function roleClass(role: string): string {
  if (role === 'Приймальник') return 'receiver';
  if (role === 'Слюсар') return 'mechanic';
  if (role === 'Запчастист' || role === 'Складовщик') return 'parts';
  if (role === 'Адміністратор') return 'admin';
  return 'other';
}

interface CardOptions {
  label: string;
  amount: number | null;
  note: string;
  previous?: number;
  lowerIsBetter?: boolean;
  tone?: 'highlight' | 'funds';
  drilldown?: FinancialDrilldownKind;
  approximate?: boolean;
  alert?: string;
}

/** Render an already aggregated report. It performs no reads, writes or polling. */
export function renderFinancialOverview(container: HTMLElement, report: FinancialOverview): () => void {
  const doc = container.ownerDocument;
  const root = doc.createElement('section');
  root.className = 'financial-overview';
  root.setAttribute('aria-label', 'Фінансове зведення СТО');
  const cleanups: Array<() => void> = [];
  const current = report.current;
  const previous = report.previous;
  const uncertainCost = report.quality.warnings.some(warning => ['missing_parts_cost', 'missing_parts_rows', 'mutable_parts_cost'].includes(warning.code));
  const uncertainPayroll = report.quality.warnings.some(warning => ['invalid_payroll', 'duplicate_payroll', 'payroll_pending', 'payroll_coverage', 'unassigned_salary'].includes(warning.code));
  const uncertainAmounts = report.quality.warnings.some(warning => warning.code === 'invalid_act_values');
  const uncertainProfit = uncertainCost || uncertainPayroll || uncertainAmounts;
  const excludedExpenseNote = current.excludedExpenses !== 0 ? `Окремо, без віднімання: ${financialMoney(current.excludedExpenses)}` : undefined;
  const excludedPaymentNote = current.excludedExpensesPaid !== 0 ? `Не включено оплат: ${financialMoney(current.excludedExpensesPaid)}` : undefined;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function bindDrilldown(button: HTMLButtonElement, kind: FinancialDrilldownKind): void {
    button.type = 'button';
    const listener = () => container.dispatchEvent(new CustomEvent<FinancialDrilldown>('sto:financial-drilldown', {
      bubbles: true, detail: { kind, from: report.from, to: report.to },
    }));
    button.addEventListener('click', listener);
    cleanups.push(() => button.removeEventListener('click', listener));
  }

  function card(options: CardOptions): { element: HTMLElement; value: HTMLElement; note: HTMLElement } {
    const element = options.drilldown ? el('button') : el('article');
    element.className = `fo-card${options.tone ? ` fo-card--${options.tone}` : ''}`;
    if (options.drilldown) {
      bindDrilldown(element as HTMLButtonElement, options.drilldown);
      element.title = 'Відкрити докладний звіт за цей період';
    }
    const label = el('span', 'fo-card-label', options.label);
    const value = el('strong', 'fo-card-value', `${options.approximate && options.amount !== null ? '≈ ' : ''}${financialMoney(options.amount)}`);
    value.classList.toggle('is-negative', options.amount !== null && options.amount < 0);
    const note = el('span', 'fo-card-note', options.note);
    element.append(label, value);
    if (options.previous !== undefined && options.amount !== null) {
      const comparison = financialComparison(options.amount, options.previous, options.lowerIsBetter);
      const trend = el('span', `fo-trend is-${comparison.tone}`, comparison.text);
      trend.title = comparison.description;
      trend.setAttribute('aria-label', comparison.description);
      element.append(trend);
    }
    element.append(note);
    if (options.alert) element.append(el('span', 'fo-card-warning', options.alert));
    return { element, value, note };
  }

  function section(title: string, description?: string): { element: HTMLElement; header: HTMLElement; body: HTMLElement } {
    const element = el('section', 'fo-section');
    const header = el('div', 'fo-section-header');
    const intro = el('div');
    intro.append(el('h3', 'fo-section-title', title));
    if (description) intro.append(el('p', 'fo-description', description));
    header.append(intro);
    const body = el('div', 'fo-section-body');
    element.append(header, body);
    return { element, header, body };
  }

  function breakdownRow(container: HTMLElement, label: string, amount: number, total = false): void {
    const row = el('div', `fo-breakdown-row${total ? ' is-total' : ''}`);
    const money = el('span', `fo-money${amount < 0 ? ' is-negative' : ''}`, financialMoney(amount));
    row.append(el('span', '', label), money);
    container.append(row);
  }

  function actionButton(header: HTMLElement, text: string, kind: FinancialDrilldownKind): void {
    const button = el('button', 'fo-inline-button', text);
    bindDrilldown(button, kind);
    header.append(button);
  }

  function warningDetails(warnings: FinancialWarning[]): HTMLElement {
    if (warnings.length === 0) {
      return el('p', 'fo-quality fo-quality--ok', 'Підсумки сформовано за наявними обліковими записами.');
    }
    const details = el('details', 'fo-quality');
    const serious = warnings.some(warning => warning.severity === 'warning');
    details.append(el('summary', '', `${serious ? 'Є дані, які потребують уточнення' : 'Що враховано в розрахунку'} · ${warnings.length}`));
    const list = el('ul');
    for (const warning of warnings) {
      const suffix = [warning.count > 0 ? `записів: ${moneyFormatter.format(warning.count)}` : '', warning.amount !== 0 ? financialMoney(warning.amount) : ''].filter(Boolean);
      list.append(el('li', '', warning.message + (suffix.length ? ` (${suffix.join('; ')})` : '')));
    }
    details.append(list);
    return details;
  }

  const heading = el('div', 'fo-header');
  const headingText = el('div');
  headingText.append(el('span', 'fo-eyebrow', 'Аналітика СТО'), el('h2', 'fo-title', 'Фінансове зведення'));
  headingText.append(el('p', 'fo-period', `${dateLabel(report.from)} — ${dateLabel(report.to)} · порівняння з ${dateLabel(report.previousFrom)} — ${dateLabel(report.previousTo)}`));
  heading.append(headingText);
  const updated = timestampLabel(report.generatedAt);
  if (updated) heading.append(el('span', 'fo-updated', `Оновлено ${updated}`));
  root.append(heading, warningDetails(report.quality.warnings));

  const cards = el('div', 'fo-cards');
  const mainCards: CardOptions[] = [
    { label: 'Загальний оборот', amount: current.turnover, previous: previous.turnover, note: 'Закриті акти періоду, після знижок', tone: 'highlight', drilldown: 'turnover' },
    { label: uncertainProfit ? 'Попередній прибуток за обліком' : 'Прибуток за обліком', amount: current.profit, previous: previous.profit, note: uncertainAmounts ? 'Суми актів потребують перевірки; розрахунок може бути неповним' : uncertainProfit ? 'Собівартість або зарплата потребують уточнення' : 'Після собівартості, зарплат та включених витрат', tone: 'highlight', approximate: uncertainProfit, alert: excludedExpenseNote },
    { label: 'Заробіток до зарплат і витрат', amount: current.grossEarnings, previous: previous.grossEarnings, note: uncertainAmounts ? 'Суми актів потребують перевірки; розрахунок може бути неповним' : uncertainCost ? 'Собівартість частини деталей потребує уточнення' : 'Роботи та націнка на продані деталі', approximate: uncertainCost || uncertainAmounts },
    { label: 'Витрати на роботу СТО', amount: current.operatingExpenses, previous: previous.operatingExpenses, lowerIsBetter: true, note: 'За датами витрат; перелік категорій нижче', drilldown: 'expenses', alert: excludedExpenseNote },
    { label: 'Нарахована зарплата', amount: current.payrollAccrued, previous: previous.payrollAccrued, note: 'Усі працівники за закритими актами періоду', drilldown: 'payroll' },
    { label: 'Сплачено за період', amount: current.totalPaid, previous: previous.totalPaid, lowerIsBetter: true, note: 'Відомі виплати працівникам, постачальникам і витрати', alert: excludedPaymentNote },
  ];
  for (const options of mainCards) cards.append(card(options).element);
  const cashCard = card({ label: 'Розрахунковий залишок грошей', amount: null, note: 'Введіть початковий залишок у блоці «Рух грошей»', tone: 'funds', alert: excludedPaymentNote });
  const freeCashCard = card({ label: 'Після поточних зобов’язань', amount: null, note: 'Орієнтир за залишком грошей та облікованими боргами', tone: 'funds' });
  cards.append(cashCard.element, freeCashCard.element);
  root.append(cards);

  const balanceCards = el('div', 'fo-cards');
  balanceCards.append(
    card({ label: 'Борг клієнтів', amount: report.balances.receivables, note: `За обліковими записами на ${dateLabel(report.balances.asOf)}` }).element,
    card({ label: 'Зобов’язання СТО', amount: report.balances.totalLiabilities, note: 'Зарплата, постачальники й включені неоплачені витрати' }).element,
    card({ label: 'Гроші в залишках складу зараз', amount: report.inventory.value, note: `${moneyFormatter.format(report.inventory.count)} позицій · поточна закупівельна вартість` }).element,
  );
  root.append(balanceCards);

  const breakdown = el('div', 'fo-grid');
  const workSection = section('Роботи', 'Закриті акти вибраного періоду');
  actionButton(workSection.header, 'Акти за період', 'workRevenue');
  breakdownRow(workSection.body, 'Вартість робіт після знижок', current.workRevenue);
  breakdownRow(workSection.body, 'Зарплата за роботи', current.workPayroll);
  breakdownRow(workSection.body, 'Залишається до інших витрат', current.workRevenue - current.workPayroll, true);
  const partsSection = section('Деталі', 'Продані у закритих актах періоду');
  actionButton(partsSection.header, 'Акти за період', 'partsRevenue');
  breakdownRow(partsSection.body, 'Продаж після знижок', current.partsRevenue);
  breakdownRow(partsSection.body, 'Собівартість проданих деталей', current.partsCost);
  breakdownRow(partsSection.body, 'Зарплата за деталі', current.partsPayroll);
  breakdownRow(partsSection.body, 'Залишається до інших витрат', current.partsRevenue - current.partsCost - current.partsPayroll, true);
  if (uncertainCost) partsSection.body.append(el('p', 'fo-card-warning', 'Попередній розрахунок: частина закупівельних цін відсутня або взята з поточного складу.'));
  breakdown.append(workSection.element, partsSection.element);
  root.append(breakdown);

  const cashSection = section('Рух грошей', 'Відомі надходження та виплати за датами оплати. Аванси без дати надходження показано окремо.');
  breakdownRow(cashSection.body, 'Оплати клієнтів, віднесені до періоду', current.settledReceipts);
  breakdownRow(cashSection.body, 'Виплачено зарплати', current.payrollPaid);
  breakdownRow(cashSection.body, 'Сплачено постачальникам', current.suppliersPaid);
  breakdownRow(cashSection.body, 'Сплачено включені витрати', current.expensesPaid);
  breakdownRow(cashSection.body, 'Різниця відомих надходжень і виплат', current.netKnownMovement, true);
  if (report.balances.undatedAdvances !== 0) breakdownRow(cashSection.body, 'Аванси без підтвердженої дати надходження', report.balances.undatedAdvances);
  if (current.excludedExpensesPaid !== 0) {
    cashSection.body.append(el('p', 'fo-footnote', `${financialMoney(current.excludedExpensesPaid)} оплат ручних записів потребують класифікації й не включені до розрахункового руху грошей.`));
  }
  if (report.paymentChannels.length > 0) {
    const channels = el('details', 'fo-channels');
    channels.append(el('summary', '', 'За способами оплати'));
    const table = el('table', 'fo-table');
    table.setAttribute('aria-label', 'Відомі надходження та виплати за способами оплати');
    const thead = el('thead'); const headings = el('tr');
    for (const text of ['Спосіб оплати', 'Надходження', 'Виплати']) {
      const th = el('th', '', text); th.scope = 'col'; headings.append(th);
    }
    thead.append(headings); const tbody = el('tbody');
    for (const channel of report.paymentChannels) {
      const row = el('tr');
      row.append(el('td', '', channel.method || 'Не визначено'), el('td', '', financialMoney(channel.incoming)), el('td', '', financialMoney(channel.outgoing)));
      tbody.append(row);
    }
    table.append(thead, tbody); const wrap = el('div', 'fo-table-wrap'); wrap.append(table);
    channels.append(wrap, el('p', 'fo-footnote', 'Наведено рух за вказаним способом оплати. Якщо спосіб не записаний, суму показано як «Не визначено».'));
    cashSection.body.append(channels);
  }
  const cashControls = el('div', 'fo-cash-controls');
  const cashLabel = el('label', 'fo-cash-label', `Ваш залишок грошей на початок ${dateLabel(report.from)}`);
  const openingInput = el('input', 'fo-cash-input');
  openingInput.type = 'text';
  openingInput.inputMode = 'decimal';
  openingInput.autocomplete = 'off';
  openingInput.placeholder = 'Введіть суму, грн';
  openingInput.setAttribute('aria-label', `Початковий залишок грошей на ${dateLabel(report.from)}`);
  cashLabel.append(openingInput);
  cashControls.append(cashLabel);
  const inputError = el('p', 'fo-cash-error');
  inputError.setAttribute('aria-live', 'polite');
  const cashResult = el('p', 'fo-footnote', 'Це допоміжний розрахунок для цього перегляду. Введена сума не записується в облік.');
  cashSection.body.append(cashControls, inputError, cashResult, el('p', 'fo-footnote', 'Повного журналу готівки й банківських операцій у старих записах немає. Цей залишок є оцінкою; аванси без дат, повернення та незафіксовані операції можуть змінити фактичну суму.'));
  root.append(cashSection.element);

  const updateOpening = () => {
    const parsed = parseFinancialOpening(openingInput.value);
    openingInput.setAttribute('aria-invalid', String(parsed.error !== null));
    inputError.textContent = parsed.error || '';
    const balance = parsed.amount === null ? null : Math.round((parsed.amount + current.netKnownMovement) * 100) / 100;
    const free = balance === null ? null : Math.round((balance - report.balances.totalLiabilities) * 100) / 100;
    cashCard.value.textContent = balance === null ? '—' : `≈ ${financialMoney(balance)}`;
    cashCard.value.classList.toggle('is-negative', balance !== null && balance < 0);
    cashCard.note.textContent = balance === null ? 'Введіть початковий залишок у блоці «Рух грошей»' : 'Введений залишок + відомий рух грошей';
    freeCashCard.value.textContent = free === null ? '—' : `≈ ${financialMoney(free)}`;
    freeCashCard.value.classList.toggle('is-negative', free !== null && free < 0);
    cashResult.textContent = balance === null
      ? 'Це допоміжний розрахунок для цього перегляду. Введена сума не записується в облік.'
      : `Орієнтовно на кінець періоду: ${financialMoney(balance)}. Після облікованих зобов’язань: ${financialMoney(free)}.`;
  };
  openingInput.addEventListener('input', updateOpening);
  cleanups.push(() => openingInput.removeEventListener('input', updateOpening));

  const liabilities = section('Зобов’язання СТО', `На ${dateLabel(report.balances.asOf)}, відновлено з поточних облікових записів`);
  breakdownRow(liabilities.body, 'Залишилося виплатити працівникам', report.balances.payroll);
  breakdownRow(liabilities.body, 'Борг постачальникам', report.balances.suppliers);
  breakdownRow(liabilities.body, 'Включені неоплачені витрати', report.balances.expenses);
  breakdownRow(liabilities.body, 'Разом зобов’язань', report.balances.totalLiabilities, true);
  root.append(liabilities.element);

  const payroll = section('Зарплата за працівниками', 'Нараховано — за закритими актами періоду. Виплачено — за датами виплат, у тому числі за іншими актами. Борг і переплата — на дату «До».');
  actionButton(payroll.header, 'Нарахування за період', 'payroll');
  if (report.employees.length === 0) {
    payroll.body.append(el('p', 'fo-empty', 'За вибраний період немає зарплатних сум або залишків до виплати.'));
  } else {
    const wrap = el('div', 'fo-table-wrap');
    wrap.tabIndex = 0;
    wrap.setAttribute('aria-label', 'Зарплати працівників; таблицю можна прокрутити горизонтально');
    const table = el('table', 'fo-table');
    table.setAttribute('aria-label', 'Нарахування, виплати та залишки зарплати за працівниками');
    const thead = el('thead');
    const headings = el('tr');
    for (const text of ['Працівник', 'Нараховано', 'Виплачено за період', 'До виплати', 'Переплата']) {
      const th = el('th', '', text); th.scope = 'col'; headings.append(th);
    }
    thead.append(headings);
    const tbody = el('tbody');
    for (const employee of report.employees) {
      const row = el('tr');
      const personCell = el('td');
      const person = el('div', 'fo-person');
      person.append(el('span', 'fo-person-name', employee.name || 'Без ПІБ'), el('span', `fo-role fo-role--${roleClass(employee.role)}`, employee.role || 'Працівник'));
      personCell.append(person); row.append(personCell);
      for (const amount of [employee.accrued, employee.paidInPeriod, employee.due, employee.overpaid]) row.append(el('td', '', financialMoney(amount)));
      tbody.append(row);
    }
    const tfoot = el('tfoot');
    const totals = el('tr');
    totals.append(el('td', '', 'Усі працівники'));
    const completeEmployeeList = report.employees.length >= report.employeeCount;
    const overpaid = completeEmployeeList ? report.employees.reduce((sum, employee) => sum + employee.overpaid, 0) : null;
    for (const amount of [current.payrollAccrued, current.payrollPaid, report.balances.payroll, overpaid]) totals.append(el('td', '', financialMoney(amount)));
    tfoot.append(totals); table.append(thead, tbody, tfoot); wrap.append(table);
    payroll.body.replaceWith(wrap);
    if (!completeEmployeeList) {
      payroll.element.append(el('p', 'fo-footnote fo-section-body', `Показано ${report.employees.length} із ${report.employeeCount} працівників. Загальні підсумки охоплюють усіх.`));
    }
  }
  root.append(payroll.element);

  const expenses = section('Витрати за категоріями', 'Операційні витрати впливають на прибуток. Обладнання й кредити враховано лише в русі грошей. Можливі дублікати зарплат, деталей та авансів потребують класифікації.');
  actionButton(expenses.header, 'Усі записи витрат', 'expenses');
  if (report.expenseCategories.length === 0) {
    expenses.body.append(el('p', 'fo-empty', 'За вибраний період немає записаних витрат.'));
  } else {
    const wrap = el('div', 'fo-table-wrap');
    wrap.tabIndex = 0;
    const table = el('table', 'fo-table');
    table.setAttribute('aria-label', 'Категорії витрат за період');
    const thead = el('thead'); const headings = el('tr');
    for (const text of ['Категорія', 'За датою витрати', 'Сплачено за період']) {
      const th = el('th', '', text); th.scope = 'col'; headings.append(th);
    }
    thead.append(headings);
    const tbody = el('tbody');
    for (const category of report.expenseCategories) {
      const row = el('tr');
      const label = el('td');
      const categoryLabel = el('div', 'fo-person');
      categoryLabel.append(el('span', '', category.category || 'Без категорії'));
      if (!category.included) categoryLabel.append(el('span', category.cashIncluded ? 'fo-tag' : 'fo-tag fo-tag--warning', category.cashIncluded ? 'Лише рух грошей' : 'Потребує класифікації'));
      label.append(categoryLabel); row.append(label, el('td', '', financialMoney(category.accrued)), el('td', '', financialMoney(category.paid)));
      tbody.append(row);
    }
    const tfoot = el('tfoot'); const total = el('tr');
    total.append(el('td', '', 'Включено: у прибуток / у рух грошей'), el('td', '', financialMoney(current.operatingExpenses)), el('td', '', financialMoney(current.expensesPaid)));
    tfoot.append(total); table.append(thead, tbody, tfoot); wrap.append(table); expenses.body.replaceWith(wrap);
    if (current.excludedExpenses !== 0) expenses.element.append(el('p', 'fo-footnote fo-section-body', `Окремі ручні суми, які не віднімаються з операційного прибутку: ${financialMoney(current.excludedExpenses)}. Призначення кожної категорії вказано вище.`));
  }
  root.append(expenses.element);

  const performance = section('Обсяг роботи за період');
  breakdownRow(performance.body, 'Закрито актів', current.closedActs);
  const countValue = performance.body.lastElementChild?.lastElementChild;
  if (countValue) countValue.textContent = moneyFormatter.format(current.closedActs);
  breakdownRow(performance.body, 'Середній чек після знижок', current.avgCheck);
  root.append(performance.element);
  root.append(el('p', 'fo-footnote', 'Оборот і прибуток рахуються за всіма закритими актами обраного періоду. Прокрутка таблиць не змінює підсумки. Залишки складу показують поточний стан, а зобов’язання відновлюються з наявних записів на дату «До».'));

  container.replaceChildren(root);
  return () => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    root.remove();
  };
}
