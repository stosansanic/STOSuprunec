const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const ts = require('typescript');

const base = {from:'2026-10-01', to:'2026-10-31', mode:'open', payment:'all', status:'all', percentage:'all', name:'', act:'', work:'Work'};
const day = '01.10.2026', revision = 'a'.repeat(32);
const compilerOptions = {module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022};
const sourceFile = 'src/ts/roboha/bukhhalteriya/zarplata.ts';
const ast = ts.createSourceFile(sourceFile, fs.readFileSync(sourceFile, 'utf8'), 99, true);
const functions = ['preparePayrollPaymentSource','findPayrollPaymentTarget','capturePayrollPayments','payrollPaymentScope',
  'replacePayrollPaymentTarget','executePayrollPaymentSelection','runMassPaymentCalculationOnce'];
const source = ast.statements.filter(node => ts.isFunctionDeclaration(node) && functions.includes(node.name?.text))
  .map(node => node.getText(ast).replace(/^export /, '')).join('\n');

function fixture({count = 137, employees = 2, paid = 10, options = {}} = {}) {
  const calls = [], writes = [], notices = [], confirmations = [], modules = new Map();
  let actor = 'admin', version = revision;
  const all = Array.from({length:count}, (_, index) => ({id:index % employees + 1, act:String(index + 1),
    work:{recordId:`row-${index}`, Робота:'Work', Кількість:1, Ціна:100, Зарплата:20,
      ...(index < paid ? {Розраховано:day} : {})}}));
  // This record is outside the work filter and must never enter a payment plan.
  const unrelated = {id:99, act:'99999', work:{recordId:'outside', Робота:'Other', Кількість:1, Ціна:100, Зарплата:500}};
  const db = [...all, unrelated];
  function page(offset = 0, limit = 50) {
    const matching = db.filter(row => row.work.Робота.includes(ctx.filters.work || '') &&
      (!ctx.filters.name || `Worker ${row.id}` === ctx.filters.name));
    const selected = matching.slice(offset, offset + limit), grouped = new Map();
    for (const row of selected) {
      if (!grouped.has(row.id)) grouped.set(row.id, {slyusar_id:row.id, data:{Name:`Worker ${row.id}`, ПроцентРоботи:20, Історія:{[day]:[]}}});
      grouped.get(row.id).data.Історія[day].push({Акт:row.act, __report_entry_revision:version, __report_work_indexes:[0], Записи:[structuredClone(row.work)]});
    }
    const states = matching.map(row => payments.getPayrollPaymentState(row.work));
    return {format_version:4, page_size:limit, revision:version, employees:[...grouped.values()],
      keys:selected.map(row => [row.id, day, row.act, 0]), statuses:[], total:matching.length,
      revenue:matching.length * 100, salary:matching.length * 20, paidAmount:states.reduce((sum, state) => sum + state.paidAmount, 0),
      due:states.reduce((sum, state) => sum + state.due, 0), overpaid:0,
      paidInPeriod:states.reduce((sum, state) => sum + state.paidAmount, 0),
      has_more:offset + limit < matching.length, acts:[], works:['Work']};
  }
  const supabase = {auth:{onAuthStateChange() {}}, rpc(name, args) {
    if (name === 'traffic_payroll_report_v4') {
      calls.push(structuredClone(args));
      return {abortSignal:async () => {
        if (options.onRead) await options.onRead(ctx, args, calls.length);
        if (options.readError && args.p_offset) return {error:{message:'Read failed', code:'57014'}};
        const result = page(args.p_offset, args.p_filters.page_size);
        if (options.stale && args.p_offset) result.revision = 'c'.repeat(32);
        return {data:result};
      }};
    }
    assert.equal(name, 'write_payroll_report_payment_batch');
    writes.push(structuredClone(args));
    if (options.writeError) return Promise.resolve({error:{message:'Payment conflict', code:'40001'}});
    const fragments = [];
    for (const employee of args.p_employees) for (const change of employee.changes) {
      assert.equal(change.entry_revision, version);
      const row = db.find(row => row.id === employee.id && row.act === String(change.act_id));
      assert.ok(row); assert.deepEqual(structuredClone(change.expected), row.work);
      assert.equal(change.target, 'record'); assert.equal(change.index, 0);
      Object.assign(row.work, structuredClone(change.desired));
      fragments.push({id:employee.id, act:change.act_id, date:day, revision:'b'.repeat(32)});
    }
    version = 'b'.repeat(32);
    return Promise.resolve({data:{receipts:args.p_employees.map(row => ({slyusar_id:row.id, status:'updated'})), fragments}});
  }};
  const common = {structuredClone, AbortController, Date, Intl, crypto:{randomUUID},
    localStorage:{getItem:() => actor}, window:{addEventListener() {}}, document:{addEventListener() {}}};
  function load(file) {
    file = path.resolve(file);
    if (modules.has(file)) return modules.get(file);
    const exports = {}; modules.set(file, exports);
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions}).outputText,
      {...common, exports, require:name => name.endsWith('supabaseClient') ? {supabase} :
        name.endsWith('vspluvauhe_povidomlenna') ? {showNotification() {}} : load(path.resolve(path.dirname(file), name + '.ts'))});
    return exports;
  }
  const payments = load('src/ts/utils/payrollPayments.ts');
  const safe = load('src/ts/utils/payrollSafeWrite.ts');
  const reader = load('src/ts/roboha/bukhhalteriya/payrollReportRead.ts');
  const writer = load('src/ts/roboha/bukhhalteriya/payrollReportPaymentWrite.ts');
  const fragments = load('src/ts/roboha/bukhhalteriya/payrollReportFragments.ts');
  const period = load('src/ts/roboha/bukhhalteriya/accountingPeriod.ts');
  const ctx = {...common, ...payments, ...safe, ...reader, ...writer, ...fragments,
    filters:{...base}, payrollReportGeneration:1, payrollVisibleCount:77, payrollReport:null,
    slyusarsData:[], podlegleData:[], allPodlegleData:[], payrollSearchFailed:false,
    lastSearchDateOpen:base.from, lastSearchDateClose:base.to,
    accountingSearchScope:period.accountingSearchScope, currentPayrollFilters:() => ({...ctx.filters}),
    hasFullAccess:() => actor === 'admin', formatNumber:String, getCurrentDate:() => '29.10.2026',
    payrollRowKey:row => JSON.stringify([row.employeeId, row.dateOpen, String(row.act), row.workIndex ?? null]),
    announceAccountingChange() {}, updatepodlegleTable() {}, payrollScroll:{pause() {}},
    showNotification:(...args) => notices.push(args),
    payrollRecordSettlement:target => { const state = payments.getPayrollPaymentState(target); return {isPaid:state.isPaid, due:state.due}; },
    createPasswordConfirmationModal:async (action, message, current) => {
      confirmations.push({action, message});
      // Loading a complete payment snapshot must not replace the visible table before approval.
      assert.equal(ctx.podlegleData.length, Math.min(count, 100));
      assert.equal(ctx.payrollVisibleCount, 77);
      if (options.onConfirm) await options.onConfirm(ctx);
      return options.confirm !== false && current();
    },
    applyPayrollReport(report) {
      const next = ctx.preparePayrollPaymentSource(report);
      ctx.payrollReport = report; ctx.slyusarsData = next.employees;
      ctx.podlegleData = next.records; ctx.allPodlegleData = [...next.records];
    }};
  vm.createContext(ctx);
  vm.runInContext(ts.transpileModule(source, {compilerOptions}).outputText, ctx);
  ctx.applyPayrollReport(page(0, 100));
  return {ctx, calls, writes, notices, confirmations, all, unrelated, page,
    setActor(value) { actor = value; }, run:() => ctx.runMassPaymentCalculationOnce()};
}

