const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../src/ts/roboha/zakaz_naraudy/inhi/ctvorennia_papku_googleDrive..ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture({ sdkReady = true } = {}) {
  const state = {
    now: 1_800_000_000_000,
    actId: '1514',
    scripts: [], requests: [], notices: [], dbReads: [], dbWrites: [], fetches: [], opens: [],
    timers: new Map(), nextTimer: 1,
    dbResult: { data: null, error: { message: 'Stop fixture after authorization' } },
    fetchResult: { ok: true, status: 200, json: async () => ({ files: [] }) },
  };
  const attributes = new Map();
  const listeners = new Map();
  const photoCell = {
    style: {}, innerHTML: '', isConnected: true,
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
  };
  const sdk = {
    accounts: { oauth2: {
      initTokenClient: (options) => ({
        requestAccessToken: (request) => state.requests.push({ options, request }),
      }),
      revoke: () => undefined,
    } },
  };
  const supabase = {
    from(table) {
      const query = { table };
      const builder = {
        select(columns) { query.columns = columns; return builder; },
        eq(column, value) { query.filter = { column, value }; return builder; },
        single() { state.dbReads.push(query); return Promise.resolve(state.dbResult); },
        update(values) { state.dbWrites.push({ table, values }); return builder; },
      };
      return builder;
    },
  };
  class Clock extends Date { static now() { return state.now; } }
  const context = {
    exports: {}, console, Error, Date: Clock,
    setTimeout(callback) {
      const id = state.nextTimer++;
      state.timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { state.timers.delete(id); },
    document: {
      querySelector: () => photoCell,
      getElementById: (id) => id === 'zakaz_narayd-custom-modal'
        ? { getAttribute: (name) => name === 'data-act-id' ? state.actId : null }
        : null,
      createElement(tag) {
        assert.equal(tag, 'script');
        return { remove() { this.removed = true; } };
      },
      head: { appendChild(script) { state.scripts.push(script); } },
    },
    window: { open(url, target) {
      state.opens.push({ url, target });
      return state.popupBlocked ? null : { opener: {}, focus() {} };
    } },
    fetch: async (url, options) => {
      state.fetches.push({ url, options });
      return state.fetchResult;
    },
    require(id) {
      if (id.endsWith('/supabaseClient')) return { supabase };
      if (id.endsWith('/vspluvauhe_povidomlenna')) return {
        showNotification: (message, type) => state.notices.push({ message, type }),
      };
      if (id.endsWith('/auditLogger')) return { logAction: async () => undefined };
      if (id.endsWith('/project.config')) return { GOOGLE_CONFIG: {
        clientId: 'fixture-client', driveScopes: 'https://www.googleapis.com/auth/drive.file', isConfigured: true,
      } };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  };
  if (sdkReady) context.google = sdk;
  vm.runInNewContext(compiled, context, { filename: sourcePath });
  const click = () => listeners.get('click')({ preventDefault() {}, currentTarget: photoCell });
  const authorize = (index = state.requests.length - 1) => state.requests[index].options.callback({
    access_token: 'fixture-access-token', expires_in: 3600,
  });
  const fail = (type, index = state.requests.length - 1) => state.requests[index].options.error_callback({ type });
  return { api: context.exports, state, photoCell, click, authorize, fail, ready() { context.google = sdk; } };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('importing act helpers does not load Google SDK or issue requests', () => {
  const { state } = fixture({ sdkReady: false });
  assert.equal(state.scripts.length, 0);
  assert.equal(state.requests.length, 0);
  assert.equal(state.dbReads.length, 0);
  assert.equal(state.fetches.length, 0);
});

test('GIS prewarm is shared and completion waits for a fresh click before opening authorization', async () => {
  const f = fixture({ sdkReady: false });
  f.api.updatePhotoSection(null);
  f.api.updatePhotoSection(null);
  assert.equal(f.state.scripts.length, 1);
  assert.equal(f.state.scripts[0].src, 'https://accounts.google.com/gsi/client');
  await f.click();
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.dbReads.length, 0);
  assert.match(f.state.notices.at(-1).message, /ще завантажується/);

  f.ready();
  f.state.scripts[0].onload();
  await flush();
  assert.equal(f.state.requests.length, 0, 'SDK completion must not open a background popup');
  assert.equal(f.state.scripts.length, 1, 'GAPI must not be loaded');
  assert.equal(f.state.timers.size, 0);

  const pending = f.click();
  assert.equal(f.state.requests.length, 1, 'requestAccessToken must run before click returns');
  f.fail('popup_closed');
  await pending;
});

test('failed GIS load is removed and the next interaction can retry', async () => {
  const f = fixture({ sdkReady: false });
  f.api.updatePhotoSection(null);
  f.state.scripts[0].onerror();
  await flush();
  assert.equal(f.state.scripts[0].removed, true);
  assert.equal(f.state.timers.size, 0);
  f.api.updatePhotoSection(null);
  assert.equal(f.state.scripts.length, 2);
  f.ready();
  f.state.scripts[1].onload();
  await flush();
  const pending = f.click();
  assert.equal(f.state.requests.length, 1);
  f.fail('popup_closed');
  await pending;
});

test('explicit authorization starts synchronously and coalesces concurrent calls without Drive probes', async () => {
  const f = fixture();
  const first = f.api.initGoogleApi();
  assert.equal(f.state.requests.length, 1);
  const second = f.api.initGoogleApi();
  assert.equal(f.state.requests.length, 1);
  f.authorize();
  await Promise.all([first, second]);
  assert.equal(f.api.checkAuthStatus(), true);
  assert.equal(f.state.fetches.length, 0);
  assert.equal(f.state.dbReads.length, 0);
  assert.equal(f.state.scripts.length, 0);
});

test('blocked popup gives actionable guidance, writes nothing and releases the click lock', async () => {
  const f = fixture();
  f.api.updatePhotoSection(null);
  const first = f.click();
  assert.equal(f.state.requests.length, 1);
  assert.equal(f.state.dbReads.length, 0);
  await f.click();
  assert.equal(f.state.requests.length, 1, 'repeated clicks must share the in-progress operation');
  f.fail('popup_failed_to_open');
  await first;
  assert.match(f.state.notices.at(-1).message, /Браузер заблокував/);
  assert.match(f.state.notices.at(-1).message, /Дозвольте спливні вікна/);
  assert.equal(f.photoCell.style.pointerEvents, '');
  assert.equal(f.api.checkAuthStatus(), false);
  assert.equal(f.state.dbReads.length, 0);
  assert.equal(f.state.dbWrites.length, 0);
  assert.equal(f.state.fetches.length, 0);
  const retry = f.click();
  assert.equal(f.state.requests.length, 2);
  f.fail('popup_closed');
  await retry;
});

test('closing the OAuth window is reported distinctly and does not access the database', async () => {
  const f = fixture();
  f.api.updatePhotoSection(null);
  const pending = f.click();
  f.fail('popup_closed');
  await pending;
  assert.match(f.state.notices.at(-1).message, /Вікно входу Google закрито/);
  assert.equal(f.state.dbReads.length, 0);
  assert.equal(f.state.fetches.length, 0);
  assert.equal(f.photoCell.style.pointerEvents, '');
});

test('closed act without photos cannot start authorization or preload SDK', async () => {
  const f = fixture({ sdkReady: false });
  f.api.updatePhotoSection(null, true);
  await f.click();
  assert.equal(f.state.scripts.length, 0);
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.dbReads.length, 0);
  assert.match(f.state.notices.at(-1).message, /Акт закритий/);
});

test('existing photo link opens directly even for a closed act without Google or database requests', async () => {
  const f = fixture({ sdkReady: false });
  const url = 'https://drive.google.com/drive/folders/fixture-folder';
  f.api.updatePhotoSection(url, true);
  const pending = f.click();
  assert.deepEqual(f.state.opens, [{ url, target: '_blank' }]);
  await pending;
  assert.equal(f.state.scripts.length, 0);
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.dbReads.length, 0);
  assert.equal(f.state.fetches.length, 0);
});

