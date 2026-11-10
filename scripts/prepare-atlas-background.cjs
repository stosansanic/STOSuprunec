// Deterministic packaging; no Supabase connections and no external writes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),canonical=process.argv[2];
if(!canonical||!path.isAbsolute(canonical))throw Error('Pass the absolute path of the current file 8');
const read=p=>fs.readFileSync(path.join(root,p),'utf8').replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const migrationPath='supabase/migrations/20261023114017_atlas_background_efficiency.sql';
const migration=read(migrationPath),claims=read('supabase/migrations/20261011100000_reminder_delivery_claims.sql');
const objectSource=read('supabase/migrations/20261023081041_atlas_postgrest_efficiency.sql');
const helper=objectSource.slice(objectSource.indexOf('create or replace function public.traffic_atlas_object'),objectSource.indexOf('-- Number(value || fallback)')).trim();
if(!helper.endsWith('end $$;'))throw Error('Atlas object helper boundary changed');
const body=migration.replace(/^begin;\s*$/mi,'').replace(/commit;\s*$/i,'').trim();
const start='-- BEGIN ATLAS BACKGROUND 2026-10-23',end='-- END ATLAS BACKGROUND 2026-10-23';
const block=start+'\n'+body+'\n'+end;
const output=path.join(root,'supabase/setup/atlas-background');fs.mkdirSync(output,{recursive:true});
const name='9.4 Атлас — фонові нагадування.sql';
const standalone=`-- SQL Editor, НЕ Edge Functions. Виконати весь файл один раз (можна повторно).
-- Чинна база СТО: потрібні atlas_reminders, atlas_reminder_logs, slyusars, settings,
-- execute_condition_query, trigger_reminder та встановлений Supabase Cron з базового 1.1.
-- Залежності атомарної доставки включено нижче. Історію не очищаємо.
-- Порядок: цей SQL -> check-reminders/index.ts із цієї папки -> оновлення сайту.
-- Для нового проєкту ці зміни також включено в повний файл 8.
begin;
${helper}
${claims}
${block}
commit;
`;
fs.writeFileSync(path.join(output,name),standalone);
const original=fs.readFileSync(canonical);let base=original.toString('utf8').replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
if(!base.includes('function public.claim_reminder_delivery')||!base.includes('function public.traffic_atlas_object'))throw Error('File 8 lacks required dependencies; use its current full version');
const prior=base.indexOf(start);if(prior>=0){const last=base.indexOf(end,prior);if(last<0)throw Error('Unclosed Atlas block');base=base.slice(0,prior)+base.slice(last+end.length);}
const commit=/commit;\s*$/i.exec(base);if(!commit)throw Error('File 8 must end with COMMIT');
const combined=base.slice(0,commit.index).trimEnd()+'\n\n'+block+"\n\nnotify pgrst, 'reload schema';\ncommit;\n";
const prepared=path.join(root,'errorSTO/atlas-background-prepared');fs.mkdirSync(prepared,{recursive:true});
fs.writeFileSync(path.join(prepared,'8 зменьшує вихідний трафік.sql'),combined);
execFileSync(process.execPath,[path.join(root,'scripts/prepare-postgrest-edge-dashboard.cjs')],{cwd:root,stdio:'inherit'});
const edge=fs.readFileSync(path.join(root,'supabase/setup/postgrest-edge-update/03-check-reminders-index.ts'));
fs.writeFileSync(path.join(output,'02-check-reminders-index.ts'),edge);
fs.writeFileSync(path.join(output,'bundle-manifest.json'),JSON.stringify({canonicalSource:canonical,canonicalSourceSha256:sha(original),file8Sha256:sha(combined),sqlFile:name,sqlSha256:sha(standalone),edgeSha256:sha(edge),migration:migrationPath},null,2)+'\n');
console.log('Prepared Atlas SQL, complete Edge source and updated file 8. No deployment or database writes.');
