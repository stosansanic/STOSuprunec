const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const path=require('path');
test('archive retains full payload/history, merges incomplete data and stores only TTNs in acts and act numbers in the archive',{skip:!process.env.NP_VALIDATION_ROOT},async()=>{
 const {PGlite}=require(path.join(process.env.NP_VALIDATION_ROOT,'node_modules/@electric-sql/pglite'));const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create table settings(setting_id integer primary key,data boolean,"Запчастист" boolean,"Складовщик" boolean);create table slyusars(slyusar_id integer primary key,data jsonb);create table acts(act_id bigint primary key,date_off timestamptz,data jsonb,pruimalnyk text);insert into slyusars values(1,'{"Name":"Admin","Доступ":"Адміністратор"}');insert into acts values(1,null,'{}','Admin');`);
 const setup=require('../scripts/prepare-nova-poshta-dashboard.cjs').buildDatabaseSQL();await db.exec(setup);await db.exec(setup);
 const update=require('../scripts/prepare-nova-poshta-dashboard.cjs').buildUpdateSQL();
 assert.doesNotMatch(update,/create\s+(table|database)/i);await db.exec(update);
 const save=(ttn,data,raw,source='document')=>db.query('select np_archive_save($1,$2,$3,$4)',[ttn,JSON.stringify(data),JSON.stringify(raw),source]);
 await save('20400000000001',{provider_details:{sender:'Sender',value:500},state:'transit'},{ExtraField:{nested:123}});
 await save('20400000000002',{state:'created'},{Number:'20400000000002'});
 await db.exec(`select np_online_act(1,1,'20400000000001');select np_online_act(1,1,'20400000000002');select np_online_act(1,1,'20400000000001');`);
 await save('20400000000001',{state:'arrived',provider_details:{sender:'',value:null}},{StatusCode:'7'},'tracking');
 await save('20400000000001',{state:'arrived'},{StatusCode:'7'},'tracking');
 let row=(await db.query("select * from novaposhta where ttn='20400000000001'")).rows[0];assert.equal(row.history.length,2);assert.equal(row.data.provider_details.sender,'Sender');assert.equal(row.raw_document.ExtraField.nested,123);
 const act=(await db.query('select novaposhta from acts where act_id=1')).rows[0].novaposhta;assert.equal(act.length,2);assert.deepEqual(act,['20400000000001','20400000000002']);assert.deepEqual(row.act_ids,[1]);
 await save('20400000000001',{state:'arrived',provider_details:{value:600}},{StatusCode:'7',Cost:600},'tracking');
 row=(await db.query("select * from novaposhta where ttn='20400000000001'")).rows[0];
 assert.deepEqual(row.history.at(-1).changes,{Cost:600});
 assert.deepEqual(row.history.at(-1).data_changes,{provider_details:{value:600}});
 assert.equal(row.data.state,'arrived');assert.equal(row.data.provider_details.sender,'Sender');
 const changedAct=(await db.query('select novaposhta from acts where act_id=1')).rows[0].novaposhta;
 assert.deepEqual(changedAct,act);
 await save('20400000000001',{state:'arrived',provider_details:{value:600}},{StatusCode:'7',Cost:600},'tracking');
 assert.deepEqual((await db.query("select * from novaposhta where ttn='20400000000001'")).rows[0],row);
 const compact=(await db.query('select np_archive_act_read(1,1) as result')).rows[0].result;
 assert.equal(compact.items[0].shipment.provider_details.value,600);
 assert.ok(!('history' in compact.items[0].shipment));assert.ok(!('raw_document' in compact.items[0].shipment));
 const full=(await db.query("select np_archive_act_read(1,1,'20400000000001',true) as result")).rows[0].result;
 assert.deepEqual(full.history,row.history);assert.equal(full.raw_document.ExtraField.nested,123);
 await assert.rejects(db.query("select np_archive_act_read(1,1,'20400000000999',true)"),/ACT_FORBIDDEN/);
 await assert.rejects(db.query('select np_archive_act_read(999,1)'),/ACT_FORBIDDEN/);
 const entries=[{ttn:'20400000000003',data:{state:'created'},raw:{Number:'20400000000003'},source:'document'}];
 await db.query('select np_archive_save_batch($1)',[JSON.stringify(entries)]);
 const batchBefore=(await db.query("select * from novaposhta where ttn='20400000000003'")).rows[0];
 await db.query('select np_archive_save_batch($1)',[JSON.stringify(entries)]);
 assert.deepEqual((await db.query("select * from novaposhta where ttn='20400000000003'")).rows[0],batchBefore);
 await db.exec(`select np_online_act(1,1,'20400000000001',true)`);assert.equal((await db.query('select count(*)::int n from novaposhta')).rows[0].n,3);
 assert.deepEqual((await db.query("select act_ids from novaposhta where ttn='20400000000001'")).rows[0].act_ids,[]);
 await db.exec('set role authenticated');await assert.rejects(db.query('select * from novaposhta'),/permission denied/);await db.exec('reset role');
 await db.exec("select np_online_act(1,1,'20400000000004',false,'Ручна ТТН','incoming')");
 const manual=(await db.query("select data from novaposhta where ttn='20400000000004'")).rows[0].data;
 assert.equal(manual.ttn,'20400000000004');
 const manualAct=(await db.query('select novaposhta from acts where act_id=1')).rows[0].novaposhta;
 assert.ok(manualAct.includes(manual.ttn));
 await db.exec("select np_online_act(1,1,'20400000000004')");
 assert.equal((await db.query('select novaposhta from acts where act_id=1')).rows[0].novaposhta.filter(x=>x===manual.ttn).length,1);
 const filtered=(await db.query('select np_archive_list(1,1,null,null,null,1) result')).rows[0].result;
 assert.ok(filtered.shipments.some(s=>s.ttn===manual.ttn&&s.act_ids.includes(1)));
 assert.equal((await db.query('select np_archive_list(999,1,null,null,null,1) result')).rows[0].result.shipments.length,0);
 await db.exec("insert into acts values(2,null,'{}','Admin');select np_online_act(1,2,'20400000000004');");
 assert.deepEqual((await db.query("select act_ids from novaposhta where ttn='20400000000004'")).rows[0].act_ids,[1,2]);
 await db.exec("select np_online_act(1,1,'20400000000004',true)");
 assert.deepEqual((await db.query("select act_ids from novaposhta where ttn='20400000000004'")).rows[0].act_ids,[2]);
 // Upgrade old object snapshots without losing their content; rerun is idempotent.
 await db.exec(`insert into acts values(3,null,'{}','Admin');update acts set novaposhta='[{"ttn":"20400000000005","note":"Preserve","shipment":{"raw_document":{"Extra":123},"history":[]}}]' where act_id=3;`);
 await db.exec(update);
 assert.deepEqual((await db.query('select novaposhta from acts where act_id=3')).rows[0].novaposhta,['20400000000005']);
 const legacy=(await db.query("select * from novaposhta where ttn='20400000000005'")).rows[0];
 assert.deepEqual(legacy.act_ids,[3]);assert.equal(legacy.raw_document.Extra,123);assert.equal(legacy.history.at(-1).payload.note,'Preserve');
 await db.exec(update);
 assert.deepEqual((await db.query("select * from novaposhta where ttn='20400000000005'")).rows[0],legacy);
 const ordered=[];
 for(let i=0;i<25;i++) {
   const ttn=String(20400000000100+i);const clock=`12:${String(i).padStart(2,'0')}:00`;
   await save(ttn,{document_date:'2030-01-02',provider_details:{created:`2030-01-02 ${clock}`}},{DateTime:`02.01.2030 ${clock}`});ordered.unshift(ttn);
 }
 const first=(await db.query("select np_archive_list(1,1,'2030-01-02','2030-01-02') result")).rows[0].result;
 const second=(await db.query("select np_archive_list(1,2,'2030-01-02','2030-01-02') result")).rows[0].result;
 assert.equal(first.has_more,true);assert.equal(second.has_more,false);
 assert.deepEqual([...first.shipments,...second.shipments].map(s=>s.ttn),ordered);
 assert.equal((await db.query("select count(*)::int n from pg_tables where schemaname='public' and tablename like 'np_%'")).rows[0].n,0);
 }finally{await db.close();}
});

test('refreshing the 20th retains all shipments from the 10th, their full history and act links',{skip:!process.env.NP_VALIDATION_ROOT},async()=>{
 const {PGlite}=require(path.join(process.env.NP_VALIDATION_ROOT,'node_modules/@electric-sql/pglite'));const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create table settings(setting_id integer primary key,data boolean,"Запчастист" boolean,"Складовщик" boolean);create table slyusars(slyusar_id integer primary key,data jsonb);create table acts(act_id bigint primary key,date_off timestamptz,data jsonb,pruimalnyk text);insert into slyusars values(1,'{"Name":"Admin","Доступ":"Адміністратор"}');insert into acts values(1,null,'{}','Admin');`);
  await db.exec(require('../scripts/prepare-nova-poshta-dashboard.cjs').buildDatabaseSQL());
  const batch=entries=>db.query('select np_archive_save_batch($1)',[JSON.stringify(entries)]);
  const snapshot=async()=> (await db.query('select * from novaposhta order by ttn')).rows;
  const list=async(from,to)=> (await db.query('select np_archive_list(1,1,$1,$2) result',[from,to])).rows[0].result.shipments;
  const oldNumber='20400000000010';const newNumber='20400000000020';
  await batch([{ttn:oldNumber,source:'document',data:{document_date:'2026-10-10',direction:'incoming',state:'received',provider_details:{created:'2026-10-10 11:15:00',value:1500,weight:7,sender:'Sender',address:'Saved address'}},raw:{Number:oldNumber,DateTime:'10.10.2026 11:15:00',StatusCode:'9',ExtraField:{nested:'Preserved'},Services:[{name:'Delivery'}]}}]);
  await db.query('select np_online_act(1,1,$1)',[oldNumber]);
  const original=(await snapshot())[0];
  const act=(await db.query('select novaposhta from acts where act_id=1')).rows[0].novaposhta;
  await batch([{ttn:newNumber,source:'document',data:{document_date:'2026-10-20',direction:'outgoing',state:'transit'},raw:{Number:newNumber,DateTime:'20.10.2026 12:30:00',StatusCode:'5'}}]);
  const saved=await snapshot();
  assert.equal(saved.length,2);assert.deepEqual(saved[0],original);
  assert.deepEqual((await list('2026-10-20','2026-10-20')).map(s=>s.ttn),[newNumber]);
  assert.deepEqual((await list('2026-10-10','2026-10-10')).map(s=>s.ttn),[oldNumber]);
  assert.deepEqual((await list('2026-10-10','2026-10-20')).map(s=>s.ttn),[newNumber,oldNumber]);
  // An empty response from either period must leave every column and timestamp untouched.
  await batch([]);assert.deepEqual(await snapshot(),saved);
  assert.deepEqual((await db.query('select novaposhta from acts where act_id=1')).rows[0].novaposhta,act);
  // Partial updates preserve full older payloads and append only the actual changes to history.
  await batch([{ttn:oldNumber,source:'document',data:{provider_details:{value:1600,weight:null,sender:'',address:''}},raw:{Number:oldNumber,Cost:1600,ExtraField:{nested:null},Services:[]}}]);
  const updated=(await snapshot())[0];
  assert.equal(updated.data.provider_details.value,1600);
  assert.equal(updated.data.provider_details.weight,7);assert.equal(updated.data.provider_details.sender,'Sender');assert.equal(updated.data.provider_details.address,'Saved address');
  assert.equal(updated.data.state,'received');assert.equal(updated.document_date,'2026-10-10');
  assert.deepEqual(updated.raw_document.ExtraField,original.raw_document.ExtraField);assert.deepEqual(updated.raw_document.Services,original.raw_document.Services);
  assert.deepEqual(updated.history.slice(0,original.history.length),original.history);
  assert.deepEqual(updated.history.at(-1).data_changes,{provider_details:{value:1600}});
  assert.deepEqual(updated.act_ids,[1]);assert.equal((await snapshot()).length,2);
 }finally{await db.close();}
});
