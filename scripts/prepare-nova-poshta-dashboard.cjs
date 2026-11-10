// Build paste-ready Dashboard files from the maintained SQL and Edge Function sources.
// Generated secrets stay under an ignored *.local directory and are reused on reruns.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const withoutTransaction = sql => sql.replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '');

// Split PostgreSQL statements without cutting strings, comments, or dollar-quoted bodies.
function splitSql(sql) {
  const statements = [];
  let start = 0, quote = '', lineComment = false, blockDepth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i], next = sql[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockDepth) {
      if (ch === '/' && next === '*') { blockDepth++; i++; }
      else if (ch === '*' && next === '/') { blockDepth--; i++; }
      continue;
    }
    if (quote.startsWith('$')) {
      if (sql.startsWith(quote, i)) { i += quote.length - 1; quote = ''; }
      continue;
    }
    if (quote === "'") {
      if (ch === "'" && next === "'") i++;
      else if (ch === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (ch === '"' && next === '"') i++;
      else if (ch === '"') quote = '';
      continue;
    }
    if (ch === '-' && next === '-') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockDepth = 1; i++; continue; }
    if (ch === "'") { quote = "'"; continue; }
    if (ch === '"') { quote = '"'; continue; }
    if (ch === '$') {
      const match = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(i));
      if (match) { quote = match[0]; i += quote.length - 1; continue; }
    }
    if (ch === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement && statement.replace(/^(?:\s*--[^\n]*(?:\n|$))+/gm, '').trim()) statements.push(statement);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail && tail.replace(/^(?:\s*--[^\n]*(?:\n|$))+/gm, '').trim()) statements.push(tail);
  return statements;
}

function dollarQuote(value, prefix, source) {
  let tag = prefix, counter = 0;
  while (source.includes(tag)) tag = `${prefix}_${++counter}`;
  return `${tag}${value}${tag}`;
}

function buildDatabaseSQL() {
  const archive = read('supabase/migrations/20261003000000_nova_poshta_archive.sql');
  const schema = archive.slice(0, archive.indexOf('-- Preserve useful older values'));
  return 'begin;\n' + withoutTransaction(read('supabase/setup/nova-poshta.sql'))
    + '\n' + withoutTransaction(schema) + '\n' + withoutTransaction(buildUpdateSQL()) + '\ncommit;\n';
}

