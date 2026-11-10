// Prepare local SQL artifacts from the latest template. Never connects to a database.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const canonical = process.argv[2];
if (!canonical || !path.isAbsolute(canonical)) throw Error('Pass the absolute path of the current file 8');
const migrationName = '20261025064857_act_freeze_payroll_archive.sql';
const migrationPath = path.join(root, 'supabase/migrations', migrationName);
const normalize = text => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const migration = normalize(fs.readFileSync(migrationPath, 'utf8'));
if (!migration.includes('freeze_payroll_version')) throw Error('Migration is incomplete');
const body = migration.replace(/^begin;\s*$/mi, '').replace(/^commit;\s*$/mi, '').trim();
const start = '-- BEGIN ATOMIC ACT FREEZE PAYROLL 2026-10-25';
const end = '-- END ATOMIC ACT FREEZE PAYROLL 2026-10-25';
const block = `${start}\n${body}\n${end}`;
const standalone = `-- SQL Editor: виконати весь файл. НЕ Edge Functions.
-- Для чинної бази з міграціями зарплат, журналу виплат та PostgREST 9.1.
-- Спочатку цей SQL, потім оновлення сайту. Для нових проєктів включено у файл 8.
-- Замороження переносить нарахування цього акта в окремий архів і повертає деталі.
-- Розмороження відновлює нарахування разом із виплатами; повторна виплата не створюється.
-- Зміни даних відбуваються лише після натискання кнопки; інсталяція нічого не заморожує.
begin;
${block}
commit;
`;
const output = path.join(root, 'supabase/setup/traffic-optimization/act-freeze-payroll.sql');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, standalone);

const original = fs.readFileSync(canonical);
let base = normalize(original.toString('utf8'));
for (const name of ['payroll_json_object', 'assert_editor_act_lease', 'assert_payroll_paid_preserved', 'write_payroll_fragments', 'guarded_set_act_frozen']) {
  if (!base.includes(`function public.${name}(`)) throw Error(`File 8 lacks ${name}; use the latest full template`);
}
const previous = base.indexOf(start);
if (previous >= 0) {
  const finish = base.indexOf(end, previous);
  if (finish < 0) throw Error('Unclosed previous freeze block');
  base = base.slice(0, previous) + base.slice(finish + end.length);
}
const commit = /commit;\s*$/i.exec(base);
if (!commit) throw Error('File 8 must end with COMMIT');
const combined = base.slice(0, commit.index).trimEnd() + `\n\n${block}\n\nnotify pgrst, 'reload schema';\ncommit;\n`;
const prepared = path.join(root, 'errorSTO/act-freeze-payroll-prepared');
fs.mkdirSync(prepared, { recursive: true });
fs.writeFileSync(path.join(prepared, path.basename(canonical)), combined);
fs.writeFileSync(path.join(prepared, 'manifest.json'), JSON.stringify({
  canonicalSource: canonical, canonicalSourceSha256: sha(original), file8Sha256: sha(combined),
  migration: migrationName, migrationSha256: sha(migration), sqlSha256: sha(standalone),
}, null, 2) + '\n');
console.log('Prepared act-freeze-payroll.sql and updated file 8. No deployment or database writes.');
