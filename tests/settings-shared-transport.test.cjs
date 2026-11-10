const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync('src/ts/roboha/nalachtuvannay/nalachtuvannay.ts', 'utf8');
const ast = ts.createSourceFile('settings.ts', source, ts.ScriptTarget.Latest, true);
const declaration = name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast);
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

test('general settings ignores technical updates without repeatedly invalidating UI caches', () => {
  const context = { exports: {}, ROLE_TO_COLUMN: { Адміністратор: 'data', Приймальник: 'Приймальник' } };
  vm.runInNewContext(compile('let settingsProjectionScope="";const settingsProjections=new Map();' + declaration('hasGeneralSettingsChange')), context);
  const inspect = (data, old = { setting_id: 10 }, scope = 'employee-a') => context.hasGeneralSettingsChange({ eventType: 'UPDATE', new: data, old }, scope);
  const initial = { setting_id: 10, data: true, Приймальник: false, procent: 0, novaposhta: { _rate: 1 } };
  assert.equal(inspect(initial), true);
  for (let i = 2; i < 102; i++) assert.equal(inspect({ ...initial, novaposhta: { _rate: i }, token: i }), false);
  assert.equal(inspect({ ...initial, data: false }), true);
  assert.equal(inspect({ ...initial, data: false }), false);
  assert.equal(inspect({ ...initial, data: false, Приймальник: true }), true);
  assert.equal(inspect({ ...initial, data: false, Приймальник: true, procent: 5 }), true);
  assert.equal(inspect(initial, { setting_id: 10 }, 'employee-b'), true);
});

test('first full-old technical payload is ignored while actual general change applies', () => {
  const context = { exports: {}, ROLE_TO_COLUMN: { Адміністратор: 'data', Приймальник: 'Приймальник' } };
  vm.runInNewContext(compile('let settingsProjectionScope="";const settingsProjections=new Map();' + declaration('hasGeneralSettingsChange')), context);
  const old = { setting_id: 10, data: true, Загальні: 'a', novaposhta: { _rate: 1 } };
  assert.equal(context.hasGeneralSettingsChange({ old, new: { ...old, novaposhta: { _rate: 2 } } }, 'a'), false);
  assert.equal(context.hasGeneralSettingsChange({ old, new: { ...old, Загальні: 'b' } }, 'a'), true);
});

test('general and act settings consumers use one channel despite login scope changes', async () => {
  const channels = [], removed = [];
  const transport = {
    channel() { const channel = { on(event, filter, listener) { if (event === 'system') this.system = listener; else { this.filter = filter; this.listener = listener; } return this; }, subscribe(status) { this.status = status; return this; } }; channels.push(channel); return channel; },
    removeChannel(channel) { removed.push(channel); },
  };
  const registryModule = { exports: {}, require: () => ({ supabase: transport }), setTimeout, clearTimeout };
  vm.runInNewContext(compile(fs.readFileSync('src/ts/utils/databaseSubscriptions.ts', 'utf8')), registryModule);
  const registry = registryModule.exports.createDatabaseSubscriptionRegistry(transport);
  const columnsModule={exports:{}};
  vm.runInNewContext(compile(fs.readFileSync('src/ts/utils/settingsUiChanges.ts','utf8')),columnsModule);
  const {SETTINGS_REALTIME_COLUMNS}=columnsModule.exports;
  let scope = '', generalEvents = 0, actEvents = 0;
  const shared = { databaseSubscriptions: registry };
  const act = {
    exports: {}, require(name) {
      if (name.endsWith('databaseSubscriptions')) return shared;
      if (name.endsWith('settingsUiChanges')) return { SETTINGS_REALTIME_COLUMNS, createSettingsUiChangeTracker: () => ({ seed() {}, inspect() { actEvents++; return 'ignore'; } }) };
      if (name.endsWith('users')) return { userAccessLevel: null, getCachedRoleSettingsSnapshot: () => null };
      return {};
    },
    localStorage: { getItem: () => scope }, setTimeout, clearTimeout,
  };
  vm.runInNewContext(compile(fs.readFileSync('src/ts/roboha/zakaz_naraudy/inhi/settings_subscription.ts', 'utf8')), act);
  act.exports.initializeSettingsSubscription();
  scope = '{"Доступ":"Адміністратор"}';
  const general = { exports: {}, ...shared, SETTINGS_REALTIME_COLUMNS, handleSettingsRealtimeChange() { generalEvents++; }, invalidateNovaPoshtaSettingCache() {} };
  vm.runInNewContext(compile('let settingsRealtimeChannel=null;const settingsProjections=new Map();' + declaration('subscribeToSettingsRealtime') + declaration('unsubscribeFromSettingsRealtime')), general);
  general.exports.subscribeToSettingsRealtime(); general.exports.subscribeToSettingsRealtime();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(channels.length, 1); assert.equal(registry.size(), 1);
  channels[0].status('SUBSCRIBED');
  channels[0].system({ extension: 'postgres_changes', status: 'ok' });
  channels[0].listener({ eventType: 'UPDATE', new: { setting_id: 10, novaposhta: { _rate: 1 } }, old: { setting_id: 10 } });
  assert.equal(actEvents, 1); assert.equal(generalEvents, 1);
  act.exports.disconnectSettingsSubscription(); assert.equal(removed.length, 0);
  general.exports.unsubscribeFromSettingsRealtime(); assert.equal(removed.length, 1); assert.equal(registry.size(), 0);
});

test('act settings reconcile after first readiness and once after reconnect, never before join', () => {
  const text=fs.readFileSync('src/ts/roboha/zakaz_naraudy/inhi/settings_subscription.ts','utf8');
  const tree=ts.createSourceFile('act-settings.ts',text,ts.ScriptTarget.Latest,true);
  const init=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='initializeSettingsSubscription').getText(tree);
  let status,refreshes=0,invalidations=0;
  const context={exports:{},settingsChannel:null,settingsErrorLogged:false,settingsRetryCount:0,MAX_SETTINGS_RETRIES:5,
    SETTINGS_REALTIME_COLUMNS:['setting_id','data'],disconnectSettingsSubscription(){},handleSettingsChange(){},
    databaseSubscriptions:{subscribe(_filter,_change,receive){status=receive;return {unsubscribe(){}};}},
    invalidateNovaPoshtaSettingCache(){invalidations++;},scheduleSettingsRefresh(notify){assert.equal(notify,false);refreshes++;},
  };
  vm.runInNewContext(compile(init),context);
  context.exports.initializeSettingsSubscription();
  assert.equal(refreshes,0);
  status('SUBSCRIBED');status('SUBSCRIBED');
  assert.equal(refreshes,1);assert.equal(invalidations,1);
  status('CLOSED');status('SUBSCRIBED');status('SUBSCRIBED');
  assert.equal(refreshes,2);
});
