const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const path=require('node:path');
const ts=require('typescript');
const {buildFunction,buildUpdateSQL,buildDatabaseSQL}=require('../scripts/prepare-nova-poshta-dashboard.cjs');

function fixture() {
  let role='Приймальник', error=null, rowMissing=false;
  const reads=[];
  const admin={
    async rpc(name,args) { reads.push({name,args}); return {data:rowMissing?null:{slyusar_id:7,name:'Employee',role},error}; },
    from(table) {
      const q={select(columns){reads.push({table,columns});assert.notEqual(columns,'data');return q;},eq(){return q;},async single(){return {data:{slyusar_id:7,name:'Employee',role},error:null};}};
      return q;
    },
  };
  const source=buildFunction().replace(/^import .*createClient.*;\r?\n/m,'')+'\ninitializeAdmin(); exports.employee=employee;';
  const context={exports:{},createClient:()=>admin,console:{error(){}},Deno:{env:{get:n=>({SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fixture'})[n]},serve(){}}};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return {employee:context.exports.employee,reads,setRole:v=>role=v,setError:v=>error=v,remove:()=>rowMissing=true};
}

test('NP authorization rechecks employee and explicit access on each request',async()=>{
  const f=fixture();let access=true;let configReads=0;
  const config=async()=>{configReads++;return {access:{7:access}};};
  assert.equal((await f.employee(7,config)).id,7);
  access=false;
  await assert.rejects(f.employee(7,config),e=>e.code==='FORBIDDEN');
  access=true;f.setRole('Слюсар');
  assert.equal((await f.employee(7,config)).role,'Слюсар');
  f.remove();
  await assert.rejects(f.employee(7,config),e=>e.code==='FORBIDDEN');
  assert.equal(configReads,4);
  assert.equal(f.reads.length,4);
  assert.ok(f.reads.every(r=>r.name==='traffic_np_employee'&&r.args.p_id===7));
});

test('NP missing projection supports ordinary JSON but never fetches legacy payroll',async()=>{
  for(const code of ['PGRST202','42883']) {
    const f=fixture();f.setError({code});
    assert.equal((await f.employee(7,async()=>({}))).role,'Приймальник');
    f.setRole(null);
    await assert.rejects(f.employee(7,async()=>({access:{7:true}})),e=>e.code==='SETUP'&&e.status===503);
    assert.ok(f.reads.filter(r=>r.table).every(r=>r.columns==='slyusar_id,name:data->>Name,role:data->>Доступ'));
  }
});

test('NP projection database errors do not trigger fallback or authorize',async()=>{
  for(const code of ['42501','PGRST301','57014']) {
    const f=fixture();f.setError({code});
    await assert.rejects(f.employee(7,async()=>({access:{7:true}})),e=>e.code==='DATABASE');
    assert.equal(f.reads.length,1);
  }
});

test('both standalone NP bundles install compact employee projection and its dependency',()=>{
  for(const sql of [buildUpdateSQL(),buildDatabaseSQL()]) {
    assert.equal((sql.match(/create or replace function public\.traffic_np_employee\(/g)||[]).length,1);
    assert.equal((sql.match(/create or replace function public\.traffic_json_object\(/g)||[]).length,1);
    assert.match(sql,/revoke all on function public\.traffic_np_employee\(bigint\) from public, anon, authenticated/);
    assert.match(sql,/grant execute on function public\.traffic_np_employee\(bigint\) to service_role/);
    assert.doesNotMatch(sql,/create or replace function public\.traffic_accounting_statuses/);
  }
});

test('standalone NP SQL projects legacy JSON without payroll and rejects browser roles',{skip:!process.env.NP_VALIDATION_ROOT},async()=>{
  const {PGlite}=require(path.join(process.env.NP_VALIDATION_ROOT,'node_modules/@electric-sql/pglite'));
  const db=new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;
      create table settings(setting_id integer primary key,data boolean,"Запчастист" boolean,"Складовщик" boolean);
      create table slyusars(slyusar_id integer primary key,data jsonb);
      create table acts(act_id bigint primary key,date_off timestamptz,data jsonb,pruimalnyk text);`);
    await db.exec(buildDatabaseSQL());await db.exec(buildUpdateSQL());
    const payload={Name:'Employee',Доступ:'Приймальник',payroll:'secret history'.repeat(10000)};
    await db.query('insert into slyusars values (7,$1::jsonb),(8,$2::jsonb)',[JSON.stringify(payload),JSON.stringify(JSON.stringify(payload))]);
    await db.exec('grant select on slyusars to service_role;set role service_role');
    for(const id of [7,8]) {
      const row=(await db.query('select traffic_np_employee($1) v',[id])).rows[0].v;
      assert.deepEqual(row,{slyusar_id:id,name:'Employee',role:'Приймальник'});
      assert.ok(JSON.stringify(row).length<150);
    }
    assert.equal((await db.query('select traffic_np_employee(99) v')).rows[0].v,null);
    await db.exec('reset role');
    for(const role of ['anon','authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select traffic_np_employee(7)'),/permission denied for function traffic_np_employee/);
      await db.exec('reset role');
    }
  } finally {await db.close();}
});