test('successful authorization reads current act once with no redundant Drive connection request', async () => {
  const f = fixture();
  f.api.updatePhotoSection(null);
  const pending = f.click();
  f.authorize();
  await pending;
  assert.equal(f.state.dbReads.length, 1);
  assert.equal(f.state.dbReads[0].table, 'acts');
  assert.equal(f.state.dbReads[0].columns, 'photo_url, date_off');
  assert.equal(f.state.dbReads[0].filter.value, 1514);
  assert.equal(f.state.fetches.length, 0);
  assert.equal(f.photoCell.style.pointerEvents, '');
});

test('cached authorization still locks repeated clicks while current act is being read', async () => {
  const f = fixture();
  const authorization = f.api.initGoogleApi();
  f.authorize();
  await authorization;
  let resolveRead;
  f.state.dbResult = new Promise((resolve) => { resolveRead = resolve; });
  f.api.updatePhotoSection(null);
  const first = f.click();
  const second = f.click();
  const readCount = f.state.dbReads.length;
  assert.equal(f.state.requests.length, 1);
  resolveRead({ data: null, error: { message: 'fixture stop' } });
  await Promise.all([first, second]);
  assert.equal(readCount, 1);
  assert.equal(f.photoCell.style.pointerEvents, '');
});

test('a photo link discovered after a database read is rendered for a fresh click', async () => {
  const f = fixture();
  const url = 'https://drive.google.com/drive/folders/existing-folder';
  f.state.dbResult = { data: { photo_url: url, date_off: null }, error: null };
  f.api.updatePhotoSection(null);
  const pending = f.click();
  f.authorize();
  await pending;
  assert.equal(f.state.opens.length, 0, 'async database completion must not open a browser window');
  assert.equal(f.photoCell.getAttribute('data-link-url'), url);
  assert.equal(f.state.dbWrites.length, 0);
  assert.equal(f.state.fetches.length, 0);
  const open = f.click();
  assert.equal(f.state.opens.length, 1);
  await open;
  assert.equal(f.state.dbReads.length, 1);
});

