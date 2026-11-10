const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function moduleApi(path, dependencies = {}, globals = {}) {
  const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports: api, require: () => dependencies, setTimeout, clearTimeout, setInterval, clearInterval, ...globals });
  return api;
}
const watch = moduleApi('src/ts/roboha/ai/reminderRealtime.ts');
const { createLatestCallbackReader } = moduleApi('src/ts/roboha/ai/reminderCallbackRead.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
const rule = (id, table, events = ['UPDATE'], recipient = 7) => ({ reminder_id: id, created_by: recipient,
  status: 'active', reminder_type: 'conditional', schedule: { type: 'realtime' }, recipients: 'self',
  condition_query: JSON.stringify({ table, events }), channel: 'app', trigger_count: 0 });

test('only eligible rules allocate streams; same table combines requested events', () => {
  const groups = watch.buildReminderWatchGroups([
    rule(1, 'acts'), rule(2, 'slyusars', ['UPDATE'], 8), rule(3, 'acts', ['INSERT']),
    rule(4, 'sclad', []), { ...rule(5, 'cars'), schedule: { type: 'daily' } },
  ], row => row.created_by === 7);
  assert.deepEqual([...groups.keys()], ['acts']);
  assert.equal(groups.get('acts').event, '*');
  assert.equal(groups.get('acts').entries.length, 2);
});

test('rule edits update retained transport; removed callbacks cannot deliver late events', () => {
  const subscriptions = [], received = [];
  const registry = watch.createReminderWatchRegistry((table, event, callback) => {
    const sub = { table, event, callback, removed: false };
    subscriptions.push(sub);
    return { unsubscribe() { sub.removed = true; } };
  }, (_payload, current) => received.push(current().map(entry => entry.rem.reminder_id)));
  const groups = rows => watch.buildReminderWatchGroups(rows, () => true);
  registry.replace(groups([rule(1, 'acts')]));
  registry.replace(groups([rule(2, 'acts')]));
  assert.equal(subscriptions.length, 1);
  subscriptions[0].callback({});
  assert.deepEqual([...received[0]], [2]);
  registry.replace(groups([rule(3, 'cars')]));
  assert.equal(subscriptions[0].removed, true);
  subscriptions[0].callback({});
  assert.equal(received.length, 1);
  registry.clear();
  assert.equal(subscriptions[1].removed, true);
});

test('latest callback aggregate chunks ids, and an affected single reminder reads at most one row', async () => {
  const calls = [];
  const chain = { select(columns) { calls.push(['columns', columns]); return this; }, eq(...args) { calls.push(['eq', ...args]); return this; },
    order() { return this; }, limit(value) { calls.push(['limit', value]); return Promise.resolve({ data: [{ reminder_id: 4, message_text: 'ok' }], error: null }); } };
  const read = createLatestCallbackReader({ rpc: async (_name, args) => { calls.push(['rpc', args.p_reminder_ids.length]); return { data: [], error: null }; }, from: () => chain });
  await read(Array.from({ length: 501 }, (_, index) => index + 1));
  assert.deepEqual(calls, [['rpc', 500], ['rpc', 1]]);
  calls.length = 0;
  const rows = await read([4, 4]);
  assert.equal(rows.length, 1);
  assert.ok(calls.some(call => call[0] === 'eq' && call[1] === 'reminder_id' && call[2] === 4));
  assert.ok(calls.some(call => call[0] === 'limit' && call[1] === 1));
});

test('callback fallback is only for a missing RPC; transient errors preserve caller cache', async () => {
  let rpcCalls = 0, fallbackCalls = 0;
  const chain = { select() { return this; }, eq() { return this; }, order() { return this; },
    limit(value) { assert.equal(value, 1); fallbackCalls++; return Promise.resolve({ data: [], error: null }); } };
  const read = createLatestCallbackReader({ rpc: async () => { rpcCalls++; return { error: { code: 'PGRST202' } }; }, from: () => chain });
  assert.equal((await read([1, 2])).length, 0);
  await read([1, 2]);
  assert.equal(rpcCalls, 1);
  assert.equal(fallbackCalls, 4);
  const failed = createLatestCallbackReader({ rpc: async () => ({ error: { code: '57014' } }), from: () => { throw new Error('Unexpected fallback'); } });
  await assert.rejects(failed([1, 2]), error => error.code === '57014');
});

test('missing callback RPC fallback stays complete with skewed histories and caps parallel reads', async () => {
  const history = [...Array.from({ length: 1500 }, (_, index) => ({ reminder_id: 1, log_id: 2000 - index })),
    ...Array.from({ length: 7 }, (_, index) => ({ reminder_id: index + 2, log_id: index + 1 }))];
  let active = 0, peak = 0, requests = 0;
  const read = createLatestCallbackReader({ rpc: async () => ({ error: { code: 'PGRST202' } }), from() {
    let id;
    return { select() { return this; }, eq(field, value) { if (field === 'reminder_id') id = value; return this; }, order() { return this; },
      async limit(value) {
        assert.equal(value, 1); assert.ok(id); requests++; peak = Math.max(peak, ++active);
        await new Promise(resolve => setImmediate(resolve)); active--;
        return { data: history.filter(row => row.reminder_id === id).slice(0, value), error: null };
      } };
  } });
  const rows = await read([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(Array.from(rows, row => row.reminder_id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(requests, 8); assert.equal(peak, 4); assert.equal(rows[0].log_id, 2000);
});

function checkerHarness(rows, deferred) {
  const subs = [], reads = [];
  const events = { addEventListener() {}, removeEventListener() {} };
  const registry = { subscribe(resource, receive, status) {
    const sub = { resource, receive, status, disposed: false }; subs.push(sub);
    return { unsubscribe() { sub.disposed = true; } };
  } };
  const db = { async rpc(name) {
    assert.equal(name, 'traffic_reminder_watch_page'); reads.push('atlas_reminders');
    const result = deferred ? await deferred : {data: rows,error:null};
    return {data:{items:result.data,has_more:false,next_cursor:null},error:result.error};
  }, from(table) {
    reads.push(table);
    const chain = { select() { return chain; }, eq() { return deferred || Promise.resolve({ data: rows, error: null }); },
      in() { return Promise.resolve({ data: [{ slyusar_id: 7, name: 'Name' }], error: null }); } };
    return chain;
  } };
  const localStorage = { getItem: key => key === 'userAuthData' ? JSON.stringify({ slyusar_id: 7, Доступ: 'Слюсар' }) : null, setItem() {} };
  const document = { ...events, hidden: false, getElementById: () => ({}), createElement: () => ({}), body: { appendChild() {}, contains: () => true } };
  const api = moduleApi('src/ts/roboha/ai/aiReminderChecker.ts', { supabase: db, databaseSubscriptions: registry, ...watch, createReminderInbox: () => ({wake(){},dispose(){}}) },
    { localStorage, document, window: events });
  return { api, subs, reads };
}

test('background checker patches rules without rereading the list and disposes paused/foreign tables', async () => {
  const h = checkerHarness([rule(1, 'acts'), rule(2, 'slyusars', ['UPDATE'], 8)]);
  h.api.initReminderChecker();
  h.subs[0].status('SUBSCRIBED');
  await tick(); await tick();
  assert.deepEqual(h.subs.map(sub => sub.resource.table), ['atlas_reminders', 'atlas_reminder_logs', 'acts']);
  const original = h.subs[2];
  h.subs[0].receive({ eventType: 'UPDATE', new: { ...rule(1, 'acts'), title: 'Changed title' } });
  await tick();
  assert.equal(h.subs.length, 3);
  h.subs[0].receive({ eventType: 'UPDATE', new: rule(1, 'cars') });
  await tick();
  assert.equal(original.disposed, true);
  assert.equal(h.subs[3].resource.table, 'cars');
  h.subs[0].receive({ eventType: 'UPDATE', new: { ...rule(1, 'cars'), status: 'paused' } });
  await tick();
  assert.equal(h.subs[3].disposed, true);
  assert.equal(h.reads.filter(table => table === 'atlas_reminders').length, 1);
  h.api.stopReminderChecker();
  assert.ok(h.subs.every(sub => sub.disposed));
});

test('an event delivered during the initial snapshot wins over the older snapshot', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const h = checkerHarness([], pending);
  h.api.initReminderChecker();
  h.subs[0].status('SUBSCRIBED');
  h.subs[0].receive({ eventType: 'UPDATE', new: { ...rule(1, 'acts'), status: 'paused' } });
  resolve({ data: [rule(1, 'acts')], error: null });
  await tick(); await tick();
  assert.deepEqual(h.subs.map(sub => sub.resource.table), ['atlas_reminders', 'atlas_reminder_logs']);
  h.api.stopReminderChecker();
});

function plannerHarness() {
  const path = 'src/ts/roboha/ai/aiPlanner.ts';
  const ast = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = ['ensurePlannerRealtimeSync', 'loadCallbackLogs', 'flushPlannerRefresh', 'suspendPlannerTab'];
  const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join('\n');
  const subs = [], callbackReads = [];
  const ctx = { exports: {}, REMINDER_CHANGE_COLUMNS: watch.REMINDER_CHANGE_COLUMNS, plannerSubscriptions: [],
    plannerOwner: 'owner', plannerGeneration: 1, plannerCallbackRevision: 0, plannerSnapshotLoading: false, plannerHasSnapshot: false, plannerSnapshotNeeded: false,
    plannerRefreshTimer: null, plannerRefreshRunning: false, countdownInterval: null, plannerCallbackDirty: new Set(), plannerSnapshotEvents: new Map(),
    reminders: [{ reminder_id: 1 }], callbackLogs: new Map(), currentPlannerContainer: {}, clearTimeout, clearInterval,
    isPlannerVisible: () => true, currentPlannerOwner: () => 'owner', schedulePlannerRefresh() {},
    synchronizePlannerSnapshot: async () => { throw new Error('Unexpected list reload'); },
    readLatestCallbacks: async ids => { callbackReads.push([...ids]); return [{ reminder_id: 1, message_text: 'latest', sent_at: '2026-10-23', log_id: 9 }]; },
    loadMissingPlannerCreatorNames: async () => {},
    renderPlannerPanel: async () => {}, syncTelegramAutoWithReminderList() {}, emitPlannerReminderCount() {}, applyPlannerReminderEvent() {},
    databaseSubscriptions: { subscribe(resource, receive, status) { const sub = { resource, receive, status, disposed: false }; subs.push(sub); return { unsubscribe() { sub.disposed = true; } }; } },
  };
  vm.createContext(ctx);
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText, ctx);
  return { ctx, subs, callbackReads };
}

test('technical delivery phases cause no callback reads; insert patches locally; update reads only its reminder once', async () => {
  const h = plannerHarness();
  h.ctx.ensurePlannerRealtimeSync();
  const insert = h.subs.find(sub => sub.resource.table === 'atlas_reminder_logs' && sub.resource.event === 'INSERT');
  const update = h.subs.find(sub => sub.resource.table === 'atlas_reminder_logs' && sub.resource.event === 'UPDATE');
  for (const phase of ['claimed', 'sending', 'delivered']) update.receive({ eventType: 'UPDATE', new: { reminder_id: 1, delivery_status: phase } });
  await h.ctx.flushPlannerRefresh();
  assert.equal(h.callbackReads.length, 0);
  insert.receive({ eventType: 'INSERT', new: { reminder_id: 1, log_id: 8, delivery_status: 'callback', message_text: 'new', sent_at: '2026-10-22' } });
  await h.ctx.flushPlannerRefresh();
  assert.equal(h.ctx.callbackLogs.get(1).message_text, 'new');
  assert.equal(h.callbackReads.length, 0);
  update.receive({ eventType: 'UPDATE', new: { reminder_id: 1, log_id: 8, delivery_status: 'callback' } });
  await h.ctx.flushPlannerRefresh();
  assert.deepEqual(h.callbackReads, [[1]]);
  assert.equal(h.ctx.callbackLogs.get(1).message_text, 'latest');
  h.ctx.exports.suspendPlannerTab();
  assert.ok(h.subs.every(sub => sub.disposed));
});

test('planner first join during a snapshot schedules one reconciliation of the subscription gap', () => {
  const h = plannerHarness();
  h.ctx.ensurePlannerRealtimeSync();
  h.ctx.plannerSnapshotLoading = true;
  h.subs[0].status('SUBSCRIBED');
  assert.equal(h.ctx.plannerSnapshotNeeded, true);
});

test('chat first join during its HTTP snapshot defers deletion reconciliation until rows are available', () => {
  const path = 'src/ts/roboha/ai/aiChat.ts';
  const ast = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'subscribeToMessageChanges');
  let status, reconciles = 0;
  const ctx = { realtimeMessageChatId: null, realtimeMessagesChannel: null, activeChatId: 10,
    chatMessageSnapshot: { chatId: 10, owner: 'owner', needsReconcile: false }, recentlyDeletedMessageIds: new Set(),
    stopMessageSubscription() {}, CHAT_MODAL_ID: 'chat',
    document: { hidden: false, getElementById: () => ({ classList: { contains: () => false } }) },
    localStorage: { getItem: () => 'owner' },
    databaseSubscriptions: { subscribe(_resource, _receive, onStatus) { status = onStatus; return {}; } },
    reconcileChatMessageDeletions() { reconciles++; }, removeChatMessage() {},
  };
  vm.createContext(ctx);
  vm.runInContext(ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, ctx);
  ctx.subscribeToMessageChanges(10, { closest: () => null });
  status('SUBSCRIBED');
  assert.equal(reconciles, 0); assert.equal(ctx.chatMessageSnapshot.needsReconcile, true);
  ctx.chatMessageSnapshot = null;
  status('SUBSCRIBED');
  assert.equal(reconciles, 1);
});

test('chat deletion reconciliation preserves messages after a failed query or an account/chat switch', async () => {
  const path = 'src/ts/roboha/ai/aiChat.ts';
  const ast = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'reconcileChatMessageDeletions');
  let resolve, owner = 'owner';
  const removed = [];
  const ctx = { chatRealtimeGeneration: 1, activeChatId: 10, chatHistory: [{ messageId: 1 }, { messageId: 2 }, { text: 'unsaved response' }],
    localStorage: { getItem: () => owner }, removeChatMessage: id => removed.push(id),
    loadExistingMessageIds: () => new Promise(done => { resolve = done; }) };
  vm.createContext(ctx);
  vm.runInContext(ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, ctx);
  const stale = ctx.reconcileChatMessageDeletions(10, {});
  owner = 'another';
  resolve(new Set());
  await stale;
  assert.deepEqual(removed, []);
  owner = 'owner';
  ctx.loadExistingMessageIds = async () => { throw new Error('offline'); };
  await ctx.reconcileChatMessageDeletions(10, {});
  assert.deepEqual(removed, []);
  ctx.loadExistingMessageIds = async () => new Set([2]);
  await ctx.reconcileChatMessageDeletions(10, {});
  assert.deepEqual(removed, [1]);
});
