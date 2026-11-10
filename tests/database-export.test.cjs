const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const {webcrypto}=require('node:crypto');
function load(name){
  const module={exports:{}};
  const source=fs.readFileSync(`src/ts/roboha/nalachtuvannay/export/${name}.ts`,'utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
    {module,exports:module.exports,Blob,Response,DOMException,AbortController,TextEncoder,URLSearchParams,crypto:webcrypto});
  return module.exports;
}
const core=load('core'),files=load('files');
const table={name:'acts',keys:['act_id'],schema:{}};
function spec(names=['acts']) {return {paths:Object.fromEntries(names.map(n=>['/'+n,{get:{}}])),definitions:Object.fromEntries(names.map(n=>[n,{properties:{act_id:{type:'integer',description:'This is a Primary Key.<pk/>'},data:{type:'object'}}}]))};}
function reader(rows,cap=250,change){
  const calls=[];
  const read=async(name,params,signal,metadata)=>{
    assert.equal(signal.aborted,false);calls.push({name,offset:Number(params.get('offset')),limit:Number(params.get('limit')),metadata});
    if(metadata)return new Response(JSON.stringify(spec()));
    const source=change?.(calls.length,rows)||rows,offset=Number(params.get('offset')),limit=Math.min(Number(params.get('limit')),cap);
    const page=source.slice(offset,offset+limit);
    return new Response('['+page.join(',')+']',{headers:{'content-range':page.length?`${offset}-${offset+page.length-1}/${source.length}`:`*/${source.length}`}});
  };return {read,calls};
}
function transactionalTarget(){
  const saved=new Map(),aborted=[];
  return {saved,aborted,async open(name){let text='';return {async write(chunk){text+=chunk;},async close(){saved.set(name,text);},async abort(){aborted.push(name);}};}};
}
const signal=()=>new AbortController().signal;

