const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
test('editor guarded RPC rejects missing/stale/other owners and keeps stock atomic',async()=>{
 const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table acts(act_id integer primary key,data jsonb,date_off timestamptz,avans numeric,cars_id bigint);
 create table sclad(sclad_id integer primary key,kilkist_off numeric);
 create table act_locks(act_id integer primary key,user_name text,opened_at timestamptz default now(),heartbeat_at timestamptz default now());
 insert into acts values(1,'{"Деталі":[]}',null,0,1);insert into sclad values(1,0);`);
 await db.exec(fs.readFileSync('supabase/migrations/20261004000000_write_act_with_stock.sql','utf8'));
 const sql=fs.readFileSync('supabase/migrations/20261011070000_act_editor_lease_guard.sql','utf8');await db.exec(sql);await db.exec(sql);
 const expected={Деталі:[]},next={Деталі:[{sclad_id:1,Кількість:2}]};
 const save=owner=>db.query('select guarded_write_act_with_stock(1,$1,$2,$3)',[JSON.stringify(expected),JSON.stringify(next),owner]);
 await assert.rejects(save('me'),e=>e.code==='55P03');
 await db.exec("insert into act_locks(act_id,user_name) values(1,'other')");await assert.rejects(save('me'),e=>e.code==='55P03');
 await db.exec("update act_locks set user_name='me',heartbeat_at=now()-interval '91 seconds'");await assert.rejects(save('me'),e=>e.code==='55P03');
 assert.equal((await db.query('select kilkist_off from sclad')).rows[0].kilkist_off,'0');
 await db.exec('update act_locks set heartbeat_at=now()');await save('me');assert.equal((await db.query('select kilkist_off from sclad')).rows[0].kilkist_off,'2');await assert.rejects(save('me'),e=>e.code==='40001');
 await db.query('select guarded_write_act_json(1,$1,$2,$3)',[JSON.stringify(next),JSON.stringify({...next,note:'ok'}),'me']);
 await db.exec('grant select,update on acts,sclad,act_locks to authenticated;alter table acts enable row level security;set role authenticated');
 await assert.rejects(db.query('select guarded_write_act_json(1,$1,$2,$3)',[JSON.stringify({...next,note:'ok'}),'{}','me']),e=>e.code==='40001');
 }finally{await db.close()}
});
test('editor client does not fall back to unguarded writes when SQL is missing',async()=>{
 const api={},calls=[];const supabase={rpc:async(name,args)=>{calls.push([name,args]);return {error:{code:'PGRST202'}}},from:()=>{throw Error('unsafe fallback')}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/utils/actSafeWrite.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,structuredClone,require:()=>({supabase}),crypto:{randomUUID:()=> 'revision'}});
 await assert.rejects(api.writeActSnapshotWithStock(1,{Деталі:[]},{Деталі:[]},{lockOwner:'me'}),/act_save_receipts/);assert.equal(calls[0][0],'guarded_write_act_with_stock_receipt');assert.equal(calls[0][1].p_lock_owner,'me');
});
