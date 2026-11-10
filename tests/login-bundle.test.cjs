// Run after npm run build. Verify the production entry graph, not just TS types.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function staticGraph(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = ts.createSourceFile(entry, fs.readFileSync(entry, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const node of source.statements) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier.text;
      if (specifier.startsWith('.')) staticGraph(path.resolve(path.dirname(entry), specifier), seen);
    }
  }
  return seen;
}

test('production date picker stays lazy until Moment globals are assigned', () => {
  const assets = path.resolve('dist/assets');
  const pickerFiles = fs.readdirSync(assets).filter(name => /^daterangepicker-.*\.js$/.test(name));
  assert.equal(pickerFiles.length, 1, 'Do not merge the UMD date picker with eagerly imported Moment/jQuery');
  const html = fs.readFileSync('dist/main.html', 'utf8');
  const script = html.match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/)[1];
  const graph = staticGraph(path.resolve('dist', script.replace(/^.*?assets\//, 'assets/')));
  assert.ok(!graph.has(path.join(assets, pickerFiles[0])), 'Date picker must execute only after window.moment is ready');
  assert.ok([...graph].some(file => fs.readFileSync(file, 'utf8').includes(pickerFiles[0])), 'Main must still reference the lazy date picker');
});

test('production login does not execute protected application chunks', () => {
  const html = fs.readFileSync('dist/index.html', 'utf8');
  const script = html.match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/)[1];
  const graph = staticGraph(path.resolve('dist', script.replace(/^.*?assets\//, 'assets/')));
  const prohibited = [...graph].filter(file => !/^(index|react|vendor|supabase|supabaseClient)-/.test(path.basename(file)));
  assert.deepEqual(prohibited.map(file => path.basename(file)), [], 'Login must not run application modules or their automatic redirects');
  for (const file of graph) {
    const code = fs.readFileSync(file, 'utf8');
    assert.ok(!code.includes('auth-verified'), `Protected-page guard leaked into ${path.basename(file)}`);
  }
});

test('production main page does not execute accounting or planning access guards', () => {
  const html = fs.readFileSync('dist/main.html', 'utf8');
  const script = html.match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/)[1];
  const graph = staticGraph(path.resolve('dist', script.replace(/^.*?assets\//, 'assets/')));
  for (const file of graph) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes('auth-verified'),
      `Another page's automatic access guard leaked into main: ${path.basename(file)}`);
  }
});