test('discovers new public tables dynamically, skips RPC/root, and retains composite primary keys',()=>{
  const schema=spec(['acts','future_table']);schema.paths['/rpc/do_something']={get:{}};schema.paths['/']={get:{}};
  schema.definitions.future_table.properties.other_id={description:'<pk/>'};
  const result=core.discoverTables(schema);
  assert.deepEqual(Array.from(result,t=>t.name),['acts','future_table']);assert.deepEqual(Array.from(result[1].keys),['act_id','other_id']);
});
test('metadata failure and unsafe paths cannot silently reduce the backup',()=>{
  assert.throws(()=>core.discoverTables({paths:{}}));assert.throws(()=>core.discoverTables(spec([])));
  assert.throws(()=>core.discoverTables(spec(['..\\acts'])));
  const s=spec();delete s.definitions.acts;assert.throws(()=>core.discoverTables(s));
});
test('exports 1203 complete records even if server caps pages to 37; verifies every page',async()=>{
  const rows=Array.from({length:1203},(_,i)=>JSON.stringify({act_id:i,data:{Роботи:Array.from({length:41},(_,j)=>({Робота:'Перевірка '+j}))}}));
  const {read,calls}=reader(rows,37),target=transactionalTarget();
  const result=await core.exportTable(table,read,target,signal(),()=>{});
  const content=JSON.parse(target.saved.get('public.acts.jsonb'));
  assert.equal(result.rows,1203);assert.equal(content.length,1203);assert.equal(content[1202].data.Роботи.length,41);
  assert.equal(calls.length,Math.ceil(1203/37)*2);assert.equal(calls[1].offset,37);assert.equal(target.aborted.length,0);
});
test('preserves bigint, exact numeric decimals, null, strings, JSONB and unicode without reserialization',async()=>{
  const raw='{"act_id":1,"big":9007199254740993123,"price":123.1234567890123456789,"n":null,"data":{"text":"Україна\\n💾","codes":["000123"],"is":false}}';
  const {read}=reader([raw]),target=transactionalTarget();await core.exportTable(table,read,target,signal(),()=>{});
  assert.equal(target.saved.get('public.acts.jsonb'),'[\n'+raw+'\n]\n');
});
test('empty table without primary key still produces valid []',async()=>{
  const {read}=reader([]),target=transactionalTarget();const result=await core.exportTable({...table,keys:[]},read,target,signal(),()=>{});
  assert.equal(result.rows,0);assert.equal(JSON.parse(target.saved.get('public.acts.jsonb')).length,0);
});
test('unkeyed multi-page tables fail instead of exporting unstable pagination',async()=>{
  const {read}=reader(['{"a":1}','{"a":2}'],1),target=transactionalTarget();
  await assert.rejects(core.exportTable({...table,keys:[]},read,target,signal(),()=>{}),/первинний ключ/);
  assert.equal(target.saved.size,0);
});
test('changed count during reading fails and aborts the unfinished file',async()=>{
  const rows=['{"act_id":1}','{"act_id":2}'];const {read}=reader(rows,1,n=>n===2?[...rows,'{"act_id":3}']:rows),target=transactionalTarget();
  await assert.rejects(core.exportTable(table,read,target,signal(),()=>{}),/Кількість записів змінилася/);assert.equal(target.saved.size,0);assert.equal(target.aborted.length,1);
});
test('same-count edits during verification are not reported as a verified table',async()=>{
  const {read}=reader(['{"act_id":1,"value":"old"}'],250,n=>n===2?['{"act_id":1,"value":"new"}']:null),target=transactionalTarget();
  await assert.rejects(core.exportTable(table,read,target,signal(),()=>{}),/Дані змінилися/);assert.equal(target.saved.size,0);
});
test('missing totals, wrong ranges, premature empty pages and malformed JSON fail closed',()=>{
  for(const [text,range,offset] of [['[]','*/10',0],['[{}]','0-0/*',0],['[{}]','1-1/2',0],['[{}]','0-3/4',0],['[','*/0',0],['{}','*/0',0]]) assert.throws(()=>core.readPage(text,range,offset));
});
test('network or local disk errors do not commit a file',async()=>{
  const target=transactionalTarget();await assert.rejects(core.exportTable(table,async()=>{throw Error('HTTP 403');},target,signal(),()=>{}));assert.equal(target.saved.size,0);
  let aborts=0;const broken={async open(){return {async write(){throw Error('disk full');},async close(){assert.fail();},async abort(){aborts++;}};}};
  await assert.rejects(core.exportTable(table,reader([]).read,broken,signal(),()=>{}),/disk full/);assert.equal(aborts,1);
});
test('cancellation aborts the active table; completed files remain intact',async()=>{
  const controller=new AbortController(),target=transactionalTarget();
  await assert.rejects(core.exportTable(table,reader(['{"act_id":1}']).read,target,controller.signal,()=>controller.abort()),/Експорт зупинено/);assert.equal(target.saved.size,0);
});
test('report identifies absent application tables instead of claiming all are exported',async()=>{
  const target=transactionalTarget(); const read=async(name,...args)=>{if(name!=='acts')throw Error('HTTP 404');return reader([]).read(name,...args);}; const result=await core.exportDatabase(read,target,signal(),()=>{});
  assert.equal(result.status,'incomplete');assert.ok(result.tables.some(t=>t.name==='sclad' && t.status==='failed'));
  assert.equal(result.tables[0].status,'exported');assert.equal(JSON.parse(target.saved.get('export-report.json')).status,'incomplete');
});
test('all discovered known tables, including empty ones, are counted and reported',async()=>{
  const target=transactionalTarget(),schema=spec(Array.from(core.APP_TABLES));
  const read=async(name,params,sig,metadata)=>metadata?new Response(JSON.stringify(schema)):new Response('[]',{headers:{'content-range':'*/0'}});
  const result=await core.exportDatabase(read,target,signal(),()=>{});
  assert.equal(result.status,'exported_visible_tables');assert.equal(result.tables.length,core.APP_TABLES.length);assert.equal(target.saved.size,core.APP_TABLES.length+1);
});
test('report remains non-successful after per-table failure and export continues for other tables',async()=>{
  const target=transactionalTarget(),schema=spec(['acts','cars']);
  const read=async(name,params,sig,metadata)=>{if(metadata)return new Response(JSON.stringify(schema));if(name==='acts')throw Error('HTTP 403');return new Response('[]',{headers:{'content-range':'*/0'}});};
  const result=await core.exportDatabase(read,target,signal(),()=>{});
  assert.equal(result.tables[0].status,'failed');assert.equal(result.tables[1].status,'exported');assert.equal(result.status,'incomplete');
});
test('memory archive cap is explicit, never silently truncates a successful file',async()=>{
  const {target,files:map}=files.memoryTarget(10);const file=await target.open('table.jsonb');
  await assert.rejects(file.write('12345678901'),/обсяг пам’яті/);await file.abort();assert.equal(map.size,0);
});
test('ZIP contains separate lossless .jsonb entries, correct lengths, CRCs and central directory',async()=>{
  const source=new Map([['public.acts.jsonb',new Blob(['[{"data":"Україна 💾"}]'])],['public.cars.jsonb',new Blob(['[]'])]]);
  const archive=Buffer.from(await (await files.zipFiles(source)).arrayBuffer());let offset=0;
  for(const [name,blob] of source){
    assert.equal(archive.readUInt32LE(offset),0x04034b50);const n=archive.readUInt16LE(offset+26),size=archive.readUInt32LE(offset+18);
    assert.equal(archive.subarray(offset+30,offset+30+n).toString(),name);
    const data=archive.subarray(offset+30+n,offset+30+n+size);assert.equal(data.toString(),await blob.text());
    let crc=-1;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}assert.equal(archive.readUInt32LE(offset+14),(crc^-1)>>>0);
    offset+=30+n+size;
  }
  assert.equal(archive.readUInt32LE(offset),0x02014b50);assert.equal(archive.readUInt32LE(archive.length-22),0x06054b50);assert.equal(archive.readUInt16LE(archive.length-14),2);
});
test('feature uses read-only transport, current-session credentials, no privileged key, mutations or local persistence',()=>{
  for(const name of ['core','files','ui']){
    const source=fs.readFileSync(`src/ts/roboha/nalachtuvannay/export/${name}.ts`,'utf8');
    assert.doesNotMatch(ts.transpileModule(source,{compilerOptions:{removeComments:true}}).outputText,/supabase\.from\(|\.insert\(|\.update\(|\.delete\(|localStorage|indexedDB|service_role/i);
  }
  const ui=fs.readFileSync('src/ts/roboha/nalachtuvannay/export/ui.ts','utf8');assert.match(ui,/method: "GET"/);assert.match(ui,/verifyRoleIntegrity/);assert.match(ui,/userAccessLevel !== "Адміністратор"/);
  assert.match(ui,/rpc\("traffic_export_page"/);
  const sql=fs.readFileSync("supabase/migrations/20261006020000_traffic_export_pages.sql","utf8");
  assert.match(sql,/stable security invoker/);
  assert.doesNotMatch(sql,/security definer|insert into|update public|delete from/i);
  const settings=fs.readFileSync('src/ts/roboha/nalachtuvannay/nalachtuvannay.ts','utf8');
  assert.equal((settings.match(/id="export-database-button"/g)||[]).length,1);assert.match(settings,/<\/label>\s*<\/div>\s*<div class="database-export-control" hidden>/);
});

test('file integrity manifest covers exact written UTF-8 bytes and detects corruption',async()=>{
 const input=reader(['{"act_id":1,"name":"Їжак"}']),target=transactionalTarget();
 const report=await core.exportTable(table,input.read,target,signal(),()=>{});
 const bytes=Buffer.from(target.saved.get('public.acts.jsonb'),'utf8');let offset=0;
 const digest=b=>require('node:crypto').createHash('sha256').update(b).digest('hex');
 for(const chunk of report.fileIntegrity.chunks){assert.equal(digest(bytes.subarray(offset,offset+chunk.bytes)),chunk.hash);offset+=chunk.bytes;}
 assert.equal(offset,bytes.length);assert.equal(report.fileIntegrity.hash,digest(JSON.stringify(report.fileIntegrity.chunks)));
 const first=report.fileIntegrity.chunks[0];bytes[0]^=1;assert.notEqual(digest(bytes.subarray(0,first.bytes)),first.hash);
});

test('local export verifier detects altered and appended bytes',async()=>{
 const os=require('node:os'),path=require('node:path'),fsp=require('node:fs/promises');
 const {verifyExportFile}=require('../scripts/verify-export-files.cjs');
 const folder=await fsp.mkdtemp(path.join(os.tmpdir(),'sto-integrity-'));
 const input=reader(['{"act_id":1}']),target=transactionalTarget();
 const report=await core.exportTable(table,input.read,target,signal(),()=>{});
 const file=path.join(folder,report.file),text=target.saved.get(report.file);
 try {await fsp.writeFile(file,text);await verifyExportFile(folder,report);
  await fsp.appendFile(file,'x');await assert.rejects(verifyExportFile(folder,report),/length/);
  await fsp.writeFile(file,text.replace('act_id','bad_id'));await assert.rejects(verifyExportFile(folder,report),/checksum/);
 } finally {await fsp.unlink(file);await fsp.rmdir(folder);}
});
