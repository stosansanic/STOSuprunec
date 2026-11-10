const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(supabase) {
  const module = { exports: {} };
  const source = fs.readFileSync('src/ts/roboha/zakaz_naraudy/actStaffHistory.ts', 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText, { module, exports: module.exports, require: () => ({ supabase }) });
  return module.exports.readActStaffHistory;
}
const result = (id, has_more = false) => ({ data: {
  items: [{ slyusar_id: id, data: { Name: String(id) } }], has_more, next_cursor: id,
}, error: null });

test('same act joins a pending read and caches; another act/generation reads separately', async () => {
  const calls = []; let finish;
  const read = load({ rpc: async (_name, args) => {
    calls.push(args); if (calls.length === 1) return new Promise(resolve => { finish = resolve; });
    return result(args.p_act_id);
  } });
  const first = read(1,0), second = read(1,0);
  assert.equal(calls.length,1); finish(result(1));
  const [a,b] = await Promise.all([first,second]); assert.equal(a,b);
  assert.equal(await read(1,0),a); assert.equal(calls.length,1);
  await read(2,0); await read(2,1); assert.equal(calls.length,3);
});

test('force read after mutation cannot reuse or be replaced by older pending result', async () => {
  const resolves = [];
  const read = load({ rpc: () => new Promise(resolve => resolves.push(resolve)) });
  const older = read(1,0), fresh = read(1,0,true);
  assert.equal(resolves.length,2);
  resolves[1](result(2)); const latest = await fresh;
  resolves[0](result(1)); await older;
  assert.equal(await read(1,0), latest);
});

test('pages preserve all staff and cursor errors are not cached', async () => {
  const calls = [];
  const read = load({ rpc: async (_name,args) => {
    calls.push(args.p_after); return result(args.p_after === null ? 200 : 201, args.p_after === null);
  } });
  const rows = await read(1,0);
  assert.equal(rows.length,2); assert.deepEqual(calls,[null,200]);
  let tries = 0;
  const invalid = load({ rpc: async () => { tries++; return result(0,true); } });
  await assert.rejects(invalid(1,0),/Invalid staff cursor/);
  await assert.rejects(invalid(1,0),/Invalid staff cursor/);
  assert.equal(tries,4);
});

test('permission failure propagates without broad fallback and retry is possible', async () => {
  let tries = 0;
  const read = load({ rpc: async () => {
    if (++tries === 1) return {data:null,error:{code:'42501',message:'denied'}};
    return result(1);
  }, from: () => { throw Error('Forbidden fallback'); } });
  await assert.rejects(read(1,0), error => error.code === '42501');
  assert.equal((await read(1,0)).length,1);
});

test('only missing RPC uses full legacy pages until installation', async () => {
  let queries = 0;
  const read = load({ rpc: async () => ({data:null,error:{code:'PGRST202'}}), from: table => {
    assert.equal(table,'slyusars'); queries++;
    return {select: fields => { assert.equal(fields,'slyusar_id,data'); return {
      order: () => ({range: async () => ({data:[{slyusar_id:1,data:{Name:'A'}}],error:null})}),
    };}};
  }});
  assert.equal((await read(1,0)).length,1); assert.equal(queries,1);
});
