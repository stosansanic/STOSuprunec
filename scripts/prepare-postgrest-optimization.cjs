// Deterministic packaging only. Reads the current canonical file 8; never
// connects to Supabase and never writes outside this repository.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const canonical = process.argv[2];
if (!canonical || !path.isAbsolute(canonical)) throw new Error('Pass the absolute path of the current canonical file 8');
const migrations = [
  '20261023063556_realtime_traffic_optimization.sql',
  '20261023080955_act_editor_scoped_traffic.sql',
  '20261023081041_atlas_postgrest_efficiency.sql',
  '20261023081212_workshop_postgrest_efficiency.sql',
  '20261023081314_accounting_bounded_reports.sql',
  '20261023081918_postgrest_resource_revisions.sql',
  '20261023082222_service_history_compact_summaries.sql',
  '20261023082800_compact_settings_sms_np_context.sql',
  '20261023083234_batch_import_scoped_traffic.sql',
  '20261023083651_accounting_resource_revisions.sql',
];
const normalize = value => value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const begin = '-- BEGIN POSTGREST OPTIMIZATION 2026-10-23';
const end = '-- END POSTGREST OPTIMIZATION 2026-10-23';
const sections = migrations.map(name => {
  const raw = normalize(fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8'));
  if (!/^begin;\s*$/mi.test(raw) || !/commit;\s*$/i.test(raw)) throw new Error(`Missing transaction boundary: ${name}`);
  const sql = raw.replace(/^begin;\s*$/mi, '').replace(/commit;\s*$/i, '').trim();
  if (!sql.includes('create or replace function')) throw new Error(`Incomplete migration: ${name}`);
  return { name, sha256: sha(raw), sql };
});
const block = `${begin}\n${sections.map(section => `-- SOURCE: ${section.name}\n${section.sql}`).join('\n\n')}\n${end}\n`;
const output = path.join(root, 'supabase/setup/traffic-optimization');
fs.mkdirSync(output, { recursive: true });
const upgradeName = '9.1 Оптимізація PostgREST.sql';
const upgrade = `-- 23.10.2026. Оновлення чинного проєкту. Вставити ВЕСЬ файл у Supabase SQL Editor.\n-- Це SQL, не код Edge Function. Спочатку SQL, потім оновлення сайту та Edge Functions.\n-- Потрібна чинна схема СТО й попередній повний файл 8 (від 21.10.2026 або новіший).\n-- Включено необхідні залежності оптимізації Realtime. Повторне виконання дозволено.\n-- Для нового проєкту основні зміни вже включено у файл 8.\n-- Якщо пізніше встановлено старий файл 9 Нової пошти, виконайте цей пакет останнім.\n-- Одна транзакція: помилка скасовує весь цей пакет. Історії виплат не видаляються.\n-- Реєстр версій росте з кількістю транзакцій; контролюйте його розмір і час читання.\n\nbegin;\n${block}\nnotify pgrst, 'reload schema';\ncommit;\n`;
fs.writeFileSync(path.join(output, upgradeName), upgrade);

const baseBytes = fs.readFileSync(canonical);
let base = normalize(baseBytes.toString('utf8'));
function withoutBlock(sql, first, last) {
  const start = sql.indexOf(first);
  if (start < 0) return sql;
  const finish = sql.indexOf(last, start);
  if (finish < 0) throw new Error(`Unclosed marker: ${first}`);
  return sql.slice(0, start) + sql.slice(finish + last.length).replace(/^\n/, '');
}
base = withoutBlock(base, begin, end);
// Include this dependency once even if the previous local bundle already had it.
base = withoutBlock(base, '-- BEGIN REALTIME OPTIMIZATION V1', '-- END REALTIME OPTIMIZATION V1');
const commit = /commit;\s*$/i.exec(base);
if (!commit) throw new Error('Canonical file 8 must end with COMMIT');
base = base.replace(/^-- Пакет від[^\n]*\n/, '-- Пакет від 23.10.2026: PostgREST, Realtime, бухгалтерія та надійні записи.\n');
const finalCommit = /commit;\s*$/i.exec(base);
const combined = base.slice(0, finalCommit.index).trimEnd() + '\n\n' + block + "\nnotify pgrst, 'reload schema';\ncommit;\n";
const prepared = path.join(root, 'errorSTO/template-update-prepared');
fs.mkdirSync(prepared, { recursive: true });
fs.writeFileSync(path.join(prepared, '8 зменьшує вихідний трафік.sql'), combined);
fs.writeFileSync(path.join(prepared, upgradeName), upgrade);
fs.writeFileSync(path.join(output, 'postgrest-bundle-manifest.json'), JSON.stringify({
  canonicalSource: canonical,
  canonicalSourceSha256: sha(baseBytes),
  upgradeSha256: sha(upgrade),
  file8Sha256: sha(combined),
  migrations: sections.map(({ name, sha256 }) => ({ name, sha256 })),
}, null, 2) + '\n');
console.log(`Prepared ${upgradeName} (${Buffer.byteLength(upgrade)} bytes), file 8 (${Buffer.byteLength(combined)} bytes); ${migrations.length} migrations. No database connection.`);