test('77 visible of 100 fetched still settles every unpaid match across all pages and employees', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.calls.map(args => args.p_offset), [0, 50, 100]);
  for (const args of f.calls) assert.deepEqual(args.p_filters, {...base, page_size:50});
  assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0].message, /2540 грн.*127 неоплаченими/);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].p_employees.length, 2);
  assert.equal(f.writes[0].p_employees.flatMap(row => row.changes).length, 127);
  assert.ok(f.all.every(row => row.work.Розраховано));
  assert.equal(f.unrelated.work.Розраховано, undefined);
  assert.equal(f.ctx.payrollReport.due, 0);
  assert.equal(f.ctx.payrollVisibleCount, 77);
  assert.match(f.notices.at(-1)[0], /2540 грн.*127 позиціями/);
  await f.run();
  assert.equal(f.writes.length, 1, 'second click cannot pay the same entries twice');
  assert.equal(f.confirmations.length, 1);
  assert.match(f.notices.at(-1)[0], /немає залишку/);
});

test('cancel preserves the original visible report and writes nothing', async () => {
  const f = fixture({options:{confirm:false}}), report = f.ctx.payrollReport, rows = f.ctx.podlegleData;
  await f.run();
  assert.equal(f.writes.length, 0); assert.equal(f.ctx.payrollReport, report); assert.equal(f.ctx.podlegleData, rows);
});