function buildUpdateSQL() {
  const source = read('supabase/migrations/20261003000000_nova_poshta_archive.sql');
  const start = source.indexOf('-- Preserve useful older values');
  if (start < 0) throw new Error('Archive function marker missing');
  // Install each current function once. Earlier archive definitions are superseded.
  const superseded = /function public\.(?:np_archive_save|np_online_act|np_archive_act_read|np_archive_list)\(/;
  const helpers = splitSql(withoutTransaction(source.slice(start))).filter(statement => !superseded.test(statement));
  const latest = withoutTransaction(read('supabase/migrations/20261003010000_nova_poshta_act_numbers.sql'));
  const linkOptions = withoutTransaction(read('supabase/migrations/20261003020000_nova_poshta_link_options.sql'));
  const infiniteScroll = withoutTransaction(read('supabase/migrations/20261011123102_nova_poshta_infinite_scroll.sql'));
  const realtime = read('supabase/migrations/20261023063556_realtime_traffic_optimization.sql');
  const rateStart = realtime.indexOf('-- BEGIN REALTIME NP RATE');
  const rateEnd = realtime.indexOf('-- END REALTIME NP RATE');
  if (rateStart < 0 || rateEnd < rateStart) throw new Error('Realtime NP rate definitions missing');
  const realtimeRate = realtime.slice(rateStart, rateEnd + '-- END REALTIME NP RATE'.length);
  // Standalone NP installs need the compact authorization RPC and its JSON
  // decoder. Reuse the canonical definitions without installing accounting RPCs.
  const employeeProjection = splitSql(read('supabase/migrations/20261005130000_traffic_reports.sql'))
    .filter(statement => /(?:function public\.traffic_(?:json_object|np_employee)\(|on function public\.traffic_np_employee\()/i.test(statement));
  if (employeeProjection.length !== 4) throw new Error('NP employee projection definitions changed; update the Dashboard builder.');
  const accessHelper = splitSql(read('supabase/migrations/20261011040000_traffic_act_search.sql'))
    .find(statement => /create or replace function public\.traffic_search_truthy\(/i.test(statement));
  if (!accessHelper) throw new Error('traffic_search_truthy definition missing; update the Dashboard builder.');
  // Latest Edge code calls this service-only RPC to combine whitelist, rate,
  // employee and configuration lookups. Keep its dependencies in new-project SQL.
  const compactContext = splitSql(read('supabase/migrations/20261023082800_compact_settings_sms_np_context.sql'))
    .filter(statement => /traffic_np_request_context/i.test(statement));
  if (compactContext.length !== 3) throw new Error('Expected NP context RPC, revoke and grant statements.');
  const sql = '-- NP UPDATE v2: SQL Editor only. Existing tables; paste the entire file.\n'
    + 'begin;\n' + helpers.join(';\n\n') + ';\n\n' + latest + '\n' + linkOptions
    + '\n' + employeeProjection.join(';\n\n') + ';\n' + accessHelper + ';\n'
    + infiniteScroll + '\n' + realtimeRate + '\n' + compactContext.join(';\n\n') + ';\n'
    + "notify pgrst,'reload schema';\ncommit;\n";
  return sql.replace(/\$\$/g, () => '$np_body$');
}

function buildFunction() {
  const source = read('supabase/functions/nova-poshta/index.ts');
  const sharedImport = /^import .* from "\.\.\/_shared\/nova-poshta-domain\.ts";\n/m;
  if (!sharedImport.test(source)) throw new Error('Shared import changed; update the Dashboard builder.');
  return '// Generated from the maintained Edge Function and shared domain. Paste all into index.ts.\n'
    + source.replace(sharedImport, () => read('supabase/functions/_shared/nova-poshta-domain.ts') + '\n');
}

function readProjectUrlFromFiles() {
  for (const file of ['.env.local', '.env']) {
    const filePath = path.join(root, file);
    if (!fs.existsSync(filePath)) continue;
    const match = /^\s*VITE_SUPABASE_URL\s*=\s*["']?([^\r\n"']+)/m.exec(fs.readFileSync(filePath, 'utf8'));
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function readProjectUrl() {
  return process.env.VITE_SUPABASE_URL?.trim() || readProjectUrlFromFiles();
}

function projectRefFrom(input) {
  const value = input || readProjectUrl();
  let ref = value;
  if (value.includes('://')) {
    const hostname = new URL(value).hostname;
    ref = /^([a-z0-9]{20})\.supabase\.co$/.exec(hostname)?.[1] || '';
  }
  if (!/^[a-z0-9]{20}$/.test(ref)) throw new Error('Set VITE_SUPABASE_URL in .env for this project, or pass its 20-character project Ref.');
  return ref;
}

function prepare(input) {
  const projectRef = projectRefFrom(input);
  const folderName = projectRef;
  const directory = path.join(root, 'supabase/dashboard-nova-poshta.local', folderName);
  fs.mkdirSync(directory, { recursive: true });
  const secretPath = path.join(directory, '02-secrets.env');
  if (!fs.existsSync(secretPath)) {
    fs.writeFileSync(secretPath, `NP_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  }
  const secrets = fs.readFileSync(secretPath, 'utf8');
  let encryptionKey = /^NP_ENCRYPTION_KEY=([a-f0-9]{64})$/m.exec(secrets)?.[1];
  if (!encryptionKey) throw new Error('Existing encryption key file is invalid. Preserved it; repair it manually without replacing a key already in use.');
  fs.writeFileSync(secretPath, `NP_ENCRYPTION_KEY=${encryptionKey}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, '01-database.sql'), buildDatabaseSQL());
  fs.writeFileSync(path.join(directory, '01-update-existing.sql'), buildUpdateSQL());
  fs.writeFileSync(path.join(directory, '03-index.ts'), buildFunction());
  fs.writeFileSync(path.join(directory, 'README.md'), `# Нова пошта · ${projectRef}\n\n` + read('docs/nova-poshta-new-project.md'));
  // Only known obsolete generated files, never user files or the encryption key.
  for (const name of ['04-schedule.sql', '04-shipment-details.sql', 'NOVA-POSHTA-COPY-ALL.txt']) {
    const obsolete = path.resolve(directory, name);
    if (path.dirname(obsolete) !== path.resolve(directory)) throw new Error('Invalid cleanup path');
    if (fs.existsSync(obsolete)) fs.unlinkSync(obsolete);
  }
  console.log(`Dashboard files ready: ${directory}\nEncryption key is saved locally and never printed.`);
}

module.exports = { buildDatabaseSQL, buildUpdateSQL, buildFunction, prepare, projectRefFrom, readProjectUrlFromFiles, splitSql };
if (require.main === module) prepare(process.argv[2]);