test('expired access token starts reauthorization directly on the next photo click', async () => {
  const f = fixture();
  const authorization = f.api.initGoogleApi();
  f.authorize();
  await authorization;
  f.state.now += 3_600_000;
  f.api.updatePhotoSection(null);
  const pending = f.click();
  assert.equal(f.state.requests.length, 2);
  assert.equal(f.state.dbReads.length, 0);
  f.fail('popup_closed');
  await pending;
  assert.equal(f.api.checkAuthStatus(), false);
});

test('Drive 401 clears authorization and waits for the next explicit click', async () => {
  const f = fixture();
  const authorization = f.api.initGoogleApi();
  f.authorize();
  await authorization;
  f.state.fetchResult = { ok: false, status: 401, statusText: 'Unauthorized' };
  await assert.rejects(f.api.testDriveConnection(), /Доступ до Google Drive завершився/);
  assert.equal(f.api.checkAuthStatus(), false);
  assert.equal(f.state.requests.length, 1, 'a failed API call must not open a popup');
  assert.equal(f.state.fetches.length, 1);
  f.api.updatePhotoSection(null);
  const pending = f.click();
  assert.equal(f.state.requests.length, 2);
  f.fail('popup_closed');
  await pending;
});

test('late OAuth result cannot restore authorization after explicit sign out', async () => {
  const f = fixture();
  const pending = f.api.initGoogleApi();
  const rejected = assert.rejects(pending, /Вхід у Google скасовано/);
  await f.api.signOut();
  f.authorize();
  await rejected;
  assert.equal(f.api.checkAuthStatus(), false);
});

test('late success after a blocked popup is ignored', async () => {
  const f = fixture();
  const pending = f.api.initGoogleApi();
  const rejected = assert.rejects(pending, /Браузер заблокував/);
  f.fail('popup_failed_to_open');
  await rejected;
  f.authorize();
  await flush();
  assert.equal(f.api.checkAuthStatus(), false);
  assert.equal(f.state.fetches.length, 0);
});

test('changing acts during authorization does not read or write the previous act', async () => {
  const f = fixture();
  f.api.updatePhotoSection(null);
  const pending = f.click();
  f.state.actId = '1515';
  f.authorize();
  await pending;
  assert.equal(f.state.dbReads.length, 0);
  assert.equal(f.state.dbWrites.length, 0);
  assert.equal(f.state.fetches.length, 0);
  assert.equal(f.photoCell.style.pointerEvents, '');
});
