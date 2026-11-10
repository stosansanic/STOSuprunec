// Deterministic local packaging only. Never connects to or changes a database.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const canonical = process.argv[2];
if (!canonical || !path.isAbsolute(canonical)) throw Error('Pass the absolute path of the current file 8');
const migrationName = '20261025111229_financial_overview.sql';
const normalize = text => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const migration = normalize(fs.readFileSync(path.join(root, 'supabase/migrations', migrationName), 'utf8'));
if (!migration.includes('function public.traffic_financial_overview(')) throw Error('Incomplete financial migration');
const body = migration.replace(/^begin;\s*$/mi, '').replace(/^commit;\s*$/mi, '').trim();
const start = '-- BEGIN FINANCIAL OVERVIEW 2026-10-25';
const end = '-- END FINANCIAL OVERVIEW 2026-10-25';
const block = `${start}\n${body}\n${end}`;
const standalone = `-- SQL Editor: виконати весь файл. НЕ Edge Functions.
-- Для чинної бази з установленими міграціями зарплати та журналом виплат.
-- Спочатку цей SQL, потім оновлення сайту. Для нових проєктів уже включено у файл 8.
-- Створює лише функції читання фінансового зведення. Не змінює акти, виплати чи склад.
-- Додаткові можливості: короткі версії даних (PostgREST 9.1), архів заморожених зарплат.
-- Без них запит працює без кеш-ревізії або повідомляє про недоступний архів.
begin;
${block}
commit;
`;
const output = path.join(root, 'supabase/setup/traffic-optimization/financial-overview.sql');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, standalone);
const original = fs.readFileSync(canonical);
let base = normalize(original.toString('utf8'));
for (const name of ['traffic_payroll_payments', 'traffic_payroll_payment_earned']) {
  if (!base.includes(`function public.${name}(`)) throw Error(`File 8 lacks required ${name}`);
}
const previous = base.indexOf(start);
if (previous >= 0) {
  const finish = base.indexOf(end, previous);
  if (finish < 0 || base.indexOf(start, previous + start.length) >= 0) throw Error('Broken or duplicated financial block');
  base = base.slice(0, previous) + base.slice(finish + end.length);
}
const commit = /commit;\s*$/i.exec(base);
if (!commit) throw Error('File 8 must end with COMMIT');
const combined = base.slice(0, commit.index).trimEnd() + `\n\n${block}\n\nnotify pgrst, 'reload schema';\ncommit;\n`;
const prepared = path.join(root, 'errorSTO/financial-overview-prepared');
fs.mkdirSync(prepared, { recursive: true });
fs.writeFileSync(path.join(prepared, path.basename(canonical)), combined);
fs.writeFileSync(path.join(prepared, 'manifest.json'), JSON.stringify({
  canonicalSource: canonical, canonicalSourceSha256: sha(original), file8Sha256: sha(combined),
  migration: migrationName, migrationSha256: sha(migration), sqlSha256: sha(standalone),
}, null, 2) + '\n');
console.log('Prepared financial-overview.sql and file 8. No database writes or deployment.');
