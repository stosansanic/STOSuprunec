// Update SQL bundles locally; this script never connects to a database.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const name = '20261015180716_traffic_planner_client_options.sql';
const migration = fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const startMarker = '-- BEGIN PLANNER CLIENT OPTIONS 2026-10-15';
const endMarker = '-- END PLANNER CLIENT OPTIONS 2026-10-15';
const block = `${startMarker}\n-- SOURCE: ${name}\n` + migration.replace(/\r\n/g, '\n')
  .replace(/^\s*begin;\s*$/gmi, '')
  .replace(/^\s*commit;\s*$/gmi, '')
  .replace(/^\s*notify pgrst, 'reload schema';\s*$/gmi, '').trim() + `\n${endMarker}\n`;

function update(file) {
  let source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new Error('Malformed planner section');
  if (start >= 0) source = source.slice(0, start) + source.slice(end + endMarker.length);
  if (/create or replace function public\.traffic_planner_client_options\(/i.test(source)) {
    throw new Error('Planner function already exists outside the managed section');
  }
  if (!source.includes('function public.sto_read_object_v1(')) throw new Error('Missing base reader');
  const commit = /\bcommit;\s*$/i.exec(source);
  if (!commit || !/^begin;\s*$/mi.test(source)) throw new Error('Expected a consolidated transaction');
  source = source.slice(0, commit.index) + '\n' + block + "\nnotify pgrst, 'reload schema';\n" + source.slice(commit.index);
  fs.writeFileSync(file, source, 'utf8');
  console.log(`Updated ${file}`);
}

const templateIndex = process.argv.indexOf('--template');
if (templateIndex >= 0) {
  const template = process.argv[templateIndex + 1];
  if (!template || !path.isAbsolute(template)) throw new Error('Expected absolute template path');
  update(template);
} else {
  update(path.join(root, 'supabase/setup/traffic-optimization/install.sql'));
}
