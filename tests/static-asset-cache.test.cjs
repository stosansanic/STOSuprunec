const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function worker(cached, downloaded) {
  const stored = [], deleted = [], listeners = {};
  let fetches = 0;
  const context = vm.createContext({
    URL, Response, Request, console,
    self: { location: { origin: 'https://fixture.example' }, addEventListener: (name, fn) => { listeners[name] = fn; } },
    caches: { open: async () => ({
      match: async () => cached,
      delete: async request => { deleted.push(request.url); return true; },
      put: async (request, response) => { stored.push({ request, response }); },
    }) },
    fetch: async () => { fetches++; return downloaded; },
  });
  vm.runInContext(fs.readFileSync('public/sw.js', 'utf8'), context);
  return { context, stored, deleted, listeners, fetches: () => fetches };
}

test('HTML under a cached JS URL is discarded and replaced with actual JavaScript', async () => {
  const request = new Request('https://fixture.example/assets/close-hash.js');
  const html = new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
  const js = new Response('export const close = true;', { headers: { 'content-type': 'application/javascript; charset=utf-8' } });
  const w = worker(html, js);
  assert.equal(await w.context.cacheFirst(request, 'fixture'), js);
  assert.deepEqual(w.deleted, [request.url]);
  assert.equal(w.fetches(), 1);
  assert.equal(w.stored.length, 1);
});

test('HTML fallback and 404 responses are never cached as JS; valid JS still works offline', async () => {
  const request = new Request('https://fixture.example/assets/close-hash.js');
  for (const status of [200, 404]) {
    const html = new Response('<html>missing</html>', { status, headers: { 'content-type': 'text/html' } });
    const w = worker(undefined, html);
    assert.equal(await w.context.cacheFirst(request, 'fixture'), html);
    assert.equal(w.stored.length, 0);
  }
  const js = new Response('export const close = true;', { headers: { 'content-type': 'text/javascript' } });
  const w = worker(js, undefined);
  assert.equal(await w.context.cacheFirst(request, 'fixture'), js);
  assert.equal(w.fetches(), 0);
});

test('extensionless page navigation uses the network, not a stale application shell', () => {
  const w = worker();
  let routed;
  w.context.networkFirst = request => { routed = request; return Promise.resolve(new Response('fresh')); };
  const request = { url: 'https://fixture.example/main', method: 'GET', mode: 'navigate' };
  w.listeners.fetch({ request, respondWith: () => {} });
  assert.equal(routed, request);
});

test('Vercel page fallback excludes missing assets and API routes', () => {
  const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  const fallback = config.rewrites.find(rule => rule.destination === '/index.html');
  const pattern = new RegExp('^/' + fallback.source.slice('/:path('.length, -1) + '$');
  for (const path of ['/assets/close-old.js', '/assets/missing', '/api/keep-alive', '/missing.css', '/sw.js']) {
    assert.equal(pattern.test(path), false, path);
  }
  assert.equal(pattern.test('/'), true);
  assert.equal(pattern.test('/customer-route'), true);
});
