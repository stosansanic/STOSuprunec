const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const source = path.resolve('supabase/functions/_shared/nova-poshta-domain.ts');
const loaded = new Module(source, module);
loaded._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, source);
const domain = loaded.exports;

test('tracking payload preserves absent dates and distinguishes created from dispatched', () => {
  const patch = domain.trackingPatch({ StatusCode: '1', Status: 'Нова пошта очікує надходження', DateCreated: '27-09-2026 10:00:00', ScheduledDeliveryDate: '', CargoDescription: 'Генератор' });
  assert.equal(patch.state, 'created');
  assert.equal(patch.document_date, '2026-09-27');
  assert.ok(!('sent_date' in patch));
  assert.ok(!('estimated_date' in patch));
  assert.ok(!('description' in patch), 'Provider must not overwrite the internal description');
  assert.equal(domain.mapStatus('999'), 'unknown');
  assert.equal(domain.mapStatus('103'), 'attention');
});
test('TTN validation and dates reject invalid values; direction controls arrival wording', () => {
  assert.equal(domain.normalizeTTN('2040 0000 0000 01'), '20400000000001');
  assert.throws(() => domain.normalizeTTN('2040000000000x'));
  assert.equal(domain.npDate('31.02.2026'), null);
  assert.equal(domain.npDate('2026-10-25 23:30:00'), '2026-10-25');
  assert.equal(domain.npDate('0001-01-01'), null);
  assert.equal(domain.statusLabel('arrived', 'incoming'), 'Потрібно забрати');
  assert.equal(domain.statusLabel('arrived', 'outgoing'), 'Очікує отримувача');
});

