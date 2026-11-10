// Installs the actual combined repair twice against local synthetic tables.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { PGlite } = require(process.env.STO_PGLITE_MODULE || '@electric-sql/pglite');
const migration = name => fs.readFileSync(`supabase/migrations/${name}`, 'utf8');
test('combined accounting repair installs and reapplies without conducting payments', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;
      create table shops(shop_id bigint primary key,data jsonb);
      create table acts(act_id bigint primary key,client_id bigint,cars_id bigint,date_on timestamp,date_off timestamp,rosraxovano timestamp,xto_rozraxuvav text,avans numeric,"tupOplatu" text,data jsonb);
      create table vutratu(vutratu_id bigint primary key,"dataOnn" timestamp,"dataOff" timestamp,kategoria text,act bigint,opys_vytraty text,suma numeric,sposob_oplaty text,prymitky text,xto_zapusav text);
      create table slyusars(slyusar_id bigint primary key,data jsonb);
      create table clients(client_id bigint primary key,data jsonb);create table cars(cars_id bigint primary key,data jsonb);
      create table sclad(sclad_id bigint primary key,time_on timestamp,shops text,rahunok text,akt bigint,name text,part_number text,kilkist_on numeric,kilkist_off numeric,price numeric,rosraxovano date,povernennya timestamp,xto_povernyv text,"scladNomer" integer,xto_zamovuv bigint);
      create function sto_read_object_v1(p jsonb) returns jsonb language sql immutable as $$select case when jsonb_typeof(p)='string' then (p#>>'{}')::jsonb else coalesce(p,'{}') end$$;
      create function traffic_json_object(p jsonb) returns jsonb language sql immutable as $$select sto_read_object_v1(p)$$;
      create function traffic_search_truthy(p jsonb) returns boolean language sql immutable as $$select p is not null and p not in ('null','false','""','0')$$;
      create function traffic_search_number(p jsonb) returns numeric language sql immutable as $$select case when p is null or p='null' then null else (p#>>'{}')::numeric end$$;
      -- Only existence checks use these stubs; payment ledger behavior has its own real SQL suite.
      create function write_payroll_payment_batch(jsonb) returns jsonb language sql as $$select '[]'::jsonb$$;
      create function traffic_payroll_payment_summary(jsonb,jsonb,text,text) returns jsonb language sql as $$select '{}'::jsonb$$;
      insert into acts values(1,null,null,'2026-10-20',null,null,null,0,'Готівка','{"За роботу":100,"Прибуток за роботу":50}');
      insert into shops values(1,'{"Name":"Shop","Історія":{"2026-10-20":[{"Акт":1,"Деталі":[{"recordId":"part-1","Найменування":"Part","Ціна":10,"Кількість":1}]}]}}');
      insert into sclad(sclad_id,time_on,shops,name,kilkist_on,kilkist_off,price) values(1,'2026-10-20','Shop','Part',1,0,10);
      insert into slyusars values(1,'{"Name":"Worker","Історія":{}}');`);
    await db.exec(migration('20261011120000_traffic_shop_report_page.sql'));
    await db.exec(`create function traffic_shop_report_v2(jsonb,integer,integer) returns jsonb language sql as $$select traffic_shop_report_page($1,$2,$3)$$;`);
    await db.exec(migration('20261015154333_traffic_stock_accounting_page.sql'));
    await db.exec(migration('20261015154335_traffic_profit_accounting_page.sql'));
    const snapshot = async () => (await db.query(`select jsonb_build_object(
      'acts',(select jsonb_agg(to_jsonb(a)) from acts a),'shops',(select jsonb_agg(to_jsonb(s)) from shops s),
      'stock',(select jsonb_agg(to_jsonb(s)) from sclad s),'staff',(select jsonb_agg(to_jsonb(s)) from slyusars s)) v`)).rows[0].v;
    const before = await snapshot();
    const repair = fs.readFileSync('supabase/setup/traffic-optimization/accounting-payments-repair.sql', 'utf8');
    await db.exec(repair); await db.exec(repair); assert.deepEqual(await snapshot(), before);
    const filter = JSON.stringify({ from: '2026-10-01', to: '2026-10-21' });
    const shop = (await db.query('select traffic_shop_report_v3($1,0,30) v', [filter])).rows[0].v;
    assert.equal(shop.items.length, 1); assert.deepEqual(shop.shops, []); assert.match(shop.items[0].paymentFingerprint, /^[a-f0-9]{64}$/);
    const profit = (await db.query('select traffic_profit_accounting_page($1) v', [filter])).rows[0].v;
    assert.equal(profit.rows.length, 1); assert.match(profit.rows[0].paymentBaseline, /^[a-f0-9]{32}$/);
    const stock = (await db.query('select traffic_stock_accounting_page($1) v', [filter])).rows[0].v;
    assert.equal(stock.items.length, 1); assert.match(stock.items[0].paymentFingerprint, /^[a-f0-9]{64}$/);
  } finally { await db.close(); }
});