test('complete snapshots retain original work indexes and receiver/parts header payments', () => {
  const f = fixture(), report = f.page(0, 1);
  const receiver = {Акт:'9001', СуммаРоботи:100, ЗарплатаРоботи:15, __report_entry_revision:revision};
  const parts = {Акт:'9002', СуммаЗапчастин:200, ЗарплатаЗапчастин:25, __report_entry_revision:revision};
  const works = {Акт:'9003', __report_entry_revision:revision, __report_work_indexes:[7, 19], Записи:[
    {Робота:'Same', Кількість:1, Ціна:100, Зарплата:20},
    {Робота:'Same', Кількість:1, Ціна:100, Зарплата:20, Розраховано:day}]};
  report.employees = [{slyusar_id:1, data:{Name:'Worker 1', Історія:{[day]:[receiver, parts, works]}}}];
  report.keys = [[1, day, '9001', null], [1, day, '9002', null], [1, day, '9003', 7], [1, day, '9003', 19]];
  const prepared = f.ctx.preparePayrollPaymentSource(report);
  const selection = f.ctx.capturePayrollPayments(prepared.records, 'pay', prepared.employees);
  assert.equal(selection.length, 3); assert.equal(selection.reduce((sum, item) => sum + item.amount, 0), 60);
  assert.equal(selection[2].record.workIndex, 7);
  assert.equal(JSON.parse(selection[2].expected)[0].Розраховано, undefined);
});

test('payment snapshot honors an employee filter across every fetched page', async () => {
  const f = fixture({count:210, paid:0}); f.ctx.filters.name = 'Worker 2';
  f.ctx.applyPayrollReport(f.page(0, 100));
  await f.run();
  assert.equal(f.writes[0].p_employees.length, 1); assert.equal(f.writes[0].p_employees[0].id, 2);
  assert.equal(f.writes[0].p_employees[0].changes.length, 105);
  assert.ok(f.all.filter(row => row.id === 1).every(row => !row.work.Розраховано));
});

test('filter or actor changes during loading abort before confirmation and before any write', async () => {
  for (const kind of ['filter', 'actor']) {
    const f = fixture({options:{onRead:async (ctx, args) => {
      if (!args.p_offset) return;
      if (kind === 'filter') ctx.filters.work = 'Other'; else f.setActor('other');
    }}});
    await assert.rejects(f.run(), /змінився|змінилися/);
    assert.equal(f.writes.length, 0); assert.equal(f.confirmations.length, 0);
  }
});

test('stale pages and read failures never pay a partial selection', async () => {
  for (const options of [{stale:true}, {readError:true}]) {
    const f = fixture({options});
    await assert.rejects(f.run());
    assert.equal(f.writes.length, 0); assert.equal(f.confirmations.length, 0);
  }
});

test('changing filters in the confirmation cancels the captured payment', async () => {
  const f = fixture({options:{onConfirm:ctx => {ctx.filters.work = 'Other';}}});
  await f.run();
  assert.equal(f.writes.length, 0);
});

test('server payment conflicts leave the displayed data untouched and require a fresh search', async () => {
  const f = fixture({options:{writeError:true}}), report = f.ctx.payrollReport;
  await assert.rejects(f.run(), /Payment conflict/);
  assert.equal(f.ctx.payrollReport, report); assert.equal(f.ctx.payrollSearchFailed, true);
  assert.equal(f.all.filter(row => !row.work.Розраховано).length, 127);
});

test('50-employee and 2000-position limits stop paging without confirmation or partial payment', async () => {
  for (const settings of [{count:51, employees:51, paid:0}, {count:2001, employees:1, paid:0}]) {
    const f = fixture(settings);
    await assert.rejects(f.run(), /50 працівників|2000 позицій/);
    assert.equal(f.writes.length, 0); assert.equal(f.confirmations.length, 0);
  }
});
