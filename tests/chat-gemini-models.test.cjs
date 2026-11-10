const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/ts/roboha/ai/chatGeminiModels.ts'), 'utf8');
function setup(fetch) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, fetch, URL, Headers, AbortController, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} } });
  return exports;
}
const model = id => ({ name: 'models/' + id, supportedGenerationMethods: ['generateContent'], outputTokenLimit: 8000, thinking: true });
const json = body => new Response(JSON.stringify(body));
const body = { contents: [{ role: 'user', parts: [{ text: 'test' }] }], generationConfig: { temperature: 0.2, topP: 0.9, topK: 10, candidateCount: 1, maxOutputTokens: 16000, thinkingConfig: { thinkingBudget: 0 } } };
const request = { method: 'POST', body: JSON.stringify(body) };

test('paginates discovery, selects newest stable Flash, adapts config and keeps keys out of URL', async () => {
  const calls = [];
  const api = setup(async (url, init) => {
    calls.push([String(url), init]);
    if (!init.method) return String(url).includes('pageToken=next')
      ? json({ models: [model('gemini-3.8-flash'), model('gemini-99-flash-preview')] })
      : json({ models: [model('gemini-2.5-flash'), model('gemini-3.9-flash-lite')], nextPageToken: 'next' });
    return json({ candidates: [] });
  });
  const send = await api.createChatGeminiRequest('test-key');
  await send(request);
  assert.match(calls[2][0], /gemini-3.8-flash:generateContent$/);
  assert.ok(calls.every(([url]) => !url.includes('test-key')));
  const config = JSON.parse(calls[2][1].body).generationConfig;
  assert.deepEqual(config, { maxOutputTokens: 8000, thinkingConfig: { thinkingLevel: 'LOW' } });
  assert.equal(calls[2][1].headers.get('x-goog-api-key'), 'test-key');
  assert.equal(body.generationConfig.temperature, 0.2);
});

test('auto retries 404 on next model and remembers unavailable models per key', async () => {
  const posts = [];
  const api = setup(async (url, init) => {
    if (!init.method) return json({ models: [model('gemini-3.8-flash'), model('gemini-3.7-flash')] });
    posts.push(String(url));
    return String(url).includes('3.8') ? new Response('', { status: 404 }) : json({});
  });
  await (await api.createChatGeminiRequest('a'))(request);
  await (await api.createChatGeminiRequest('a'))(request);
  assert.equal(posts.length, 3);
  assert.match(posts[2], /3.7/);
  assert.equal((await api.listChatGeminiModels('b')).length, 2);
});

test('manual model never falls back; quota and authorization errors are returned without replay', async () => {
  for (const status of [404, 401, 403, 429, 503]) {
    let count = 0;
    const api = setup(async (_url, init) => {
      if (!init.method) return json({ models: [model('gemini-3.8-flash'), model('gemini-3.7-flash')] });
      count++; return new Response('', { status });
    });
    if (status === 404) api.setChatGeminiSelection('gemini-3.7-flash');
    assert.equal((await (await api.createChatGeminiRequest('a'))(request)).status, status);
    assert.equal(count, 1);
  }
});

test('successful tool conversation pins model even if the next request returns 404', async () => {
  let count = 0;
  const api = setup(async (_url, init) => {
    if (!init.method) return json({ models: [model('gemini-3.8-flash'), model('gemini-3.7-flash')] });
    return ++count === 1 ? json({}) : new Response('', { status: 404 });
  });
  const send = await api.createChatGeminiRequest('a');
  await send(request);
  assert.equal((await send(request)).status, 404);
  assert.equal(count, 2);
});

test('cancellation and uncertain network failures never generate a retry', async () => {
  let count = 0;
  const api = setup(async (_url, init) => {
    if (!init.method) return json({ models: [model('gemini-3.8-flash'), model('gemini-3.7-flash')] });
    count++; throw new Error('network unavailable');
  });
  const send = await api.createChatGeminiRequest('a');
  await assert.rejects(send(request), /network unavailable/);
  assert.equal(count, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.createChatGeminiRequest('a', controller.signal), { name: 'AbortError' });
});
