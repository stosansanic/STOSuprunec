// Synthetic PostgreSQL/WASM fixture. Does not connect to a project or read secrets.
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.STO_PGLITE_MODULE || '@electric-sql/pglite');

const migrationDirectory = path.resolve(__dirname, '../supabase/migrations');
const readMigration = name => fs.readFileSync(path.join(migrationDirectory, name), 'utf8');
function financialMigration() {
  const name = fs.readdirSync(migrationDirectory).filter(name => /^\d+_financial_overview\.sql$/.test(name)).sort().at(-1);
  if (!name) throw new Error('The financial_overview migration must exist before running this suite.');
  return readMigration(name);
}

async function createFixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as
      $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create table acts(act_id integer primary key,date_on timestamp,date_off timestamp,
      rosraxovano timestamp,xto_rozraxuvav text,avans numeric,"tupOplatu" text,
      pruimalnyk text,client_id integer,cars_id integer,data jsonb);
    create table slyusars(slyusar_id bigint primary key,data jsonb);
    create table clients(client_id integer primary key,data jsonb);
    create table cars(cars_id integer primary key,data jsonb,is_deleted boolean default false);
    create table sclad(sclad_id bigint primary key,time_on timestamp,shops text,rahunok text,
      akt bigint,name text,part_number text,kilkist_on numeric,kilkist_off numeric,price numeric,
      rosraxovano date,povernennya timestamp,xto_povernyv text,"scladNomer" integer,
      xto_zamovuv bigint,data jsonb);
    create table vutratu(vutratu_id bigint primary key,"dataOnn" timestamp,"dataOff" timestamp,
      kategoria text,act bigint,opys_vytraty text,suma numeric,sposob_oplaty text,
      prymitky text,xto_zapusav text);
    create table shops(shop_id bigint primary key,data jsonb);
    create schema sto_payroll_private;
    create table sto_payroll_private.act_freeze_state(act_id integer primary key,
      archived_at timestamptz,revision text,stock_allocations jsonb);
    create table sto_payroll_private.act_freeze_payroll(act_id integer,employee_id bigint,
      fragments jsonb,primary key(act_id,employee_id));
    create function public.sto_read_object_v1(p_data jsonb) returns jsonb
      language plpgsql immutable security invoker as $$begin
      if jsonb_typeof(p_data)='string' then return (p_data#>>'{}')::jsonb; end if;
      return case when jsonb_typeof(p_data)='object' then p_data else '{}'::jsonb end;
      exception when invalid_text_representation then return '{}'::jsonb; end$$;
    create function public.traffic_resource_revision(text[]) returns text
      language sql stable security invoker as $$select 'fixture-revision'::text$$;
    grant usage on schema public,auth,sto_payroll_private to authenticated;
    grant select on all tables in schema public,sto_payroll_private to authenticated;
  `);
  const payments = readMigration('20261020061759_traffic_payroll_payments.sql');
  // Install real payment parsing/summary helpers, without the unrelated full report.
  await db.exec(payments.slice(0, payments.indexOf('create or replace function public.traffic_payroll_validate')) + '\ncommit;');
  await db.exec(financialMigration());
  return db;
}

async function resetFixture(db) {
  await db.exec(`reset role;
    truncate acts,slyusars,clients,cars,sclad,vutratu,shops,
      sto_payroll_private.act_freeze_payroll,sto_payroll_private.act_freeze_state;`);
}

async function addAct(db, id, options = {}) {
  const { work = 0, parts = 0, discount = 0, frozen = false,
    opened = '2026-10-10 10:00:00', closed = '2026-10-10 12:00:00', paid = null,
    advance = 0, paymentMethod = 'Готівка', body = {} } = options;
  await db.query(`insert into acts(act_id,date_on,date_off,rosraxovano,avans,"tupOplatu",data)
    values($1,$2,$3,$4,$5,$6,$7)`, [id,opened,closed,paid,advance,paymentMethod,JSON.stringify({
      'За роботу': work, 'За деталі': parts, Знижка: discount, Заморожений: frozen,
      Роботи: [], Деталі: [], ...body,
    })]);
}

async function addEmployee(db, id, name, role, entries, day = '2026-10-10') {
  await db.query('insert into slyusars values($1,$2)', [id,JSON.stringify({
    Name:name, Доступ:role, Телефон:'PRIVATE-PROFILE', Історія:{[day]:entries},
  })]);
}

async function addExpense(db,id,amount,category='Оренда',options={}) {
  const {date='2026-10-10',paid=null,act=null,method='Готівка'}=options;
  await db.query(`insert into vutratu(vutratu_id,"dataOnn","dataOff",suma,kategoria,act,sposob_oplaty)
    values($1,$2,$3,$4,$5,$6,$7)`,[id,date,paid,-amount,category,act,method]);
}

async function addStock(db,id,options={}) {
  const {price=200,quantity=2,used=1,date='2026-10-10',paid=null,returned=null,data=null}=options;
  await db.query(`insert into sclad(sclad_id,time_on,shops,name,kilkist_on,kilkist_off,price,rosraxovano,povernennya,data)
    values($1,$2,'Fixture shop','Fixture part',$3,$4,$5,$6,$7,$8)`,
    [id,date,quantity,used,price,paid,returned,data ? JSON.stringify(data):null]);
}

module.exports={createFixture,resetFixture,financialMigration,addAct,addEmployee,addExpense,addStock};
