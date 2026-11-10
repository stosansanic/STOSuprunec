// Deterministic SQL packaging only; never connects to a database.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const name = '20261023063556_realtime_traffic_optimization.sql';
const source = fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8').replace(/\r\n/g, '\n');
const start = '-- BEGIN REALTIME OPTIMIZATION V1';
const end = '-- END REALTIME OPTIMIZATION V1';
const block = `${start}\n-- SOURCE: ${name}\n${source.replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '').trim()}\n${end}\n`;
const bundle = path.join(root, 'errorSTO/template-update-prepared/8 зменьшує вихідний трафік.sql');
let sql = fs.readFileSync(bundle, 'utf8').replace(/\r\n/g, '\n');
const first = sql.indexOf(start);
if (first >= 0) {
  const last = sql.indexOf(end, first);
  if (last < 0) throw new Error('Unclosed realtime bundle marker');
  sql = sql.slice(0, first) + sql.slice(last + end.length).replace(/^\n/, '');
}
const commit = /commit;\s*$/i.exec(sql);
if (!commit) throw new Error('File 8 must have its final transaction commit');
sql = sql.slice(0, commit.index).trimEnd() + '\n\n' + block + '\ncommit;\n';
fs.writeFileSync(bundle, sql);
fs.writeFileSync(path.join(root, 'supabase/setup/traffic-optimization/realtime-repair.sql'), source);

// NP's later file 9 must not reinstall the old settings-writing rate limiter.
const npStart = '-- BEGIN REALTIME NP RATE';
const npEnd = '-- END REALTIME NP RATE';
const npBlock = source.slice(source.indexOf(npStart), source.indexOf(npEnd) + npEnd.length);
const npPath = path.join(root, 'supabase/setup/nova-poshta.sql');
let np = fs.readFileSync(npPath, 'utf8').replace(/\r\n/g, '\n');
if (np.includes(npStart)) {
  np = np.slice(0, np.indexOf(npStart)) + npBlock + np.slice(np.indexOf(npEnd) + npEnd.length);
} else {
  const rateStart = np.indexOf('-- Atomic, expiring login/request counters');
  const rateEnd = np.indexOf('alter table public.acts add column', rateStart);
  if (rateStart < 0 || rateEnd < 0) throw new Error('NP rate boundaries not found');
  np = np.slice(0, rateStart) + npBlock + '\n' + np.slice(rateEnd);
}
np = np.replace("on conflict(setting_id) do update set novaposhta=coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta;",
  "on conflict(setting_id) do update set novaposhta=coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta\n  where settings.novaposhta is distinct from coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta;");
fs.writeFileSync(npPath, np);
const { buildDatabaseSQL, buildUpdateSQL } = require('./prepare-nova-poshta-dashboard.cjs');
const npTemplate = path.join(root, 'errorSTO/template-update-prepared/nova-poshta');
fs.writeFileSync(path.join(npTemplate, '9 Нова пошта база.sql'), '-- NEW STO PROJECT: run after the base STO schema. SQL Editor only.\n' + buildDatabaseSQL());
fs.writeFileSync(path.join(npTemplate, '9.4 Нова пошта оновити наявну.sql'), buildUpdateSQL());
console.log('Prepared realtime-repair.sql, file 8 and NP SQL templates.');
