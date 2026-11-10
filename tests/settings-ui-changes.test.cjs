const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadTracker() {
  const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/utils/settingsUiChanges.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports: api });
  return api.createSettingsUiChangeTracker;
}
const trackerFor = loadTracker();
const update = (next, old = { setting_id: next.setting_id }) => ({ eventType: 'UPDATE', new: next, old });

test('administrator Nova Poshta counters do not refresh settings even on first PK-only event', () => {
  const tracker = trackerFor('Адміністратор');
  for (let i = 0; i < 100; i++) {
    assert.equal(tracker.inspect(update({ setting_id: 10, data: true, Приймальник: true, novaposhta: { requests: i } })), 'ignore');
  }
});

test('cached role values suppress technical-only events with primary-key-only old record', () => {
  const tracker = trackerFor('Приймальник');
  tracker.seed({ setting_id: 10, Приймальник: true });
  for (let i = 0; i < 100; i++) {
    assert.equal(tracker.inspect(update({ setting_id: 10, data: false, Приймальник: true, novaposhta: { requests: i }, token: i, date: String(i), API: 'ignored' })), 'ignore');
  }
});

test('full old record suppresses technical and other-role changes and keeps simultaneous relevant edits', () => {
  const tracker = trackerFor('Приймальник');
  const old = { setting_id: 1, data: true, Приймальник: true, Слюсар: false, novaposhta: 1 };
  assert.equal(tracker.inspect(update({ ...old, Слюсар: true, novaposhta: 2 }, old)), 'ignore');
  assert.equal(tracker.inspect(update({ ...old, Приймальник: false, novaposhta: 3 }, old)), 'changed');
  assert.equal(tracker.inspect(update({ ...old, data: false, token: 2 }, old)), 'changed');
});

test('permission changes at IDs 20, 21 and 23 are preserved alongside AI columns', () => {
  for (const id of [20, 21, 23]) {
    const tracker = trackerFor('Запчастист');
    tracker.seed({ setting_id: id, Запчастист: false });
    assert.equal(tracker.inspect(update({ setting_id: id, Запчастист: true, API: 'key', token: 999 })), 'changed');
    assert.equal(tracker.inspect(update({ setting_id: id, Запчастист: true, API: 'key', token: 1000 })), 'ignore');
  }
});

test('an unseen row reconciles silently once and later detects a real edit', () => {
  const tracker = trackerFor('Приймальник');
  assert.equal(tracker.inspect(update({ setting_id: 10, Приймальник: true, novaposhta: 1 })), 'reconcile');
  assert.equal(tracker.inspect(update({ setting_id: 10, Приймальник: true, novaposhta: 2 })), 'ignore');
  assert.equal(tracker.inspect(update({ setting_id: 10, Приймальник: false, novaposhta: 3 })), 'changed');
});

test('unrelated roles and general-only fields do not schedule this consumer', () => {
  const tracker = trackerFor('Слюсар');
  assert.equal(tracker.inspect(update({ setting_id: 23, Запчастист: true, API: 'key' })), 'ignore');
  assert.equal(tracker.inspect(update({ setting_id: 6, data: false, Загальні: 'theme', procent: 20 })), 'ignore');
  assert.equal(tracker.inspect(update({ setting_id: 1, data: true }, { setting_id: 1, data: false })), 'changed');
});

test('reseed after reconciliation suppresses a later counter event and deletion still reconciles rights', () => {
  const tracker = trackerFor('Запчастист');
  tracker.seed({ setting_id: 20, Запчастист: true });
  tracker.seed({ setting_id: 20, Запчастист: false });
  assert.equal(tracker.inspect(update({ setting_id: 20, Запчастист: false, token: 1 })), 'ignore');
  assert.equal(tracker.inspect({ eventType: 'DELETE', old: { setting_id: 20 } }), 'reconcile');
});

