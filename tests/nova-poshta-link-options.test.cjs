const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {buildDatabaseSQL}=require('../scripts/prepare-nova-poshta-dashboard.cjs');

test('link suggestions search the full archive and permitted acts with client/car labels', {skip:!process.env.NP_VALIDATION_ROOT}, async()=>{
  const {PGlite}=require(path.join(process.env.NP_VALIDATION_ROOT,'node_modules/@electric-sql/pglite'));
  const db=new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table settings(setting_id integer primary key,data boolean,"Запчастист" boolean,"Складовщик" boolean);
      create table slyusars(slyusar_id integer primary key,data jsonb);
      create table clients(client_id bigint primary key,data jsonb);
      create table cars(cars_id bigint primary key,client_id bigint,data jsonb);
      create table acts(act_id bigint primary key,date_off timestamptz,data jsonb,pruimalnyk text,client_id bigint,cars_id bigint,frozen boolean default false);
      insert into slyusars values (1,'{"Name":"Admin","Доступ":"Адміністратор"}'),(2,'{"Name":"Марія","Доступ":"Приймальник"}');
      insert into clients values (1,'{"ПІБ":"Іван Петренко"}'),(2,'{"ПІБ":"Олена Коваль"}');
      insert into cars values (1,1,'{"Авто":"Skoda Octavia","Номер авто":"АВ1234АА"}'),(2,2,'{"Марка":"Ford","Модель":"Focus","Номер авто":"АВ5678ВВ"}');
    `);
    await db.exec(buildDatabaseSQL());
    await db.exec(`
      insert into acts(act_id,date_off,data,pruimalnyk,client_id,cars_id,frozen) values
        (101,null,'{}','Марія',1,1,false),
        (102,null,'{}','Інший приймальник',2,2,false),
        (103,now(),'{}','Марія',1,1,false),
        (104,null,'{"Заморожений":true}','Марія',1,1,false),
        (105,null,'{}','Марія',1,1,true),
        (106,null,'{"ПІБ":"Роман Тестовий","Марка":"Toyota","Модель":"Corolla","Держ. номер":"АА1111АА"}','Марія',null,null,false),
        (107,null,'{}','Марія',null,2,false);
      insert into acts(act_id,data,pruimalnyk) select n,'{}','Марія' from generate_series(2000,2024) n;
      insert into novaposhta(ttn,data,raw_document,history)
        select (20400000000100+n)::text,jsonb_build_object('document_date','2026-10-20','provider_details',jsonb_build_object('created','2026-10-20 12:'||lpad(n::text,2,'0')||':00'),'direction','outgoing','provider_description','Запчастини'),'{"extra":"Full payload"}','[{"old":"History"}]'
        from generate_series(0,24) n;
      insert into novaposhta(ttn,data) values
        ('20400000000999','{"document_date":"2020-01-10","direction":"incoming","provider_description":"Стара посилка"}'),
        ('20400000000888','{}');
    `);
    const query=async(employee=1,kind='all',term='',page=1)=>(await db.query('select np_archive_link_options($1,$2,$3,$4) result',[employee,kind,term,page])).rows[0].result;
    const initial=await query();
    assert.equal(initial.ttns.length,20);assert.equal(initial.acts.length,20);
    assert.equal(initial.ttns_has_more,true);assert.equal(initial.acts_has_more,true);
    assert.equal(initial.ttns[0].ttn,'20400000000124');assert.equal(initial.acts[0].act_id,2024);
    for(const ttn of initial.ttns) assert.deepEqual(Object.keys(ttn).sort(),['description','direction','ttn']);
    const next=await query(1,'all','',2);
    assert.equal(next.ttns_has_more,false);assert.equal(next.acts_has_more,false);
    assert.equal(new Set([...initial.ttns,...next.ttns].map(row=>row.ttn)).size,27);
    assert.equal(new Set([...initial.acts,...next.acts].map(row=>row.act_id)).size,32);
    assert.ok(next.ttns.some(row=>row.ttn==='20400000000999'));
    assert.ok(next.ttns.some(row=>row.ttn==='20400000000888'));
    assert.ok([103,104,105].every(id=>next.acts.some(row=>row.act_id===id)));
    assert.equal((await query(1,'ttn','00999')).ttns[0].description,'Стара посилка');
    assert.equal((await query(1,'ttn','00888')).ttns[0].direction,'unknown');
    assert.deepEqual((await query(1,'ttn')).acts,[]);
    assert.deepEqual((await query(1,'act')).ttns,[]);
    const byName=await query(1,'act','Петренко');
    assert.deepEqual(byName.acts.map(row=>row.act_id),[105,104,103,101]);
    assert.match(byName.acts[0].label,/Заморожений$/);assert.match(byName.acts[2].label,/Закритий$/);
    assert.deepEqual(byName.acts.at(-1),{act_id:101,label:'№101 · Іван Петренко · Skoda Octavia · АВ1234АА'});
    assert.deepEqual((await query(1,'act','П')).acts,byName.acts);
    assert.equal((await query(1,'ttn','2')).ttns.length,20);
    assert.equal((await query(1,'act','skoda')).acts.at(-1).act_id,101);
    assert.equal((await query(1,'act','1234')).acts.at(-1).act_id,101);
    assert.deepEqual((await query(1,'act','101')).acts,[byName.acts.at(-1)]);
    assert.match((await query(1,'act','Тестовий')).acts[0].label,/№106 · Роман Тестовий · Toyota Corolla · АА1111АА/);
    const manager=await query(2,'act','Коваль');
    assert.deepEqual(manager.acts,[{act_id:107,label:'№107 · Олена Коваль · Ford Focus · АВ5678ВВ'}]);
    assert.deepEqual((await query(2,'act','102')).acts,[]);
    assert.deepEqual((await query(999,'act')).acts,[]);
    // Closed and both frozen representations permit only TTN metadata changes.
    for(const actId of [103,104,105]) {
      const before=(await db.query('select to_jsonb(a)-\'novaposhta\' as row from acts a where act_id=$1',[actId])).rows[0].row;
      const linked=(await db.query("select np_online_act(2,$1,'20400000000999') result",[actId])).rows[0].result;
      assert.equal(linked.editable,true);
      assert.ok(linked.items.some(item=>item.ttn==='20400000000999'));
      const after=(await db.query('select to_jsonb(a)-\'novaposhta\' as row from acts a where act_id=$1',[actId])).rows[0].row;
      assert.deepEqual(after,before);
    }
    assert.deepEqual((await db.query("select act_ids from novaposhta where ttn='20400000000999'")).rows[0].act_ids,[103,104,105]);
    assert.equal((await db.query('select np_online_can_act(1,103,true) allowed')).rows[0].allowed,false);
    assert.equal((await db.query('select np_online_can_act(1,104,true) allowed')).rows[0].allowed,false);
    await assert.rejects(db.query("select np_online_act(2,102,'20400000000999')"),/ACT_FORBIDDEN/);
    await db.exec(`insert into slyusars values (3,'{"Name":"Parts","Доступ":"Запчастист"}');insert into settings(setting_id,"Запчастист") values(12,true),(13,true),(22,false);`);
    assert.deepEqual((await query(3,'act')).acts,[]);
    await assert.rejects(db.query("select np_online_act(3,103,'20400000000999')"),/ACT_FORBIDDEN/);
    await db.exec('update settings set "Запчастист"=true where setting_id=22');
    assert.equal((await query(3,'act','103')).acts[0].act_id,103);
    assert.deepEqual((await query(1,'act',"%' OR 1=1 --")).acts,[]);
    assert.deepEqual((await query(1,'ttn','777777')).ttns,[]);
    for(const params of [[1,'bad','',1],[1,'ttn','abc',1],[1,'act','a'.repeat(121),1],[1,'all','',0]]) {
      await assert.rejects(query(...params),/INVALID_OPTIONS_QUERY/);
    }
    await db.exec('set role authenticated');
    await assert.rejects(query(),/permission denied/);
    await db.exec('reset role;set role service_role');
    assert.equal((await query(2,'act','Коваль')).acts[0].act_id,107);
  } finally {await db.close();}
});
