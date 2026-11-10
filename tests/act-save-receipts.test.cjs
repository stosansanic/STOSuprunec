const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),ts=require('typescript');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
async function setup(){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;
 create table acts(act_id integer primary key,data jsonb,date_off timestamp,avans numeric,cars_id bigint,pruimalnyk text);
 create table sclad(sclad_id integer primary key,kilkist_off numeric);
 create table act_locks(act_id integer primary key,user_name text,heartbeat_at timestamptz);
 insert into acts values(1,'{"Деталі":[]}',null,0,5,'Receiver');insert into sclad values(1,0);insert into act_locks values(1,'owner',now());`);
 for(const name of ['20261004000000_write_act_with_stock','20261011070000_act_editor_lease_guard','20261011080000_traffic_payroll_json','20261011160000_act_save_receipts'])await db.exec(fs.readFileSync('supabase/migrations/'+name+'.sql','utf8'));return db;}
test('save receipts preserve stock/full content, verify context, reject concurrent legacy edits and finish idempotently',async()=>{const db=await setup();try{
 const expected={Деталі:[]},next={Деталі:[{sclad_id:1,Кількість:2}],Роботи:Array.from({length:100},(_,i)=>({Робота:'w'+i})),__act_revision:'saved',__payroll_pending:true,note:'keep'};
 const write=async value=>(await db.query('select guarded_write_act_with_stock_receipt(1,$1,$2,$3) r',[JSON.stringify(expected),JSON.stringify(value),'owner'])).rows[0].r;
 const receipt=await write(next);assert.equal(receipt.data,undefined);assert.equal(receipt.revision,'saved');assert.ok(JSON.stringify(receipt).length<250);assert.equal((await write(next)).status,'unchanged');assert.equal((await db.query('select kilkist_off from sclad')).rows[0].kilkist_off,'2');
 const context=async()=>(await db.query('select guarded_act_payroll_context(1,$1,$2,$3) r',[receipt.checksum,receipt.revision,'owner'])).rows[0].r;
 assert.equal((await context()).pruimalnyk,'Receiver');assert.equal((await context()).data,undefined);
 await db.exec(`update acts set data=jsonb_set(data,'{note}','"concurrent"')`);await assert.rejects(context(),e=>e.code==='40001');
 const finish=()=>db.query('select guarded_finish_act_payroll(1,$1,$2,$3,$4) r',[receipt.checksum,receipt.revision,'finished','owner']);
 await assert.rejects(finish(),e=>e.code==='40001');assert.equal((await db.query("select data->>'note' note from acts")).rows[0].note,'concurrent');
 await db.query('update acts set data=$1',[JSON.stringify(next)]);await finish();assert.equal((await finish()).rows[0].r.status,'unchanged');
 const stored=(await db.query('select data from acts')).rows[0].data;assert.deepEqual(stored,{...next,__payroll_pending:false,__act_revision:'finished'});
 await db.exec(`update acts set data=jsonb_set(data,'{note}','"after finish"')`);await assert.rejects(finish(),e=>e.code==='40001');
 await assert.rejects(write({...next,__act_revision:'retry-new-request'}),e=>e.code==='40001');assert.equal((await db.query('select kilkist_off from sclad')).rows[0].kilkist_off,'2');
 }finally{await db.close();}});
test('receipt checks reject stale lease, RLS-hidden acts and server trigger transformations atomically',async()=>{const db=await setup();try{
 const call=()=>db.query('select guarded_write_act_with_stock_receipt(1,$1,$2,$3)',[JSON.stringify({Деталі:[]}),JSON.stringify({Деталі:[{sclad_id:1,Кількість:2}],__act_revision:'r',__payroll_pending:true}),'owner']);
 await db.exec("update act_locks set heartbeat_at=now()-interval '91 seconds'");await assert.rejects(call(),e=>e.code==='55P03');await db.exec('update act_locks set heartbeat_at=now()');
 await db.exec(`create function alter_saved() returns trigger language plpgsql as $$begin new.data:=new.data||'{"changedByTrigger":true}'::jsonb;return new;end$$;create trigger alter_saved before update on acts for each row execute function alter_saved();`);
 await assert.rejects(call(),e=>e.code==='40001');assert.equal((await db.query('select kilkist_off from sclad')).rows[0].kilkist_off,'0');await db.exec('drop trigger alter_saved on acts;');
 await db.exec('alter table acts enable row level security;grant select,update on acts,sclad,act_locks to authenticated;set role authenticated;');await assert.rejects(call());
 }finally{await db.close();}});
test('client uses only compact receipts after stock save, reconstructs acknowledged data and no extra full reads',async()=>{
 const api={},calls=[];let id=0;const checksum='a'.repeat(32);const supabase={from(){throw Error('full read forbidden')},rpc:async(name,args)=>{calls.push([name,args]);if(name==='guarded_act_payroll_context')return {data:{pruimalnyk:'Receiver',date_off:null,revision:args.p_revision,checksum}};return {data:{act_id:1,status:'updated',revision:args.p_next?.__act_revision||args.p_next_revision,checksum,cars_id:5}}}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/utils/actSafeWrite.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:()=>({supabase}),crypto:{randomUUID:()=>String(++id)},structuredClone});
 const next={Деталі:[],note:'keep',__payroll_pending:true};const saved=await api.writeActSnapshotWithStock(1,{Деталі:[]},next,{lockOwner:'owner'});await api.readSavedActPayrollContext(saved.receipt,'owner');const done=await api.finishActPayroll(saved.receipt,saved.data,'owner');assert.equal(done.data.note,'keep');assert.equal(done.data.__payroll_pending,false);assert.equal(calls.length,3);assert.equal(calls[2][1].p_expected,undefined);assert.equal(calls[2][1].p_next,undefined);
});
test('receipt reconstruction cannot acknowledge nested edits made while request is pending',async()=>{
 const api={},pending=[];const supabase={rpc:(_name,args)=>new Promise(resolve=>pending.push({args,resolve}))};let id=0;
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/utils/actSafeWrite.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:()=>({supabase}),crypto:{randomUUID:()=>String(++id)},structuredClone});
 const next={Деталі:[{Кількість:1}],__payroll_pending:true};const promise=api.writeActSnapshotWithStock(1,{Деталі:[]},next,{lockOwner:'owner'});next.Деталі[0].Кількість=9;
 pending[0].resolve({data:{act_id:1,status:'updated',revision:pending[0].args.p_next.__act_revision,checksum:'a'.repeat(32)}});const saved=await promise;assert.equal(saved.data.Деталі[0].Кількість,1);
 const finish=api.finishActPayroll(saved.receipt,saved.data,'owner');saved.data.Деталі[0].Кількість=7;pending[1].resolve({data:{act_id:1,status:'updated',revision:pending[1].args.p_next_revision,checksum:'b'.repeat(32)}});assert.equal((await finish).data.Деталі[0].Кількість,1);
});
