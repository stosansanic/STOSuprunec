const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(options = {}) {
  class Element {
    constructor(tag = 'div') {
      this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {};
      this.className = ''; this.ownText = ''; this.open = true; this.isConnected = true;
      this.disabled = false; this.value = ''; this.listeners = {};
      this.classList = {
        add: (...classes) => { this.className = [...new Set([...this.className.split(' '), ...classes])].join(' ').trim(); },
        remove: (...classes) => { this.className = this.className.split(' ').filter(c => !classes.includes(c)).join(' '); },
      };
    }
    set textContent(value) { this.ownText = value; this.children = []; }
    get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...children) { this.children.push(...children); }
    add(child) { this.append(child); }
    replaceChildren(...children) { this.ownText = ''; this.children = children; }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    close() { this.open = false; for (const listener of this.listeners.close || []) listener(); }
    focus() {}
    setCustomValidity() {}
    reportValidity() {}
    querySelectorAll(selector) {
      const matches = element => selector.startsWith('.')
        ? element.className.split(' ').includes(selector.slice(1))
        : selector === 'button:not(:disabled)' ? element.tag === 'button' && !element.disabled : element.tag === selector;
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  class NpError extends Error { constructor(message, code) { super(message); this.code = code; } }
  const hosts = [], dialogs = [], calls = []; let serviceChecks = 0;
  let saved = { items: [{ ttn: '20400000000001', note: 'Saved TTN' }], editable: true };
  const api = {}, service = {
    NpError, stateLabels: {}, normalizeTTN: value => value,
    ensureServiceAvailable: async () => { serviceChecks++; },
    request: async (action, body = {}) => {
      calls.push({ action, ...body });
      if (options.request) return options.request(action, body, { saved, NpError });
      if (action === 'act_list') return saved;
      return {};
    },
  };
  const workflowDialog = title => {
    const dialog = new Element('dialog'), content = new Element(), message = new Element('p');
    dialog.append(message, content);
    const ui = { dialog, content, message, title, setBusy() {}, setDirty() {} };
    dialogs.push(ui); return ui;
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/novaPoshta/ui.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports: api,
    require: name => name === './api' ? service : name.endsWith('/dialog') ? { workflowDialog }
      : name === './linkSuggestions' ? { linkSuggestions: (_, act) => ({ actId: () => Number(act.value), close() {} }) }
      : {},
    document: {
      createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
      querySelectorAll: selector => selector === '.np-act-section' ? hosts : [],
    },
    localStorage: { getItem: () => JSON.stringify({ Name: 'Employee' }) },
    Option: function (text, value) { const option = new Element('option'); option.textContent = text; option.value = value; return option; },
  });
  return {
    api, hosts, dialogs, calls, NpError, Element,
    mount(id = 1514) { const host = new Element(); hosts.push(host); api.mountActShipments(host, id); return host; },
    setSaved(value) { saved = value; },
    serviceChecks: () => serviceChecks,
  };
}
const settled = () => new Promise(resolve => setImmediate(resolve));
const click = (host, label) => {
  const button = host.querySelectorAll('button').find(b => b.textContent === label);
  assert.ok(button, `Button ${label} exists`); button.onclick();
};

test('opening or rerendering acts only mounts the TTN control without any NP request', async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) {
    const host = f.mount(1500 + i);
    assert.equal(host.querySelectorAll('button').length, 1);
    assert.equal(host.querySelector('button').attributes['aria-haspopup'], 'dialog');
    assert.equal(host.querySelector('.np-act-rows').children.length, 0);
  }
  await settled();
  assert.deepEqual(f.calls, []); assert.equal(f.serviceChecks(), 0);
});

