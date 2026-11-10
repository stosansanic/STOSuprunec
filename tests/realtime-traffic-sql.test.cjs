const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require(process.env.STO_PGLITE_MODULE || '@electric-sql/pglite');
const source = fs.readFileSync('supabase/migrations/20261023063556_realtime_traffic_optimization.sql', 'utf8');

async function fixture() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table acts(act_id bigint primary key,data jsonb,date_on timestamptz,date_off timestamptz,cars_id bigint,client_id bigint,pruimalnyk text,"slusarsOn" boolean);
    create table post_arxiv(post_arxiv_id bigint primary key,data_on timestamptz,data_off timestamptz,name_post text,slyusar_id bigint);
    create table settings(setting_id bigint primary key,data boolean,novaposhta jsonb);
    create table atlas_reminder_logs(log_id bigint primary key,reminder_id bigint,message_text text,sent_at timestamptz,delivery_status text);
    create table source_updates(source text);
    create function record_source_update() returns trigger language plpgsql as $$begin insert into public.source_updates values(tg_table_name);return new;end$$;
    create trigger record_act_update after update on acts for each row execute function record_source_update();
    create trigger record_setting_update after update on settings for each row execute function record_source_update();
    insert into settings values(10,false,jsonb_build_object('api_key_encrypted','unchanged','_rate',jsonb_build_object('live',jsonb_build_object('attempts',2,'expires',extract(epoch from now())::bigint+300))));
    insert into acts values(1,'{"Роботи":[{"Зарплата":25}],"Деталі":[],"Загальна сума":50,"Пробіг":100}',now(),null,10,20,'A',false);`);
  await db.exec(source);
  return db;
}

test('SQL installs idempotently without rewriting acts; compact state is maintained atomically', async () => {
  const db = await fixture();
  try {
    assert.equal((await db.query("select count(*) n from source_updates where source='acts'")).rows[0].n,0);
    assert.equal((await db.query('select traffic_state from acts where act_id=1')).rows[0].traffic_state,null);
    await db.exec(`update acts set data=jsonb_set(data,'{Пробіг}','101') where act_id=1`);
    const read = async () => (await db.query('select traffic_state s from acts where act_id=1')).rows[0].s;
    const a = await read();
    assert.equal(a.summary['Загальна сума'],50); assert.equal(a.summary['Пробіг'],101);
    assert.equal(a.summary['Роботи'],undefined); assert.equal(a.summary['Деталі'],undefined);
    assert.equal(a.previous.cars_id,10);
    assert.equal(a.previous.slusarsOn,false);
    await db.exec(`update acts set data=jsonb_set(data,'{Пробіг}','102') where act_id=1`);
    const b = await read(); assert.notEqual(b.revision,a.revision); assert.equal(b.staff_revision,a.staff_revision);
    await db.exec(`update acts set data=jsonb_set(data,'{Роботи,0,Зарплата}','30'),cars_id=11 where act_id=1`);
    const c = await read(); assert.notEqual(c.staff_revision,b.staff_revision); assert.equal(c.previous.cars_id,10);
    await db.exec(`update acts set traffic_state='{"frozen":true}' where act_id=1`);
    assert.deepEqual(await read(),c);
    await db.exec(source); assert.deepEqual(await read(),c);
    await db.exec(`insert into acts(act_id,data) values(2,to_jsonb('{"Заморожений":true,"Роботи":[]}'::text))`);
    assert.equal((await db.query('select traffic_state s from acts where act_id=2')).rows[0].s.frozen,true);
    await db.exec(`insert into post_arxiv values(1,'2026-10-20','2026-10-21','Old',1,null);
      update post_arxiv set data_on='2026-10-23',name_post='New',slyusar_id=2 where post_arxiv_id=1`);
    const previous = (await db.query('select traffic_previous p from post_arxiv')).rows[0].p;
    assert.match(previous.data_on,/2026-10-20/); assert.equal(previous.name_post,'Old'); assert.equal(previous.slyusar_id,1);
  } finally { await db.close(); }
});

test('NP limits preserve live counters and never update settings for admitted or rejected requests', async () => {
  const db = await fixture();
  try {
    const settings = (await db.query('select novaposhta from settings')).rows[0].novaposhta;
    assert.equal(settings.api_key_encrypted,'unchanged'); assert.equal(settings._rate,undefined);
    await db.exec('truncate source_updates');
    const rate = async (key='live') => (await db.query('select np_online_rate($1,3,300) ok',[key])).rows[0].ok;
    assert.equal(await rate(),true); assert.equal(await rate(),false);
    await db.exec(source); assert.equal(await rate(),false);
    for (let i=0;i<3;i++) assert.equal(await rate('other'),true);
    assert.equal(await rate('other'),false);
    assert.equal((await db.query('select count(*) n from source_updates')).rows[0].n,0);
    await db.query('select np_online_settings($1::jsonb)',[JSON.stringify({api_key_encrypted:'unchanged'})]);
    assert.equal((await db.query('select count(*) n from source_updates')).rows[0].n,0);
    await db.query('select np_online_settings($1::jsonb)',[JSON.stringify({enabled:true})]);
    assert.equal((await db.query('select count(*) n from source_updates')).rows[0].n,1);
    await db.exec("update sto_realtime_private.np_rate_buckets set expires_at=now()-interval '1 second'");
    assert.equal(await rate(),true);
    await assert.rejects(db.query("select np_online_rate('x',0,60)"),/INVALID_RATE/);
    await db.exec('set role authenticated');
    await assert.rejects(db.query("select np_online_rate('x',3,60)"),/permission denied/);
    await assert.rejects(db.query('select * from sto_realtime_private.np_rate_buckets'),/permission denied/);
  } finally { await db.close(); }
});

test('latest callback RPC returns one row per requested reminder and respects source RLS', async () => {
  const db = await fixture();
  try {
    await db.exec(`insert into atlas_reminder_logs values
      (1,1,'old','2026-10-20','callback'),(2,1,'new','2026-10-21','callback'),
      (3,1,'sending','2026-10-22','delivered'),(4,2,'other','2026-10-21','callback');
      grant select on atlas_reminder_logs to authenticated;
      alter table atlas_reminder_logs enable row level security;
      create policy allowed_log on atlas_reminder_logs for select to authenticated using(reminder_id=1);
      set role authenticated;`);
    const rows = (await db.query('select traffic_reminder_latest_callbacks(array[1,2]::bigint[]) v')).rows[0].v;
    assert.equal(rows.length,1); assert.equal(rows[0].message_text,'new'); assert.equal(rows[0].log_id,2);
    assert.deepEqual((await db.query('select traffic_reminder_latest_callbacks(null) v')).rows[0].v,[]);
    await assert.rejects(db.query('select traffic_reminder_latest_callbacks(array(select generate_series(1,501)::bigint))'),/Too many/);
    assert.deepEqual((await db.query('select traffic_realtime_capabilities() v')).rows[0].v,{version:1});
  } finally { await db.close(); }
});

test('existing-project repair and new-project file 8 carry the canonical migration once', () => {
  assert.equal(fs.readFileSync('supabase/setup/traffic-optimization/realtime-repair.sql','utf8'),source);
  const bundle=fs.readFileSync('errorSTO/template-update-prepared/8 зменьшує вихідний трафік.sql','utf8');
  assert.equal(bundle.split('-- BEGIN REALTIME OPTIMIZATION V1').length,2);
  assert.ok(bundle.includes(source.replace(/^begin;\s*$/m,'').replace(/^commit;\s*$/m,'').trim()));
  const np=fs.readFileSync('supabase/setup/nova-poshta.sql','utf8');
  assert.ok(np.includes('sto_realtime_private.np_rate_buckets'));
  assert.doesNotMatch(np,/set novaposhta=jsonb_set\(cfg,'\{_rate\}'/);
  const {buildDatabaseSQL,buildUpdateSQL}=require('../scripts/prepare-nova-poshta-dashboard.cjs');
  for (const [name,built] of [
    ['9 Нова пошта база.sql','-- NEW STO PROJECT: run after the base STO schema. SQL Editor only.\n'+buildDatabaseSQL()],
    ['9.4 Нова пошта оновити наявну.sql',buildUpdateSQL()]
  ]) {
    assert.equal(fs.readFileSync('errorSTO/template-update-prepared/nova-poshta/'+name,'utf8'),built);
    assert.ok(built.includes('sto_realtime_private.np_rate_buckets'));
    assert.doesNotMatch(built,/set novaposhta=jsonb_set\(cfg,'\{_rate\}'/);
  }
});

test('file 8 realtime section installs before optional Nova Poshta configuration', async () => {
  const db=await fixture();
  try {
    await db.exec('alter table public.settings drop column novaposhta');
    await db.exec(source);
    assert.deepEqual((await db.query('select traffic_realtime_capabilities() v')).rows[0].v,{version:1});
    assert.equal((await db.query("select np_online_rate('without-np-column',3,60) ok")).rows[0].ok,true);
  } finally {await db.close();}
});
