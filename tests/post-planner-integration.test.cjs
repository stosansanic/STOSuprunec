const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const source = fs.readFileSync('src/ts/roboha/planyvannya/planyvannya.ts', 'utf8');
const wanted = new Set(['openAddPostModal', 'applyPostDirectoryReceipt', 'renderPostStructurePreservingBookings', 'loadAssignedStaffBookings', 'createAndPersistPlannerPost']);
const ast = ts.createSourceFile('planner.ts', source, ts.ScriptTarget.Latest, true);
const methods = [];
function visit(n) { if (ts.isMethodDeclaration(n) && wanted.has(n.name.getText(ast))) methods.push(n.getText(ast)); else ts.forEachChild(n, visit); }
visit(ast);
function fixture() {
  let actor = 'admin'; const calls = [], api = {}, state = {};
  state.receipt = { status: 'created', category: {category_id: 3, category: 'Цех'}, post: {post_id: 5, name: 'Пост', category: 3}, staff: {slyusar_id: 9, name: 'Петро', namber: 1.1, post_sluysar: '5'} };
  const supabase = { rpc: async (name, args) => { calls.push(['rpc', name, args]); return state.response ? state.response() : {data: state.receipt}; }, from() { throw Error('Unexpected broad table query'); } };
  const read = async (...args) => { calls.push(['read', ...args]); return state.read ? state.read(...args) : []; };
  vm.runInNewContext(ts.transpileModule('export class Probe {' + methods.join('\n') + '}', {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText, {
    exports: api, supabase, readPlannerBookings: read, localStorage: {getItem: () => actor}, showNotification: (...args) => calls.push(['notification', ...args]),
    plannerDateKey: date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`, Date, Map, Set, Number, Array,
  });
  const app = new api.Probe();
  Object.assign(app, { sections: [], postTitleToIdMap: new Map(), slyusarNameToIdMap: new Map(), staffNames: new Map(), initialPositions: [], initialPostCategories: new Map(), deletedSlyusarIds: [], monthOccupancyStats: new Map(),
    calendarGrid: {querySelector: () => null, querySelectorAll: () => []}, isWeekView: false, selectedDate: new Date(2026, 9, 21),
    renderSections: () => calls.push(['structure-day']), renderWeekView: () => calls.push(['structure-week']), paintOccupancyIndicators: () => calls.push(['paint']),
    renderMiniCalendar: () => {throw Error('Unexpected occupancy fetch');}, renderCurrentView: () => {throw Error('Unexpected whole-calendar fetch');},
    renderWeekArxivRecord: row => calls.push(['week-row', row]), postArxiv: {applyRecordChange: change => calls.push(['day-row', change])},
    getWeekDays: date => Array.from({length: 7}, (_, i) => new Date(date.getFullYear(), date.getMonth(), 19+i)),
  });
  return { app, calls, state, setActor: next => actor = next };
}
const input = {cehTitle: 'Цех', title: 'Пост', subtitle: 'Петро', staffId: 9, actor: 'admin', categoryId: 3, postId: 5};

test('assignment is one atomic RPC and only reads the new worker current day', async () => {
  const {app, calls} = fixture(); await app.createAndPersistPlannerPost(input);
  assert.equal(calls.filter(x => x[0] === 'rpc').length, 1);
  assert.equal(calls[0][1], 'traffic_planner_post_assign');
  assert.deepEqual({...calls[0][2]}, {p_category:'Цех',p_post:'Пост',p_staff_name:'Петро',p_staff_id:9,p_namber:1.1,p_category_id:3,p_post_id:5});
  const read = calls.find(x => x[0] === 'read'); assert.equal(read[1], '2026-10-21T00:00:00'); assert.equal(read[2], '2026-10-21T23:59:59'); assert.deepEqual([...read[3]], [9]);
  assert.equal(app.sections[0].posts[0].postId, 5); assert.equal(app.staffNames.get(9), 'Петро');
});

test('repeated receipt does not duplicate row, baseline or booking reads', async () => {
  const {app, calls, state} = fixture(); await app.createAndPersistPlannerPost(input);
  calls.length=0; state.receipt.status='unchanged'; await app.createAndPersistPlannerPost(input);
  assert.equal(app.sections.length,1); assert.equal(app.sections[0].posts.length,1); assert.equal(app.initialPositions.length,1);
  assert.equal(calls.filter(x => x[0] === 'read' || x[0].startsWith('structure')).length,0);
});

test('assignment failure never creates a phantom local row', async () => {
  const {app,state,calls} = fixture(); state.response=()=>({error:{code:'PGRST202',message:'missing'}});
  await assert.rejects(app.createAndPersistPlannerPost(input), /post-modal-repair/);
  assert.equal(app.sections.length,0); assert.equal(calls.filter(x=>x[0]==='read').length,0);
});

test('invalid receipt does not add unconfirmed identifiers', async () => {
  const {app,state} = fixture(); state.receipt.staff.post_sluysar='55';
  await assert.rejects(app.createAndPersistPlannerPost(input), /перевірити відповідь/); assert.equal(app.sections.length,0);
});

test('actor changed before save causes zero writes', async () => {
  const {app,calls,setActor}=fixture(); setActor('other'); await assert.rejects(app.createAndPersistPlannerPost(input), /Користувач/); assert.equal(calls.length,0);
});

test('actor changed during successful save does not alter another actor calendar', async () => {
  const {app,calls,state,setActor}=fixture(); state.response=()=>{setActor('other');return {data:state.receipt};};
  await app.createAndPersistPlannerPost(input); assert.equal(app.sections.length,0); assert.equal(calls.length,1);
});

test('directory rename uses IDs for identically named posts and preserves booking history', () => {
  const {app,calls}=fixture();
  app.sections=[{id:1,realCategoryId:'3',name:'Цех',posts:[{id:9,postId:5,title:'Однаковий'}]}, {id:2,realCategoryId:'4',name:'Цех 2',posts:[{id:10,postId:6,title:'Однаковий'}]}];
  const labels = new Map(); app.calendarGrid.querySelector = selector => { if(!labels.has(selector)) labels.set(selector,{textContent:''}); return {querySelector:()=>labels.get(selector)}; };
  const booking={name_post:5,slyusar_id:9,status:'Відремонтований'};
  app.applyPostDirectoryReceipt({status:'updated',category:{category_id:3,category:'Новий цех'},post:{post_id:5,name:'Новий пост',category:3}});
  assert.equal(app.sections[0].name,'Новий цех'); assert.equal(app.sections[1].name,'Цех 2');
  assert.equal(app.sections[0].posts[0].title,'Новий пост'); assert.equal(app.sections[1].posts[0].title,'Однаковий');
  assert.deepEqual(booking,{name_post:5,slyusar_id:9,status:'Відремонтований'}); assert.equal(calls.length,0);
  assert.ok([...labels.values()].some(x=>x.textContent==='Новий пост'));
});

test('deleting unused directory only removes its cached ID mapping', () => {
  const {app,calls}=fixture(); app.postTitleToIdMap.set('Пост',5); app.postTitleToIdMap.set('Other',6);
  app.applyPostDirectoryReceipt({status:'deleted',category:{category_id:3,category:'Цех'},post:{post_id:5,name:'Пост',category:3}});
  assert.equal(app.postTitleToIdMap.has('Пост'),false); assert.equal(app.postTitleToIdMap.get('Other'),6); assert.equal(calls.length,0);
});

for (const week of [false,true]) test(`structure rebuild preserves ${week?'week':'day'} booking nodes, listeners and historical name_post`, () => {
  const {app}=fixture(); app.isWeekView=week; let removed=0; const attached=[];
  const block={dataset:{slyusarId:'9',date:'2026-10-21',namePost:'2',postArxivId:'88'},listener:()=>42,remove(){removed++;}};
  app.calendarGrid.querySelectorAll=()=>[block]; app.calendarGrid.querySelector=selector=>({appendChild: node=>attached.push([selector,node])});
  app.renderPostStructurePreservingBookings(); assert.equal(removed,1); assert.equal(attached[0][1],block); assert.equal(block.listener(),42); assert.equal(block.dataset.namePost,'2'); assert.match(attached[0][0],/data-slyusar-id="9"/);
});

test('worker week read is scoped and renders original booking name_post', async () => {
  const {app,state,calls}=fixture(); app.isWeekView=true;
  state.read=()=>[{post_arxiv_id:88,slyusar_id:9,name_post:2,client_id:3,cars_id:4,client_data:{ПІБ:'Клієнт'},car_data:{Авто:'Ford'}}];
  await app.loadAssignedStaffBookings(9,'admin'); const read=calls.find(x=>x[0]==='read'); assert.equal(read[1],'2026-10-19T00:00:00'); assert.equal(read[2],'2026-10-25T23:59:59'); assert.deepEqual([...read[3]],[9]); assert.equal(calls.find(x=>x[0]==='week-row')[1].name_post,2);
});

test('late scoped booking reply is ignored after date changes', async () => {
  const {app,state,calls}=fixture(); state.read=()=>{app.selectedDate=new Date(2026,9,22);return [{post_arxiv_id:1,slyusar_id:9}];};
  await app.loadAssignedStaffBookings(9,'admin'); assert.equal(calls.filter(x=>x[0]==='day-row').length,0);
});

test('booking read failure does not turn committed assignment into failed write', async () => {
  const {app,state,calls}=fixture(); state.read=()=>{throw Error('offline');}; await app.createAndPersistPlannerPost(input);
  assert.equal(app.sections[0].posts.length,1); assert.equal(calls.filter(x=>x[0]==='rpc').length,1); assert.ok(calls.some(x=>x[0]==='notification'&&x[2]==='warning'));
});

test('directory callback is tied to modal opening actor', () => {
  const {app,setActor}=fixture(); let callback; app.postModal={open:(save,prefill,onChange)=>{callback=onChange;assert.equal(prefill,'Цех');}};
  let applied=0;app.applyPostDirectoryReceipt=()=>applied++;app.openAddPostModal('Цех');callback({});assert.equal(applied,1);setActor('other');callback({});assert.equal(applied,1);
});

test('new row in collapsed section does not trigger invisible booking reads', async () => {
  const {app,calls}=fixture();app.sections=[{id:1,realCategoryId:'3',name:'Цех',collapsed:true,posts:[]}];await app.createAndPersistPlannerPost(input);assert.equal(calls.filter(x=>x[0]==='read').length,0);
});

test('equal category names use the explicitly selected category to calculate row order', async () => {
  const {app,calls}=fixture();
  app.sections=[{id:1,realCategoryId:'4',name:'Цех',posts:[{id:2,postId:7,title:'Інший'}]}, {id:2,realCategoryId:'3',name:'Цех',posts:[]}];
  await app.createAndPersistPlannerPost(input);
  assert.equal(calls.find(x=>x[0]==='rpc')[2].p_namber,2.1);
  assert.equal(app.sections[0].posts.length,1); assert.equal(app.sections[1].posts[0].id,9);
});

for (const [name, mutate] of [
  ['category', receipt=>{receipt.category.category_id=33;receipt.post.category=33;}],
  ['post', receipt=>{receipt.post.post_id=55;receipt.staff.post_sluysar='55';}],
  ['staff', receipt=>{receipt.staff.slyusar_id=99;}],
]) test(`receipt with another explicitly selected ${name} is rejected before rendering`, async () => {
  const {app,state,calls}=fixture(); mutate(state.receipt);
  await assert.rejects(app.createAndPersistPlannerPost(input), /перевірити відповідь/);
  assert.equal(app.sections.length,0); assert.equal(calls.filter(x=>x[0].startsWith('structure')||x[0]==='read').length,0);
});

for (const method of ['applyPostDirectoryReceipt','renderPostStructurePreservingBookings','paintOccupancyIndicators']) {
  test(`committed assignment remains successful if ${method} throws`, async () => {
    const {app,calls}=fixture(); app[method]=()=>{throw Error('DOM failed');};
    await assert.doesNotReject(app.createAndPersistPlannerPost(input));
    assert.equal(calls.filter(x=>x[0]==='rpc').length,1);
    assert.ok(calls.some(x=>x[0]==='notification'&&x[2]==='warning'&&x[1].includes('Пост збережено')));
  });
}
