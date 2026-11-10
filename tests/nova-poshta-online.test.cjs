const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const {webcrypto}=require('node:crypto');
const {buildFunction}=require('../scripts/prepare-nova-poshta-dashboard.cjs');
test('online endpoint authenticates, encrypts settings, reads archive and refreshes provider only explicitly', async()=>{
  let handler; let config={}; let employeeRole='Адміністратор'; let valid=false; let userId='fixture-user'; let rejectProvider=false;
  let documentRows=[{Number:'20400000000001',CargoDescription:'Деталь',StatusCode:'7',Status:'Прибула',DateTime:'02.10.2026 10:30:00'}];
  let trackingRows=[{Number:'20400000000001',StatusCode:'7',Status:'Прибула'}];
  const calls=[]; const archive=new Map(); const dbCalls=[]; const optionQueries=[];
  const client={auth:{getUser:async()=>({data:{user:{id:userId,email:'fixture@example.test'}},error:null})},
    from(table){
      dbCalls.push(table);
      if(table==='novaposhta') {
        let ttn;let start=0;let end=19;let cursor='';
        const result=()=>{const rows=[...archive.values()].filter(r=>(!ttn||r.ttn===ttn)&&r.ttn>cursor);return {data:rows.slice(start,end+1),count:rows.length,error:null};};
        const q={select:(columns,options)=>{assert.ok(!options?.count);return q;},eq:(key,value)=>{if(key==='ttn')ttn=value;return q;},gte:()=>q,lte:()=>q,gt:(_key,value)=>{cursor=value;return q;},order:()=>q,limit:n=>{end=n-1;return q;},range:(a,b)=>{start=a;end=b;return q;},maybeSingle:async()=>({...result(),data:result().data[0]||null}),then:(a,b)=>Promise.resolve(result()).then(a,b)};return q;
      }
      assert.ok(['settings','slyusars','whitelist'].includes(table), `Unexpected table ${table}`);
      const result={data:table==='settings'?{novaposhta:config}:table==='slyusars'?{slyusar_id:1,data:{Name:'Admin',Доступ:'Адміністратор'}}:{email:'fixture@example.test'},error:null};
      const q={select:()=>q,eq:()=>q,limit:()=>q,single:async()=>result,maybeSingle:async()=>result,then:(a,b)=>Promise.resolve(result).then(a,b)};return q;
    },
    async rpc(name,args){
      dbCalls.push(name);
      if(name==='traffic_np_employee') {assert.equal(args.p_id,1);return {data:{slyusar_id:1,name:'Admin',role:employeeRole},error:null};}
      if(name==='np_archive_link_options') {optionQueries.push(args);return {data:{ttns:[],acts:[],ttns_has_more:false,acts_has_more:false,page:args.p_page},error:null};}
      if(name==='np_archive_save_batch') {for(const e of args.p_entries){const old=archive.get(e.ttn)||{ttn:e.ttn,data:{}};archive.set(e.ttn,{...old,data:{...old.data,...e.data},last_seen_at:new Date().toISOString()});}return {data:args.p_entries.length,error:null};}
      if(name==='np_archive_save') {const old=archive.get(args.p_ttn)||{ttn:args.p_ttn,data:{}};archive.set(args.p_ttn,{...old,data:{...old.data,...args.p_data},last_seen_at:new Date().toISOString()});return {data:null,error:null};}
      if(name==='np_archive_list') {const rows=[...archive.values()];const offset=(args.p_page-1)*20;return {data:{shipments:rows.slice(offset,offset+20).map(r=>({...r.data,ttn:r.ttn,id:r.ttn,act_ids:[]})),has_more:rows.length>offset+20,page:args.p_page},error:null};}
      if(name==='np_online_rate') return {data:true,error:null};
      if(name==='verify_slyusar_password') return {data:[{is_valid:valid,slyusar_id:1}],error:null};
      if(name==='np_online_settings'){config={...config,...args.p_patch};return {data:null,error:null};}
      throw Error(`Unexpected RPC ${name}`);
    }
  };
  const source=buildFunction().replace(/^import .*createClient.*;\r?\n/m,'');
  const context={exports:{},createClient:()=>client,Request,Response,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,atob,btoa,AbortSignal,console,setTimeout,
    Deno:{env:{get:n=>({SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fixture',NP_ENCRYPTION_KEY:'12'.repeat(32)})[n]},serve:fn=>{handler=fn;}},
    fetch:async(_url,options)=>{
      const b=JSON.parse(options.body);calls.push(b);
      const rows=b.calledMethod==='getCounterparties'?[]:b.calledMethod==='getStatusDocuments'?trackingRows:[{result:b.methodProperties.Page===1?documentRows:[]}];
      return new Response(JSON.stringify(rejectProvider?{success:false,errors:['invalid API key']}:{success:true,data:rows}));
    }};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const request=async b=>{const r=await handler(new Request('https://fixture.test',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify(b)}));return {status:r.status,...await r.json()};};
  assert.equal((await request({action:'authenticate',name:'Admin',password:'bad'})).status,403);
  valid=true;const auth=await request({action:'authenticate',name:'Admin',password:'fixture-password'});assert.equal(auth.ok,true);
  const session=auth.token;
  assert.ok(dbCalls.includes('traffic_np_employee'));
  assert.ok(!dbCalls.includes('slyusars'));
  employeeRole='No access';assert.equal((await request({action:'overview',session})).status,403);employeeRole='Адміністратор';
  assert.equal((await request({action:'overview',session:session.slice(1)})).status,401);
  userId='another-user';assert.equal((await request({action:'overview',session})).status,401);userId='fixture-user';
  // Suggestions read the archive before provider setup, using the authenticated employee.
  const beforeOptions=calls.length;
  assert.equal((await request({action:'link_options',session})).ok,true);
  assert.deepEqual(structuredClone(optionQueries.at(-1)),{p_employee:1,p_kind:'all',p_query:'',p_page:1});
  assert.equal((await request({action:'link_options',session,kind:'act',query:'Петренко Ford',page:2,employee_id:999})).ok,true);
  assert.deepEqual(structuredClone(optionQueries.at(-1)),{p_employee:1,p_kind:'act',p_query:'Петренко Ford',p_page:2});
  assert.equal((await request({action:'link_options',session,kind:'ttn',query:'204 000-000'})).ok,true);
  assert.equal(optionQueries.at(-1).p_query,'204000000');
  for(const input of [{kind:'unknown'},{kind:['act']},{kind:'ttn',query:'ABC'},{page:0},{page:1.5},{kind:'act',query:'a'.repeat(121)}]) {
    assert.equal((await request({action:'link_options',session,...input})).status,400);
  }
  assert.equal(optionQueries.length,3);assert.equal(calls.length,beforeOptions);
  const saved=await request({action:'connect',session,key:'fixture-api-key-123456789',phone:'0501234567',login:'fixture-login',account_password:'fixture-account-password'});
  assert.equal(saved.ok,true); assert.equal(config.login,'fixture-login');assert.ok(config.password_encrypted);assert.ok(!JSON.stringify(config).includes('fixture-account-password'));assert.ok(!JSON.stringify(config).includes('fixture-api-key-123456789'));
  const overview=await request({action:'overview',session});assert.equal(overview.connection.has_password,true);assert.ok(!JSON.stringify(overview).includes('encrypted'));
  const before=calls.length;assert.equal((await request({action:'list',session})).shipments.length,0);assert.equal(calls.length,before);
  const beforeInvalid=calls.length;
  assert.equal((await request({action:'sync_page',session,page:1,from:'2026-10-01'})).ok,false);
  assert.equal((await request({action:'sync_page',session,page:1,from:'2026-10-02',to:'2026-10-01'})).ok,false);
  assert.equal(calls.length,beforeInvalid);
  dbCalls.length=0;
  const firstPage=await request({action:'sync_page',session,page:1,from:'2026-10-01',to:'2026-10-02'});
  assert.deepEqual(firstPage.next_directions,[]);
  assert.equal(dbCalls.filter(c=>c==='np_archive_save_batch').length,1);
  assert.equal(dbCalls.filter(c=>c==='settings').length,1);
  assert.equal(dbCalls.filter(c=>c==='np_archive_save').length,0);
  let result=await request({action:'list',session,from:'2026-10-01',to:'2026-10-02',direction:'incoming',page:1});assert.equal(result.shipments[0].state,'arrived');assert.equal(result.shipments[0].ttn,'20400000000001');
  const listing=calls.find(b=>b.calledMethod==='getIncomingDocumentsByPhone');assert.equal(listing.apiKey,'fixture-api-key-123456789');assert.equal(listing.methodProperties.Limit,20);assert.equal(listing.methodProperties.DateFrom,'01.10.2026 00:00:00');assert.equal(listing.methodProperties.DateTo,'02.10.2026 23:59:59');assert.ok(!('system' in listing));
  assert.equal((await request({action:'sync_page',session,page:1})).ok,true);
  const defaultCall=calls.filter(b=>b.calledMethod==='getIncomingDocumentsByPhone').at(-1);
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  // Default sync includes today and the preceding 13 days (the existing 14-day period).
  const start=new Date(today+'T00:00:00Z');start.setUTCDate(start.getUTCDate()-13);
  assert.equal(defaultCall.methodProperties.DateTo,today.split('-').reverse().join('.')+' 23:59:59');
  assert.equal(defaultCall.methodProperties.DateFrom,start.toISOString().slice(0,10).split('-').reverse().join('.')+' 00:00:00');
  const beforeDirection=calls.length;
  await request({action:'sync_page',session,page:2,directions:['incoming']});
  assert.deepEqual(calls.slice(beforeDirection).map(b=>b.calledMethod),['getIncomingDocumentsByPhone']);
  result=await request({action:'list',session,page:2});assert.equal(result.shipments.length,0);assert.equal(result.has_more,false);
  assert.equal((await request({action:'detail',session,id:'20400000000001'})).shipment.state,'arrived');
  rejectProvider=true;assert.equal((await request({action:'list',session})).ok,true);assert.equal((await request({action:'sync_ttn',session,id:'20400000000001'})).code,'NP_KEY');assert.equal((await request({action:'detail',session,id:'20400000000001'})).shipment.state,'arrived');rejectProvider=false;
  // Syncing a later period only adds returned TTNs; older shipments remain untouched.
  const original=structuredClone(archive.get('20400000000001'));
  documentRows=[{Number:'20400000000010',StatusCode:'9',Status:'Отримана',DateTime:'10.10.2026 11:15:00',Cost:'1500'}];
  assert.equal((await request({action:'sync_page',session,page:1,from:'2026-10-10',to:'2026-10-10',directions:['incoming']})).ok,true);
  const tenth=structuredClone(archive.get('20400000000010'));
  documentRows=[{Number:'20400000000020',StatusCode:'5',Status:'У дорозі',DateTime:'20.10.2026 12:30:00'}];
  assert.equal((await request({action:'sync_page',session,page:1,from:'2026-10-20',to:'2026-10-20',directions:['outgoing']})).ok,true);
  assert.equal(archive.size,3);
  assert.deepEqual(structuredClone(archive.get('20400000000001')),original);
  assert.deepEqual(structuredClone(archive.get('20400000000010')),tenth);
  const savedArchive=structuredClone([...archive]);
  documentRows=[];dbCalls.length=0;
  assert.equal((await request({action:'sync_page',session,page:1,from:'2026-10-10',to:'2026-10-20'})).updated,0);
  assert.ok(!dbCalls.includes('np_archive_save_batch'));
  assert.deepEqual(structuredClone([...archive]),savedArchive);
  // Missing/removed provider records must not reset a delivered shipment's status or details.
  for(const missingStatus of ['0','3']) {
    documentRows=[{Number:'20400000000010',StatusCode:missingStatus,Status:'Недоступна',Cost:'0',DateTime:'10.10.2026'}];
    dbCalls.length=0;
    assert.equal((await request({action:'sync_page',session,page:1,from:'2026-10-10',to:'2026-10-20'})).updated,0);
    assert.ok(!dbCalls.includes('np_archive_save_batch'));
    assert.deepEqual(structuredClone([...archive]),savedArchive);
  }
  for(const missingRows of [[],[{Number:'20400000000010'}],[{Number:'20400000000010',StatusCode:'0'}],[{Number:'20400000000010',StatusCode:'3'}]]) {
    trackingRows=missingRows;dbCalls.length=0;
    const missing=await request({action:'sync_ttn',session,id:'20400000000010'});
    assert.equal(missing.ok,true);assert.equal(missing.updated,0);
    assert.ok(!dbCalls.includes('np_archive_save_batch'));
    assert.deepEqual(structuredClone([...archive]),savedArchive);
    const preserved=await request({action:'detail',session,id:'20400000000010'});
    assert.equal(preserved.shipment.state,'received');assert.equal(preserved.shipment.provider_details.value,1500);
  }
  const oldPassword=config.password_encrypted;await request({action:'save_settings',session,name:'НП',phone:'0501234567',login:'fixture-login',account_password:''});assert.equal(config.password_encrypted,oldPassword);
  await request({action:'disconnect',session});assert.equal((await request({action:'list',session})).ok,true);assert.equal((await request({action:'sync_ttn',session,id:'20400000000001'})).code,'NP_KEY_MISSING');
});
test('online migration and cleanup preserve settings and need no shipment tables', { skip: !process.env.NP_VALIDATION_ROOT }, async()=>{
  const root=process.env.NP_VALIDATION_ROOT;
  assert.ok(root,'Set NP_VALIDATION_ROOT to the existing PGlite tooling directory');
  const {PGlite}=require(path.join(root,'node_modules/@electric-sql/pglite')); const db=new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create table slyusars(slyusar_id integer primary key,data jsonb);
      create table cars(cars_id bigint primary key,data jsonb);
      create table acts(act_id bigint primary key,cars_id bigint,date_off timestamptz,pruimalnyk text,data jsonb);
      create table settings(setting_id integer primary key,data boolean,"Загальні" text,"Запчастист" boolean,"Складовщик" boolean,novaposhta jsonb);
      insert into settings(setting_id,data,"Загальні") values(10,true,'preserve');`);
    for(const file of ['20260927000000_nova_poshta.sql','20260928000000_nova_poshta_connection_controls.sql','20261002000000_nova_poshta_shipment_details.sql']) await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
    await db.exec(`insert into np_connections(id,name,phone) values(1,'Existing','380501234567');select np_secret('ciphertext');`);
    await db.exec(`insert into slyusars values(1,'{"Name":"Admin","Доступ":"Адміністратор"}'),(2,'{"Name":"Other","Доступ":"Приймальник"}');
      insert into acts(act_id,pruimalnyk,data) values(100,'Receiver','{}');
      insert into np_shipments(id,ttn) values('00000000-0000-4000-8000-000000000001','20400000000001');
      insert into np_act_links(shipment_id,act_id,note) values('00000000-0000-4000-8000-000000000001',100,'Migrated');`);
    await db.exec(fs.readFileSync('supabase/migrations/20261002120000_nova_poshta_online.sql','utf8'));
    await db.exec(fs.readFileSync('docs/nova-poshta-remove-legacy.sql','utf8'));
    await db.exec(`set role service_role;select np_online_settings('{"login":"fixture"}');`);
    assert.equal((await db.query(`select np_online_rate('login:test',1,300) as allowed`)).rows[0].allowed,true);
    assert.equal((await db.query(`select np_online_rate('login:test',1,300) as allowed`)).rows[0].allowed,false);
    await db.exec('reset role');
    const row=(await db.query('select * from settings where setting_id=10')).rows[0];assert.equal(row.novaposhta.api_key_encrypted,'ciphertext');assert.equal(row.novaposhta.login,'fixture');assert.equal(row['Загальні'],'preserve');assert.equal(row.data,true);
    assert.equal((await db.query(`select count(*)::integer as n from pg_tables where schemaname='public' and tablename like 'np_%'`)).rows[0].n,0);
    await db.exec('set role authenticated');await assert.rejects(db.query(`select np_online_settings('{}')`),/permission denied/);await db.exec('reset role');
    // Multiple TTNs, idempotence, permissions and closed acts after legacy cleanup.
    await db.exec(`select np_online_act(1,100,'20400000000002',false,'Second','incoming');select np_online_act(1,100,'20400000000002',false,'Duplicate','incoming');`);
    let items=(await db.query('select novaposhta from acts where act_id=100')).rows[0].novaposhta;
    assert.equal(items.length,2);assert.equal(items[0].note,'Migrated');
    await assert.rejects(db.query('select np_online_act(2,100)'),/ACT_FORBIDDEN/);
    await db.exec(`select np_online_act(1,100,'20400000000002',true);update acts set date_off=now() where act_id=100;`);
    await assert.rejects(db.query(`select np_online_act(1,100,'20400000000003')`),/ACT_FORBIDDEN/);
    assert.equal((await db.query('select novaposhta from acts where act_id=100')).rows[0].novaposhta.length,1);
    // The same migration also installs and runs after all old tables are gone.
    await db.exec(fs.readFileSync('supabase/migrations/20261002120000_nova_poshta_online.sql','utf8'));
  } finally {await db.close();}
});