// Optional tooling lives outside project dependencies. This executes real PostgreSQL SQL in WASM.
test('planned delivery rejects sentinel dates and preserves valid dates and time', () => {
  const row = { ArrivalDateTime: '01.01.0001 00:00:00', ScheduledDeliveryDate: '03.10.2026 12:00:00' };
  assert.equal(domain.documentDetails(row).delivery, '2026-10-03 12:00:00');
  assert.equal(domain.npTimestamp('0001-01-01 00:00:00'), null);
  assert.equal(domain.npTimestamp('01.01.0001 00:00:00'), null);
  assert.equal(domain.npTimestamp('31.02.2026 12:00:00'), null);
  assert.equal(domain.npTimestamp('03.10.2026'), '2026-10-03');
  assert.equal(domain.plannedDelivery({ ScheduledDeliveryDate: '0001-01-01', ArrivalDateTime: '04.10.2026 15:00:00' }), '2026-10-04 15:00:00');
  assert.equal(domain.plannedDelivery({ ScheduledDeliveryDate: '03.10.2026', ArrivalDateTime: '02.10.2026 10:00:00' }), '2026-10-03');
  assert.equal(domain.plannedDelivery({ ArrivalDateTime: '01.01.0001 00:00:00' }), null);
});
test('sender details use provider contact fields and a nonempty counterparty fallback', () => {
  const details = domain.documentDetails({ SenderName: ' Contact ', CounterpartySenderDescription: 'Company', PhoneSender: '380000000000', CitySenderDescription: 'City', SenderAddressDescription: 'Address' });
  assert.equal(details.sender, 'Contact');
  assert.equal(details.sender_phone, '380000000000');
  assert.equal(details.sender_city, 'City');
  assert.equal(details.sender_address, 'Address');
  assert.equal(domain.documentDetails({ SenderName: ' ', CounterpartySenderDescription: 'Company' }).sender, 'Company');
  assert.equal(domain.documentDetails({}).sender, '');
});
const validationRoot = process.env.NP_VALIDATION_ROOT;
test('party display puts contact before company and suppresses private-person labels', () => {
  const data = domain.documentDetails({SenderName:'ТОВ "Приклад"',SenderContactPerson:'Іваненко Іван Іванович',RecipientName:'Приватна особа',RecipientFullName:'Петренко Петро Петрович'});
  assert.deepEqual(domain.partyLines(data.sender_contact,data.sender_company,data.sender),['Іваненко Іван Іванович','ТОВ "Приклад"']);
  assert.deepEqual(domain.partyLines(data.recipient_contact,data.recipient_company,data.recipient),['Петренко Петро Петрович']);
  const recipient = domain.documentDetails({RecipientName:'ТОВ "ЛЮКС"',ContactRecipientDescription:'Кізюн Юрій Володимирович'});
  assert.deepEqual(domain.partyLines(recipient.recipient_contact,recipient.recipient_company,recipient.recipient),['Кізюн Юрій Володимирович','ТОВ "ЛЮКС"']);
  assert.deepEqual(domain.partyLines(undefined,undefined,'Приватна особа'),[]);
  assert.deepEqual(domain.partyLines('Іваненко Іван','ФОП Іваненко Іван'),['Іваненко Іван','ФОП Іваненко Іван']);
  assert.equal(domain.documentDetails({ContactSender:'00000000-0000-4000-8000-000000000001',SenderName:'Приватна особа'}).sender_contact,'');
});
let db;
before(async () => {
  if (!validationRoot) return;
  const { PGlite } = require(path.join(validationRoot, 'node_modules/@electric-sql/pglite'));
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create table public.slyusars(slyusar_id integer primary key,data jsonb);
    create table public.cars(cars_id bigint primary key,data jsonb);
    create table public.acts(act_id bigint primary key,cars_id bigint references cars, date_off timestamptz,pruimalnyk text,data jsonb);
    create table public.settings(setting_id integer primary key,data boolean not null,"Загальні" text,"Запчастист" boolean,"Складовщик" boolean,novaposhta jsonb);
    insert into public.settings(setting_id,data,"Загальні") values(10,true,'Existing general value');
    grant select,insert,update,delete on public.settings to authenticated;
  `);
  await db.exec(fs.readFileSync('supabase/migrations/20260927000000_nova_poshta.sql', 'utf8'));
  await db.exec(fs.readFileSync('supabase/migrations/20260928000000_nova_poshta_connection_controls.sql', 'utf8'));
  await db.exec(`
    insert into slyusars values(1,'{"Name":"Admin","Доступ":"Адміністратор"}'),(2,'{"Name":"Receiver","Доступ":"Приймальник"}'),(3,'{"Name":"Other","Доступ":"Приймальник"}');
    insert into acts values(100,null,null,'Receiver','{}'),(101,null,now(),'Receiver','{}'),(102,null,null,'Receiver','{"Заморожений":true}');
    insert into np_connections(id) values(1);
    insert into np_shipments(id,ttn,direction,description) values('00000000-0000-4000-8000-000000000001','20400000000001','incoming','Наш опис');
  `);
});
after(async () => { if (db) await db.close(); });
const sqlTest = (name, fn) => test(name, { skip: !validationRoot }, fn);
const shipment = '00000000-0000-4000-8000-000000000001';

sqlTest('new module tables and secret RPC reject browser roles', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(db.query('select * from public.np_sessions'), /permission denied/);
      await assert.rejects(db.query('select public.np_secret()'), /permission denied/);
      await assert.rejects(db.query('select * from np_private.credentials'), /permission denied/);
    } finally { await db.exec('reset role'); }
  }
});
sqlTest('linking enforces act ownership, closed/frozen rules and optimistic conflict checks', async () => {
  const call = (person, act, version, remove = false) => db.query('select np_link($1,$2,$3,$4,$5,$6,$7)', [person, shipment, act, version, remove, 'Деталь', 'Деталі до нас']);
  await assert.rejects(call(3, 100, 0), /ACT_FORBIDDEN/);
  await assert.rejects(call(1, 101, 0), /ACT_FORBIDDEN/);
  await assert.rejects(call(1, 102, 0), /ACT_FORBIDDEN/);
  await call(2, 100, 0);
  assert.equal((await db.query('select link_count from np_shipments')).rows[0].link_count, 1);
  await assert.rejects(call(2, 100, 0), /CONFLICT/);
  await call(2, 100, 1);
  await assert.rejects(call(2, 100, 1, true), /CONFLICT/);
  await call(2, 100, 2, true);
  assert.equal((await db.query('select link_count from np_shipments')).rows[0].link_count, 0);
});
sqlTest('only one sync can run; repeated tracking responses do not duplicate events or erase notes', async () => {
  const token = (await db.query('select np_claim_sync() as token')).rows[0].token;
  assert.ok(token);
  assert.equal((await db.query('select np_claim_sync() as token')).rows[0].token, null);
  const patch = domain.trackingPatch({ StatusCode: '7', Status: 'Прибула у відділення', ScheduledDeliveryDate: '28.09.2026' });
  await db.query('select np_apply_tracking($1,$2,$3)', [token, shipment, JSON.stringify(patch)]);
  await db.query('select np_apply_tracking($1,$2,$3)', [token, shipment, JSON.stringify(patch)]);
  assert.equal((await db.query('select count(*)::int as n from np_events')).rows[0].n, 1);
  assert.equal((await db.query('select description from np_shipments')).rows[0].description, 'Наш опис');
  await db.query('select np_apply_tracking($1,$2,$3)', [token, shipment, JSON.stringify({ ...patch, raw_status: 'Прибула у відділення №2' })]);
  assert.equal((await db.query('select count(*)::int as n from np_events where notify')).rows[0].n, 1);
  await assert.rejects(db.query('select np_apply_tracking($1,$2,$3)', [shipment, shipment, JSON.stringify(patch)]), /SYNC_EXPIRED/);
});
sqlTest('read receipts never move backwards across devices and rate limiter is shared', async () => {
  const before = (await db.query('select version::int from np_revision')).rows[0].version;
  await db.query('select np_mark_read(1,2)'); await db.query('select np_mark_read(1,1)');
  assert.ok((await db.query('select version::int from np_revision')).rows[0].version > before, 'Other devices must receive the read-state invalidation');
  assert.equal((await db.query('select last_event_id::int from np_reads where employee_id=1')).rows[0].last_event_id, 2);
  assert.equal((await db.query("select np_rate('test',1,60) as allowed")).rows[0].allowed, true);
  assert.equal((await db.query("select np_rate('test',1,60) as allowed")).rows[0].allowed, false);
});
sqlTest('terminal shipments leave regular polling only after a confirming response', async () => {
  const token = (await db.query('select lock_token from np_connections where id=1')).rows[0].lock_token;
  const apply = patch => db.query('select np_apply_tracking($1,$2,$3)', [token, shipment, JSON.stringify(patch)]);
  const received = domain.trackingPatch({ StatusCode: '9', Status: 'Отримано' });
  await apply(received);
  assert.equal((await db.query('select terminal_confirmed from np_shipments')).rows[0].terminal_confirmed, false);
  await apply(received);
  assert.equal((await db.query('select terminal_confirmed from np_shipments')).rows[0].terminal_confirmed, true);
  await apply(domain.trackingPatch({ StatusCode: '103', Status: 'Повернення' }));
  assert.equal((await db.query('select terminal_confirmed from np_shipments')).rows[0].terminal_confirmed, false);
});
sqlTest('connection settings preserve existing columns, guard credentials and support pause/resume/removal', async () => {
  const encrypted = 'fixture-ciphertext-not-an-api-key-1234567890';
  const change = (employee, action, name = 'СТО', phone = '380961234567', key = encrypted) => db.query('select np_change_connection($1,$2,$3,$4,$5)', [employee, action, name, phone, key]);
  await assert.rejects(change(2, 'connect'), /ADMIN_REQUIRED/);
  await assert.rejects(change(1, 'connect'), /SYNC_BUSY/);
  await db.exec("update np_connections set lock_until=null,lock_token=null where id=1");
  await change(1, 'connect');
  const row = (await db.query('select data,"Загальні",novaposhta from settings where setting_id=10')).rows[0];
  assert.equal(row.data, true);
  assert.equal(row['Загальні'], 'Existing general value');
  assert.equal(row.novaposhta.api_key_encrypted, encrypted);
  assert.equal(row.novaposhta.enabled, true);
  await db.exec('set role authenticated');
  try {
    await assert.rejects(db.query("update settings set novaposhta='{}' where setting_id=10"), /NP_SETTINGS_SERVER_ONLY/);
    await assert.rejects(db.query('delete from settings where setting_id=10'), /NP_SETTINGS_SERVER_ONLY/);
    await assert.rejects(db.query("select np_change_connection(1,'disconnect')"), /permission denied/);
    await db.query('update settings set data=false where setting_id=10');
  } finally { await db.exec('reset role'); }
  await change(1, 'disconnect');
  assert.equal((await db.query('select novaposhta from settings where setting_id=10')).rows[0].novaposhta.enabled, false);
  await change(1, 'save_settings', 'Нова назва');
  assert.equal((await db.query('select np_secret() as value')).rows[0].value, encrypted);
  await change(1, 'resume');
  assert.equal((await db.query('select novaposhta from settings where setting_id=10')).rows[0].novaposhta.enabled, true);
  await change(1, 'forget_key');
  assert.equal((await db.query('select np_secret() as value')).rows[0].value, null);
  await assert.rejects(change(1, 'resume'), /NP_KEY_MISSING/);
  assert.equal((await db.query('select count(*)::int as n from np_shipments')).rows[0].n, 1);
});
