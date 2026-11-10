// Optional local SQL verification. STO_PGLITE_MODULE points to an isolated PGlite installation.
// Never connects to Supabase or uses project credentials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.STO_PGLITE_MODULE || '@electric-sql/pglite');
const ts = require('typescript');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const coreModule = new Module(path.join(root, 'export-core-test.cjs'));
coreModule.filename = path.join(root, 'export-core-test.cjs');
coreModule._compile(ts.transpileModule(fs.readFileSync(path.join(root,
  'src/ts/roboha/nalachtuvannay/export/core.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, coreModule.filename);

test('traffic SQL: syntax, pages, projection safety, hashes and RLS', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.clients(client_id bigint primary key, data jsonb);
      create table public.cars(cars_id bigint primary key, client_id bigint, data jsonb, is_deleted boolean);
      create table public.acts(act_id bigint primary key, client_id bigint, cars_id bigint,
        date_on timestamptz, date_off timestamptz, pruimalnyk text, "slusarsOn" boolean,
        rosraxovano text, data jsonb);
      create table public.details(detail_id bigint primary key, data jsonb);
      create table public.works(work_id bigint primary key, data jsonb);
      create table public.shops(shop_id bigint primary key, data jsonb);
      create table public.slyusars(slyusar_id bigint primary key, data jsonb);
      create table public.sclad(sclad_id bigint primary key, name text, part_number text, prumitka text, shops text, time_on timestamptz, kilkist_on numeric,kilkist_off numeric default 0,price numeric,"scladNomer" text,rahunok text,akt bigint,unit_measurement text,statys text,xto_zamovuv bigint,client_price numeric);
    `);
    const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
      .filter(name => name.includes('_traffic_')).sort();
    for (let pass = 0; pass < 2; pass++) for (const file of migrations) {
      await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'));
    }
    const installSql = fs.readFileSync(path.join(root,
      'supabase/setup/traffic-optimization/install.sql'), 'utf8');
    for (const file of migrations) {
      const expected = fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8')
        .replace(/^begin;\s*$/gm,'').replace(/^commit;\s*$/gm,'');
      assert.ok(installSql.includes(expected), `Regenerate traffic install.sql after changing ${file}`);
    }
    await db.exec(installSql);
    await db.exec(`
      insert into clients values (1, '{"ПІБ":"Тестовий Клієнт","Телефон":"0500000000"}');
      insert into cars select n, 1, jsonb_build_object('Авто','Тест авто','Номер авто',n::text), false from generate_series(1,25) n;
      insert into acts select n, 1, 1, '2026-10-01T12:00:00Z', null, 'Приймальник', false, null,
        jsonb_build_object('Загальна сума',100,'Заморожений',false,'__large_private_history', repeat('X',10000),
          'Роботи',jsonb_build_array(jsonb_build_object('Робота','Тест робота','Слюсар','Майстер','Ціна',100)),
          'Деталі','[]'::jsonb) from generate_series(1,205) n;
    `);
    const scalar = async (sql, args=[]) => (await db.query(sql,args)).rows[0].v;
    await db.exec("insert into slyusars values(99999,jsonb_build_object('Name','Directory Test','ПроцентРоботи',30,'Пароль','secret','Історія',jsonb_build_object('large',repeat('X',10000))))");
    const directory=await scalar('select traffic_payroll_directory(null) v');
    assert.equal(directory.items[0].data.Name,'Directory Test');
    assert.equal(directory.items[0].data.Пароль,undefined);assert.equal(directory.items[0].data.Історія,undefined);
    assert.equal(directory.pending_count,0);
    await db.exec('delete from slyusars where slyusar_id=99999');
    const dashboardOriginal={Роботи:[{Ціна:'10.5',Кількість:0},{Ціна:-2,Кількість:'0'},{Ціна:0.1,Кількість:3}],Деталі:[{Ціна:5,Кількість:-1}],ПІБ:'Тест'};
    const dashboardCompact=await scalar('select traffic_dashboard_data_v2($1::jsonb) v',[JSON.stringify(dashboardOriginal)]);
    assert.equal(dashboardCompact.Роботи,undefined);
    assert.equal(dashboardCompact.Деталі,undefined);
    assert.equal(dashboardCompact.__dashboard_totals.works,dashboardOriginal.Роботи.reduce((sum,w)=>sum+Number(w.Ціна||0)*Number(w.Кількість||1),0));
    assert.equal(dashboardCompact.__dashboard_totals.details,-5);
    assert.equal(dashboardCompact.__dashboard_totals.worksCount,3);
    const malformedDashboard=await scalar('select traffic_dashboard_data_v2($1::jsonb) v',[JSON.stringify({Роботи:[{Ціна:'invalid'}]})]);
    assert.equal(malformedDashboard.__dashboard_totals,undefined);
    assert.equal(malformedDashboard.Роботи[0].Ціна,'invalid');

    await db.exec("insert into shops values (9000, jsonb_build_object('Name','Test','Історія',jsonb_build_object('d',jsonb_build_array(jsonb_build_object('Акт',1,'Деталі',jsonb_build_array(jsonb_build_object('Ціна',25))))),'Склад',repeat('X',10000),'secret','hidden'))");
    const shopReport=await scalar('select traffic_shop_report(null) v');
    assert.equal(shopReport.items[0].data.Name,'Test');
    assert.equal(shopReport.items[0].data.Історія.d[0].Деталі[0].Ціна,25);
    assert.equal(shopReport.items[0].data.Склад,undefined);
    assert.equal(shopReport.items[0].data.secret,undefined);
    await db.exec('delete from shops where shop_id=9000');

    const profitPage = await scalar("select traffic_profit_acts('open','2026-10-01','2026-10-02',0) v");
    assert.equal(profitPage.items.length,200);
    assert.equal(profitPage.has_more,true);
    assert.equal(profitPage.items[0].act_id,205);
    assert.equal(profitPage.items[0].data.__large_private_history,undefined);
    assert.equal(profitPage.items[0].data.Роботи,undefined);
    assert.equal(profitPage.items[0].data.Заморожений,false);
    const profitTail = await scalar("select traffic_profit_acts('open','2026-10-01','2026-10-02',200) v");
    assert.equal(profitTail.items.length,5);
    assert.equal(profitTail.has_more,false);
    assert.equal((await scalar("select traffic_profit_acts('open','2026-10-02',null,0) v")).items.length,0);
    assert.equal((await scalar("select traffic_profit_acts('close','2026-10-01',null,0) v")).items.length,0);
    await db.exec("update acts set rosraxovano='2026-10-02',date_off='2026-10-02' where act_id=1");
    assert.equal((await scalar("select traffic_profit_acts('paid','2026-10-02','2026-10-02',0) v")).items.length,1);
    assert.equal((await scalar("select traffic_profit_acts('close','2026-10-02','2026-10-02',0) v")).items.length,1);
    await db.exec('update acts set rosraxovano=null,date_off=null where act_id=1');
    await assert.rejects(scalar("select traffic_profit_acts('invalid',null,null,0) v"));
    const profitBody={'Прибуток за деталі':'-25.55','Прибуток за роботу':0,'За деталі':'150.5','За роботу':40,'Знижка':5,'Заморожений':true};
    await db.query('insert into acts(act_id,date_on,data) values (9001,$1,$2)', ['2026-10-03',JSON.stringify(JSON.stringify({...profitBody,Роботи:[{Ціна:999}],private:'hidden'}))]);
    const legacyProfit=await scalar("select traffic_profit_acts('open','2026-10-03',null,0) v");
    assert.deepEqual(legacyProfit.items[0].data,profitBody);
    await db.exec('delete from acts where act_id=9001');


    await db.query('insert into slyusars(slyusar_id,data) values (9000,$1::jsonb)',[JSON.stringify({Доступ:'Приймальник',secret:'hidden',Історія:{'2026-01-01':[{Акт:'001',ЗарплатаРоботи:10,Записи:[{secret:'large'}]},{Акт:999,ЗарплатаРоботи:20}]}})]);
    const receiverRows=await scalar('select traffic_receipter_salaries($1) v',[[1]]);
    assert.equal(receiverRows.length,1);assert.equal(receiverRows[0].ЗарплатаРоботи,10);assert.equal(receiverRows[0].Записи,undefined);
    assert.deepEqual(await scalar('select traffic_receipter_salaries($1) v',[[]]),[]);
    await assert.rejects(scalar('select traffic_receipter_salaries($1) v',[Array.from({length:201},(_,i)=>i+1)]));
    await db.exec('delete from slyusars where slyusar_id=9000');

    const valuesOnly=await scalar("select traffic_client_form_options('carModelEdit','',null,null) v");
    assert.equal(valuesOnly.items.length,1);assert.equal(valuesOnly.has_more,false);
    assert.equal((await scalar("select traffic_client_form_options('carModelEdit','',$1,null) v",[Number(valuesOnly.items[0].id)])).items.length,0);
    assert.equal((await scalar("select traffic_client_form_options('carModel','',null,null) v")).items.length,20);

    let staffOriginal={Name:'Майстер',Доступ:'Слюсар',secret:'private',Історія:{'2026-10-01':[
      {СуммаРоботи:100,private:'large'.repeat(500),Записи:[{Зарплата:0,Робота:'large'},{Зарплата:25},{Зарплата:-5}]},
      {СуммаРоботи:'12',Записи:[]}],'2026-09-01':[{СуммаРоботи:50,Записи:[{Зарплата:'5'}]}]}};
    staffOriginal=await scalar('select $1::jsonb v',[JSON.stringify(staffOriginal)]);
    const staffCompact=await scalar('select traffic_analytics_staff_data($1::jsonb) v',[JSON.stringify(staffOriginal)]);
    assert.equal(staffCompact.secret,undefined);assert.equal(staffCompact.Історія['2026-10-01'][0].private,undefined);
    const analyticsSource=fs.readFileSync(path.join(root,'src/ts/roboha/bukhhalteriya/analityka.ts'),'utf8');
    const fn=analyticsSource.slice(analyticsSource.indexOf('function calcMechanicStats()'),analyticsSource.indexOf('/** Аномалії */'));
    const calculate=(data,from)=>{const api={};require('node:vm').runInNewContext(ts.transpileModule('export '+fn,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
      {exports:api,cachedDashboard:null,cachedSlyusars:[{slyusar_id:1,data}],filterDateFrom:from,filterDateTo:null});return JSON.stringify(api.calcMechanicStats());};
    assert.equal(calculate(staffCompact,null),calculate(staffOriginal,null));
    assert.equal(calculate(staffCompact,new Date('2026-10-01')),calculate(staffOriginal,new Date('2026-10-01')));

    for (const text of ['ÅB-12','ＡＢ 12','Ї-1','é ½','', 'ІН-22']) {
      assert.equal(await scalar('select traffic_editor_catalog_key($1) v',[text]),
        text.normalize('NFKD').toLocaleLowerCase('uk-UA').replace(/[^\p{L}\p{N}]+/gu,''));
    }
    await db.exec("insert into sclad(sclad_id,part_number) values (9001,'ÅB-12'),(9002,'AB12')");
    assert.equal(Number(await scalar('select traffic_editor_catalog_id($1) v',['AB12'])),9001);
    assert.equal(await scalar('select traffic_editor_catalog_id($1) v',['missing']),null);
    assert.deepEqual(await scalar('select traffic_editor_name_ids($1) v',['AB12']),[9002]);
    assert.deepEqual(await scalar('select traffic_editor_name_ids($1) v',['%']),[]);
    await db.exec('delete from sclad where sclad_id in (9001,9002)');
    await db.exec("insert into sclad(sclad_id,name) select n,'Needle' from generate_series(9000,9054) n");
    const named = await scalar('select traffic_editor_name_ids($1) v',['needle']);
    assert.equal(named.length,50);assert.equal(named[0],9000);assert.equal(named[49],9049);

    const stockSearch=await scalar('select traffic_editor_stock_search($1,false,null) v',['Needle']);
    assert.equal(stockSearch.ids.length,50);assert.equal(stockSearch.has_more,true);
    const editorStockNext=await scalar('select traffic_editor_stock_search($1,false,$2) v',['Needle',stockSearch.next_cursor]);
    assert.equal(editorStockNext.ids.length,5);assert.equal(editorStockNext.has_more,false);
    await db.exec("update sclad set name='Гайка   колеса',part_number='ÅB-12' where sclad_id=9000");
    assert.deepEqual((await scalar('select traffic_editor_stock_search($1,true,null) v',['колеса гайка'])).ids,[9000]);
    assert.deepEqual((await scalar('select traffic_editor_stock_search($1,false,null) v',['ab12'])).ids,[9000]);
    await db.exec('delete from sclad where sclad_id >= 9000');

    await db.exec(`insert into sclad(sclad_id,shops)
      select n,'Supplier '||n from generate_series(1,501) n;
      insert into sclad(sclad_id,shops) values (502,'Supplier 1'),(503,''),(504,null),(505,' Legacy name ');`);
    const suppliers = await scalar('select traffic_stock_shop_names(0) v');
    const moreSuppliers = await scalar('select traffic_stock_shop_names(500) v');
    assert.equal(suppliers.items.length,500); assert.equal(suppliers.has_more,true);
    assert.equal(moreSuppliers.items.length,2); assert.equal(moreSuppliers.has_more,false);
    const names = [...suppliers.items,...moreSuppliers.items].map(row=>row.shops);
    assert.equal(new Set(names).size,502);
    assert.ok(names.includes(' Legacy name '));
    const dash=await scalar("select traffic_dashboard_page('2026-10-01T00:00:00Z','2026-10-02T00:00:00Z',null) v");
    assert.equal(dash.items.length,100);assert.equal(dash.has_more,true);
    assert.equal(dash.items[0].data.__large_private_history,undefined);assert.equal(dash.items[0].data.Роботи[0].Робота,undefined);
    assert.equal(dash.items[0].data.Роботи[0].Ціна,100);assert.equal(dash.items[0].__client_data.ПІБ,'Тестовий Клієнт');
    const dashNext=await scalar("select traffic_dashboard_page('2026-10-01T00:00:00Z','2026-10-02T00:00:00Z',$1) v",[dash.next_cursor]);
    assert.equal(dashNext.items.length,100);assert.ok(dashNext.items.every(row=>row.act_id<dash.next_cursor));
    const offline = await scalar("select traffic_offline_page('acts',null,null) v");
    assert.equal(offline.items.length,200);assert.equal(offline.has_more,false);
    assert.ok(offline.items[0].data.__large_private_history);
    const sameOffline=await scalar("select traffic_offline_page('acts',null,$1) v",[offline.hash]);
    assert.equal(sameOffline.items,null);assert.equal(sameOffline.hash,offline.hash);assert.equal(sameOffline.count,200);
    await db.exec("update acts set data=data||'{\"new_field\":true}'::jsonb where act_id=205");
    const newOffline=await scalar("select traffic_offline_page('acts',null,$1) v",[offline.hash]);
    assert.equal(newOffline.items.length,200);assert.notEqual(newOffline.hash,offline.hash);
    await assert.rejects(()=>scalar("select traffic_offline_page('pg_authid',null,null) v"));
    const historyPage = await scalar('select traffic_service_history(1,null,false) v');
    assert.equal(historyPage.items.length,50);assert.equal(historyPage.has_more,true);
    assert.equal(historyPage.items[0].data.__large_private_history,undefined);
    assert.equal(historyPage.items[0].data.Роботи[0].Робота,'Тест робота');
    const historyNext = await scalar('select traffic_service_history(1,$1::jsonb,false) v',[JSON.stringify(historyPage.next_cursor)]);
    assert.equal(historyNext.items.length,50);assert.ok(historyNext.items.every(x=>x.act_id<historyPage.next_cursor.act_id));
    const historySummary = await scalar('select traffic_service_history(1,null,true) v');
    assert.equal(historySummary.items.length,200);assert.equal(historySummary.has_more,true);
    assert.equal(historySummary.items[0].data.Роботи[0].Робота,undefined);
    assert.equal(historySummary.items[0].data.Роботи[0].Ціна,100);
    const summaryNext = await scalar('select traffic_service_history(1,$1::jsonb,true) v',[JSON.stringify(historySummary.next_cursor)]);
    assert.equal(summaryNext.items.length,5);assert.equal(summaryNext.has_more,false);
    const operands = {Роботи:[{Кількість:0,Ціна:1},{Робота:'Без ціни'}],Деталі:[{Кількість:2,Ціна:12.5}],Пробіг:'1234', 'За роботу':0,'За деталі':null};
    const operandsProjection = await scalar('select traffic_service_history_data($1::jsonb,true) v',[JSON.stringify(operands)]);
    const total = data => (data['За роботу'] || data.Роботи.reduce((sum,w)=>sum+(w.Кількість||1)*(w.Ціна||0),0)) +
      (data['За деталі'] || data.Деталі.reduce((sum,w)=>sum+(w.Кількість||1)*(w.Ціна||0),0));
    assert.equal(total(operandsProjection),total(operands));
    assert.deepEqual(operandsProjection.Роботи[1],{});
    const clientsPage = await scalar("select traffic_client_form_options('client','тест',null,null) v");
    assert.equal(clientsPage.items.length,1); assert.equal(clientsPage.items[0].id,'1');
    const carsPage = await scalar("select traffic_client_form_options('carModel','авто',null,null) v");
    assert.equal(carsPage.items.length,20);assert.equal(carsPage.has_more,true);
    assert.equal(carsPage.items[0].data,undefined);
    const carsNext = await scalar("select traffic_client_form_options('carModel','авто',$1,null) v",[carsPage.next_cursor]);
    assert.equal(carsNext.items.length,5);assert.equal(carsNext.has_more,false);
    assert.equal((await scalar("select traffic_client_form_options('carModel','авто',null,999) v")).items.length,0);
    for (const text of ['AB-12.3','АБ 12.3','ＡＢ１２','Café-é','A/Ø#1','Ⅳ-²']) {
      const key=text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
      assert.equal(await scalar('select traffic_catalog_key($1) v',[text]),key);
    }
    await db.exec("update sclad set statys='Замовити',part_number='AB-12.3',time_on='2026-10-01T00:00:00Z'");
    const stockPage=await scalar("select traffic_stock_page('Замовити','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','AB123',null) v");
    assert.equal(stockPage.items.length,50);assert.equal(stockPage.has_more,true);
    const stockNext=await scalar("select traffic_stock_page('Замовити',null,null,'AB123',$1) v",[stockPage.next_cursor]);
    assert.equal(stockNext.items.length,50);assert.ok(stockNext.items.every(x=>x.sclad_id<stockPage.next_cursor));
    assert.equal((await scalar("select traffic_stock_page('Замовити',null,null,'MISSING',null) v")).items.length,0);
    await db.exec('alter table sclad add column data jsonb');
    await db.query('update sclad set price=42,data=$1::jsonb where sclad_id=1',[JSON.stringify({price:5,xto_zamovuv:2,privateHistory:'X'.repeat(2000)})]);
    await db.query('update sclad set data=$1::jsonb where sclad_id=2',[JSON.stringify(JSON.stringify({price:17,scladNomer:3,privateHistory:'hidden'}))]);
    const costs=await scalar('select traffic_stock_costs(array[1,2,999999]::bigint[]) v');
    assert.equal(costs.length,2);assert.equal(costs[0].price,42);assert.equal(costs[0].data.price,5);
    assert.equal(costs[0].data.privateHistory,undefined);assert.equal(JSON.parse(costs[1].data).price,17);
    assert.equal(JSON.parse(costs[1].data).privateHistory,undefined);
    const page = await scalar('select sto_service_book_search_v1($1,null) v',['клієнт']);
    assert.equal(page.items.length,20); assert.equal(page.has_more,true);
    const next = await scalar('select sto_service_book_search_v1($1,$2) v',['клієнт',page.next_cursor]);
    assert.equal(next.items.length,5); assert.equal(next.has_more,false);
    assert.deepEqual(await scalar(`select sto_read_object_v1(to_jsonb('bad json'::text)) v`), {});
    for (const value of [null, '', false, 0]) {
      assert.equal(await scalar('select sto_act_list_data_v1($1::jsonb) v',
        [JSON.stringify(value)]), value);
    }
    const history = {
      '2026-10-01': [
        {Акт:'1', Записи:[{recordId:'first',Зарплата:12},{recordId:'second',Зарплата:34}]},
        {Акт:'2', Записи:[{recordId:'other',Зарплата:99}]},
        {Акт:1, Записи:[{recordId:'third',Зарплата:56}]},
      ],
      '2026-10-02': [{Акт:'1',Записи:[{recordId:'last',Зарплата:78}]}],
      '2026-09-01': [{Акт:'2',Записи:[{recordId:'older'}]}],
      malformed: 'not an array',
    };
    await db.query('insert into slyusars values (1,$1::jsonb)',
      [JSON.stringify({Name:'Майстер',Доступ:'Слюсар',ПроцентРоботи:40,Історія:history})]);
    const staff = await scalar('select traffic_act_staff(1,null) v');
    const staffData = staff.items[0].data;
    assert.equal(staffData.Name,'Майстер');
    assert.equal(staffData.ПроцентРоботи,40);
    assert.deepEqual(staffData.Історія, {
      '2026-10-01':[history['2026-10-01'][0],history['2026-10-01'][2]],
      '2026-10-02':history['2026-10-02'],
    });
    const newActStaff = await scalar('select traffic_act_staff(null,null) v');
    assert.deepEqual(newActStaff.items[0].data.Історія,{});
    const acts = await scalar(`select sto_act_list_page_v1(null,null,'open',null) v`);
    assert.equal(acts.items.length,200); assert.equal(acts.has_more,true);
    assert.equal(acts.items[0].__sto_projection,'act-list-v1');
    assert.equal(acts.items[0].data.__large_private_history,undefined);
    assert.equal(acts.items[0].data.Роботи[0].Робота,'Тест робота');
    assert.equal(acts.items[0].data.Роботи[0].Ціна,undefined);
    const older = await scalar(`select sto_act_list_page_v1(null,null,'open',$1) v`,[acts.next_cursor]);
    assert.equal(older.items.length,5); assert.equal(older.has_more,false);
    const attention = await scalar('select sto_act_attention_page_v1(null,null) v');
    assert.equal(attention.items[0].data.Роботи[0].Ціна,100);
    assert.equal(attention.items[0].data.__large_private_history,undefined);

    await db.exec(`update acts set data = data || jsonb_build_object(
      'За роботу',125,'За деталі',275,'Заморожений',true) where act_id=1`);
    const analytics = await scalar('select traffic_analytics_acts(null) v');
    assert.equal(analytics.items.length,200);
    assert.equal(analytics.has_more,true);
    assert.equal(analytics.items[0].data['За роботу'],125);
    assert.equal(analytics.items[0].data['За деталі'],275);
    assert.equal(analytics.items[0].data['Заморожений'],true);
    assert.equal(analytics.items[0].data.Роботи[0].Ціна,100);
    assert.equal(analytics.items[0].data.__large_private_history,undefined);
    assert.equal(analytics.items[0].__sto_projection,'analytics-v1');
    const analyticsNext = await scalar('select traffic_analytics_acts($1) v',[analytics.next_cursor]);
    assert.equal(analyticsNext.items.length,5);
    assert.equal(analyticsNext.has_more,false);

    let fullPages = 0, hashPages = 0, closed = false, aborted = false, text = '';
    const reader = async (table, offset, limit, hashOnly) => {
      hashOnly ? hashPages++ : fullPages++;
      return scalar('select traffic_export_page($1,$2,$3,$4,$5) v',
        [table.name,table.keys,offset,limit,hashOnly]);
    };
    const target = { open: async () => ({ write: async chunk => { text += chunk; },
      close: async () => { closed = true; }, abort: async () => { aborted = true; } }) };
    const readLegacy = async () => { throw new Error('Unexpected full legacy read'); };
    const exported = await coreModule.exports.exportTable({name:'acts',keys:['act_id']},
      readLegacy,target,new AbortController().signal,()=>{},reader);
    assert.equal(exported.rows,205); assert.equal(exported.verification,'server-sha256');
    assert.equal(fullPages,1); assert.equal(hashPages,2); assert.equal(closed,true);
    assert.equal(JSON.parse(text).length,205);
    const original = await reader({name:'acts',keys:['act_id']},0,250,false);
    const checked = await reader({name:'acts',keys:['act_id']},0,250,true);
    assert.equal(checked.payload,null); assert.equal(checked.hash,original.hash);
    await db.exec(`update acts set data = data || '{"Загальна сума":101}' where act_id=1`);
    const changed = await reader({name:'acts',keys:['act_id']},0,250,true);
    assert.equal(changed.total,original.total); assert.notEqual(changed.hash,original.hash);
    closed = false; aborted = false; let verificationCalls = 0;
    await assert.rejects(() => coreModule.exports.exportTable({name:'acts',keys:['act_id']},
      readLegacy,target,new AbortController().signal,()=>{}, async (...args) => {
        if (args[3] && ++verificationCalls === 2) await db.exec(`update acts set data = data || '{"Загальна сума":102}' where act_id=1`);
        return reader(...args);
      }), /Дані змінилися/);
    assert.equal(aborted,true); assert.equal(closed,false);
    await assert.rejects(() => scalar(`select traffic_export_page('pg_authid',array['oid'],0,250,false) v`));

    // Functions must never turn a permission failure into access to the full table.
    await db.exec('set role authenticated');
    await assert.rejects(() => scalar(`select sto_act_list_page_v1(null,null,'open',null) v`));
    await db.exec(`reset role; grant usage on schema public to authenticated;
      grant select on acts to authenticated; alter table acts enable row level security;
      create policy fixture_rows on acts for select to authenticated using (act_id <= 3);
      set role authenticated;`);
    const restricted = await scalar(`select sto_act_list_page_v1(null,null,'open',null) v`);
    assert.equal(restricted.items.length,3);
    const restrictedOffline=await scalar("select traffic_offline_page('acts',null,null) v");
    assert.equal(restrictedOffline.items.length,2);
    assert.ok(restrictedOffline.items.every(row=>row.act_id<=3 && row.data.Заморожений!==true));
    const restrictedExport = await reader({name:'acts',keys:['act_id']},0,250,true);
    assert.equal(restrictedExport.total,3);
    await db.exec('reset role');
  } finally { await db.close(); }
});