test('an explicit TTN click loads one fresh list and reuses it for only that act summary', async () => {
  const f = fixture(), host = f.mount(), another = f.mount(1515);
  click(host, 'ТТН акта'); await settled();
  assert.deepEqual(f.calls, [{ action: 'act_list', act_id: 1514 }]);
  assert.equal(f.serviceChecks(), 1);
  assert.match(host.querySelector('.np-act-rows').textContent, /20400000000001/);
  assert.equal(another.querySelector('.np-act-rows').children.length, 0);
  click(host, 'ТТН акта'); await settled();
  assert.equal(f.calls.length, 1, 'A repeated click focuses the existing dialog');
  f.dialogs[0].dialog.close();
  f.setSaved({ items: [], editable: false });
  click(host, 'ТТН акта'); await settled();
  assert.equal(f.calls.length, 2, 'Reopening reads fresh authoritative data, not a private TTL cache');
  assert.equal(host.querySelector('.np-act-rows').children.length, 0);
  assert.match(f.dialogs[1].content.textContent, /ще не записано/);
  assert.doesNotMatch(f.dialogs[1].content.textContent, /Додати ТТН/);
});

test('employee authentication still precedes displaying the authoritative act TTNs', async () => {
  let authenticated = false;
  const f = fixture({ request: async (action, _, { saved, NpError }) => {
    if (action === 'authenticate') { authenticated = true; return {}; }
    if (!authenticated) throw new NpError('Sign in', 'EMPLOYEE_LOGIN');
    return saved;
  } });
  const host = f.mount(); click(host, 'ТТН акта'); await settled();
  const ui = f.dialogs[0];
  assert.match(ui.content.textContent, /Пароль працівника/);
  assert.equal(host.querySelector('.np-act-rows').children.length, 0);
  const form = ui.content.querySelector('form');
  form.querySelectorAll('input').find(input => input.type === 'password').value = 'fixture-only';
  form.onsubmit({ preventDefault() {} }); await settled();
  assert.deepEqual(f.calls.map(call => call.action), ['act_list', 'authenticate', 'act_list']);
  assert.match(host.querySelector('.np-act-rows').textContent, /20400000000001/);
});

test('late responses never update a closed TTN dialog or detached act', async () => {
  let resolve;
  const f = fixture({ request: () => new Promise(done => { resolve = done; }) });
  const host = f.mount(); click(host, 'ТТН акта'); await settled();
  f.dialogs[0].dialog.close(); host.isConnected = false;
  resolve({ items: [{ ttn: '20400000000001' }], editable: true }); await settled();
  assert.equal(host.querySelector('.np-act-rows').children.length, 0);
});

test('refreshing and unlinking still update the selected act from the server', async () => {
  const f = fixture(), host = f.mount();
  click(host, 'ТТН акта'); await settled();
  const ui = f.dialogs[0];
  f.setSaved({ items: [{ ttn: '20400000000002' }], editable: true });
  click(ui.content, 'Оновити'); await settled();
  assert.match(host.querySelector('.np-act-rows').textContent, /20400000000002/);
  click(ui.content, 'Прибрати з акта');
  f.setSaved({ items: [], editable: true });
  click(f.dialogs[1].content, 'Прибрати'); await settled();
  assert.ok(f.calls.some(call => call.action === 'act_link' && call.act_id === 1514 && call.ttn === '20400000000002' && call.remove));
  assert.equal(f.calls.filter(call => call.action === 'act_list').length, 3, 'Initial load, explicit refresh and one reload after unlink');
  assert.equal(host.querySelector('.np-act-rows').children.length, 0);
  assert.match(ui.content.textContent, /ще не записано/);
});

test('adding a TTN refreshes the parent list once without requesting other act summaries', async () => {
  const f = fixture(), host = f.mount(), unopened = f.mount(1515);
  click(host, 'ТТН акта'); await settled();
  const parent = f.dialogs[0];
  click(parent.content, '＋ Додати ТТН');
  const link = f.dialogs[1], form = link.content.querySelector('form');
  form.querySelectorAll('input').find(input => input.attributes['aria-label'] === 'ТТН').value = '20400000000003';
  f.setSaved({ items: [{ ttn: '20400000000003' }], editable: true });
  form.onsubmit({ preventDefault() {} }); await settled();
  assert.deepEqual(f.calls.map(call => call.action), ['act_list', 'act_link', 'act_list']);
  assert.ok(f.calls.every(call => call.act_id === 1514));
  assert.match(host.querySelector('.np-act-rows').textContent, /20400000000003/);
  assert.equal(unopened.querySelector('.np-act-rows').children.length, 0);
  assert.match(parent.content.textContent, /20400000000003/);
});