function scheduler() {
  const source = fs.readFileSync('src/ts/roboha/zakaz_naraudy/inhi/settings_subscription.ts', 'utf8');
  const ast = ts.createSourceFile('s.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set(['scheduleSettingsRefresh', 'resetSettingsRefreshRecovery', 'planSettingsRefreshRecovery', 'handleSettingsChange', 'disconnectSettingsSubscription']);
  const fn = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.has(n.name?.text)).map(n => n.getText(ast)).join('\n');
  let now = 0, timerId = 0;
  const timers = new Map();
  const calls = { reads: 0, updates: 0, notices: 0 };
  const context = {
    exports: {}, Date: { now: () => now },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async refreshSettingsCache() { calls.reads++; return true; },
    async updateUIBasedOnSettings() { calls.updates++; },
    showSettingsNotification() { calls.notices++; },
    settingsRefreshQueued: false, settingsNotifyQueued: false, settingsRefreshTimer: null,
    settingsRefreshPending: null, settingsGeneration: 1, settingsChannel: { unsubscribe() {} },
    settingsRetryTimer: null, _notifDebounceTimer: null,
    settingsRecoveryNeeded: false, settingsRecoveryRetryUsed: false,
    settingsRecoveryTimer: null, settingsRecoveryNextAllowedAt: 0,
    SETTINGS_RECOVERY_RETRY_MS: 2_000, SETTINGS_RECOVERY_COOLDOWN_MS: 30_000,
    currentSettingsTracker: () => ({ inspect: () => 'ignore' }),
  };
  vm.runInNewContext(ts.transpileModule(fn, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
  return {
    context, calls, timers,
    advance(ms) { now += ms; },
    async flush() {
      const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0] || [];
      assert.ok(timer, 'expected a pending timer');
      timers.delete(id); now = Math.max(now, timer.at); timer.fn();
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('reconnect reconciliation refreshes once without claiming settings changed', async () => {
  const s = scheduler();
  for (let i = 0; i < 10; i++) s.context.scheduleSettingsRefresh(false);
  await s.flush();
  assert.deepEqual(s.calls, { reads: 1, updates: 1, notices: 0 });
});

test('a real change coalesced with silent reconciliation still notifies once', async () => {
  const s = scheduler();
  s.context.scheduleSettingsRefresh(false);
  s.context.scheduleSettingsRefresh(true);
  s.context.scheduleSettingsRefresh(false);
  await s.flush();
  assert.deepEqual(s.calls, { reads: 1, updates: 1, notices: 1 });
});

test('failed refresh never reports settings updated', async () => {
  const s = scheduler();
  s.context.refreshSettingsCache = async () => { s.calls.reads++; return false; };
  s.context.scheduleSettingsRefresh(true);
  await s.flush();
  assert.deepEqual(s.calls, { reads: 1, updates: 0, notices: 0 });
});

test('a transient refresh failure recovers automatically once without a fake settings toast', async () => {
  const s = scheduler();
  s.context.refreshSettingsCache = async () => ++s.calls.reads > 1;
  s.context.scheduleSettingsRefresh(true);
  await s.flush(); // Initial failed request.
  assert.equal(s.context.settingsRecoveryNeeded, true);
  await s.flush(); // One delayed recovery timer.
  await s.flush(); // Coalesced silent retry.
  assert.deepEqual(s.calls, { reads: 2, updates: 1, notices: 0 });
  assert.equal(s.context.settingsRecoveryNeeded, false);
  assert.equal(s.timers.size, 0);
});

test('persistent failures stop automatic retries and counter bursts recover only once per cooldown', async () => {
  const s = scheduler();
  s.context.refreshSettingsCache = async () => { s.calls.reads++; return false; };
  s.context.scheduleSettingsRefresh(true);
  await s.flush(); await s.flush(); await s.flush();
  assert.equal(s.calls.reads, 2);
  assert.equal(s.timers.size, 0);
  for (let i = 0; i < 100; i++) await s.context.handleSettingsChange({});
  assert.equal(s.timers.size, 0);
  assert.equal(s.calls.reads, 2);
  s.advance(30_000);
  for (let i = 0; i < 100; i++) await s.context.handleSettingsChange({});
  assert.equal(s.timers.size, 1);
  await s.flush();
  assert.equal(s.calls.reads, 3);
  assert.equal(s.timers.size, 0);
  s.advance(30_000);
  s.context.refreshSettingsCache = async () => { s.calls.reads++; return true; };
  await s.context.handleSettingsChange({}); await s.flush();
  assert.deepEqual(s.calls, { reads: 4, updates: 1, notices: 0 });
  assert.equal(s.context.settingsRecoveryNeeded, false);
});

test('disconnect cancels recovery and stale in-flight completion cannot apply UI or create retry', async () => {
  const s = scheduler();
  s.context.refreshSettingsCache = async () => { s.calls.reads++; return false; };
  s.context.scheduleSettingsRefresh(true); await s.flush();
  s.context.exports.disconnectSettingsSubscription();
  assert.equal(s.context.settingsRecoveryNeeded, false);
  assert.equal(s.timers.size, 0);

  const pending = scheduler();
  let finish;
  pending.context.refreshSettingsCache = () => { pending.calls.reads++; return new Promise(resolve => { finish = resolve; }); };
  pending.context.scheduleSettingsRefresh(true); await pending.flush();
  pending.context.exports.disconnectSettingsSubscription();
  finish(true); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pending.calls, { reads: 1, updates: 0, notices: 0 });
  assert.equal(pending.context.settingsRecoveryNeeded, false);
  assert.equal(pending.timers.size, 0);
});

function cacheRefresh(role, snapshotAfterLoad) {
  const source = fs.readFileSync('src/ts/roboha/zakaz_naraudy/inhi/settings_subscription.ts', 'utf8');
  const ast = ts.createSourceFile('s.ts', source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'refreshSettingsCache').getText(ast);
  const tracker = trackerFor(role);
  const calls = { roleLoads: 0, generalReads: 0 };
  let cache = { '1:data': false, '2:data': false, '3:data': false, '5:data': false };
  const context = {
    settingsGeneration: 1, settingsTracker: tracker, currentSettingsTracker: () => tracker,
    userAccessLevel: role, globalCache: { settings: { preferredLanguage: 'uk', saveMargins: true } },
    clearSettingsCache() { cache = null; },
    async loadRoleSettingsToCache() { calls.roleLoads++; cache = snapshotAfterLoad; },
    getCachedRoleSettingsSnapshot() { return cache; },
    seedRoleSettingsBaseline() {},
    supabase: { from(table) {
      assert.equal(table, 'settings');
      return { select(columns) {
        assert.equal(columns, 'setting_id, data');
        return { async in(column, ids) {
          calls.generalReads++;
          assert.equal(column, 'setting_id');
          return { data: Array.from(ids, setting_id => ({ setting_id, data: true })), error: null };
        } };
      } };
    } },
  };
  vm.runInNewContext(ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  return { context, calls };
}

test('fresh role settings response supplies global flags without a second query', async () => {
  const s = cacheRefresh('Приймальник', { '1:data': true, '2:data': false, '3:data': true, '5:data': false });
  assert.equal(await s.context.refreshSettingsCache(), true);
  assert.deepEqual(s.calls, { roleLoads: 1, generalReads: 0 });
  assert.equal(s.context.globalCache.settings.showPibMagazin, true);
  assert.equal(s.context.globalCache.settings.showCatalog, false);
});

test('administrator uses one bounded general settings read', async () => {
  const s = cacheRefresh('Адміністратор', null);
  assert.equal(await s.context.refreshSettingsCache(), true);
  assert.deepEqual(s.calls, { roleLoads: 1, generalReads: 1 });
});

test('failed role cache load is a failed refresh and cannot reuse stale flags', async () => {
  const s = cacheRefresh('Приймальник', null);
  assert.equal(await s.context.refreshSettingsCache(), false);
  assert.deepEqual(s.calls, { roleLoads: 1, generalReads: 0 });
  assert.equal(s.context.globalCache.settings.showPibMagazin, undefined);
});

test('an incomplete successful role response falls back to a bounded general read', async () => {
  const s = cacheRefresh('Приймальник', { '1:data': false });
  assert.equal(await s.context.refreshSettingsCache(), true);
  assert.deepEqual(s.calls, { roleLoads: 1, generalReads: 1 });
  assert.equal(s.context.globalCache.settings.showPibMagazin, true);
});
