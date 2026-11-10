// Prepare paste-ready Edge Functions without changing or deploying their logic.
// No secrets are read/generated. All local imports are bundled; npm stays pinned.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const folder = path.join(root, 'supabase/setup/postgrest-edge-update');
const sdk = 'npm:@supabase/supabase-js@2.98.0'; // Already used by nova-poshta.
const dependencies = {
  '../_shared/nova-poshta-domain.ts': 'supabase/functions/_shared/nova-poshta-domain.ts',
  '../_shared/operationalLog.ts': 'supabase/functions/_shared/operationalLog.ts',
  '../_shared/reminderDelivery.ts': 'supabase/functions/_shared/reminderDelivery.ts',
  './resultDigest.ts': 'supabase/functions/check-reminders/resultDigest.ts',
};
function bundle(name) {
  const sourcePath = `supabase/functions/${name}/index.ts`;
  const sources = [sourcePath];
  let source = read(sourcePath).replace(/^import\s+(.+?)\s+from\s+"([^"\n]+)";\s*$/gm, (whole, bindings, specifier) => {
    if (specifier === '@supabase/supabase-js' || specifier === sdk) return `import ${bindings} from "${sdk}";`;
    const dependency = dependencies[specifier];
    if (!dependency) throw new Error(`Unknown dependency: ${specifier}`);
    const content = read(dependency);
    if (/^import\s/m.test(content)) throw new Error(`Nested import in ${dependency}: update bundler`);
    sources.push(dependency);
    return `// BEGIN INLINED: ${dependency}\n${content}\n// END INLINED: ${dependency}\n`;
  });
  source = `// Generated from maintained source. Paste the ENTIRE file into ${name}/index.ts.\n// All local dependencies included; no keys or passwords embedded.\n${source}`;
  const syntax = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (syntax.parseDiagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(syntax.parseDiagnostics, {
    getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  const imports = syntax.statements.filter(ts.isImportDeclaration).map(statement => statement.moduleSpecifier.text);
  if (imports.length !== 1 || imports[0] !== sdk) throw new Error(`${name}: unresolved imports`);
  if ((source.match(/Deno\.serve\(/g) || []).length !== 1) throw new Error(`${name}: expected one handler`);
  return { source, sources };
}
const manifest = {};
fs.mkdirSync(folder, { recursive: true });
const sqlSource = 'supabase/setup/traffic-optimization/9.1 Оптимізація PostgREST.sql';
const atlasSqlSource = 'supabase/migrations/20261023114017_atlas_background_efficiency.sql';
// The current check-reminders source requires this additive migration too.
const sql = Buffer.concat([fs.readFileSync(path.join(root, sqlSource)), Buffer.from('\n'), fs.readFileSync(path.join(root, atlasSqlSource))]);
fs.writeFileSync(path.join(folder, '01-database-9.1.sql'), sql);
manifest.database = { file: '01-database-9.1.sql', sources: [sqlSource, atlasSqlSource], sha256: crypto.createHash('sha256').update(sql).digest('hex') };
for (const [name, filename] of [['nova-poshta', '02-nova-poshta-index.ts'], ['check-reminders', '03-check-reminders-index.ts']]) {
  const { source, sources } = bundle(name);
  fs.writeFileSync(path.join(folder, filename), source);
  manifest[name] = { file: filename, sources, sha256: crypto.createHash('sha256').update(source).digest('hex'), sdk };
}
fs.writeFileSync(path.join(folder, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared SQL and two standalone TypeScript files in ${folder}. TypeScript syntax checked; no functions invoked or deployed.`);
