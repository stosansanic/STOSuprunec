const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');
const {PGlite}=require(process.env.STO_PGLITE_MODULE||'@electric-sql/pglite');
function browser(){const ctx={exports:{},require:()=>({}),Date,parseSmartSearch:()=>[],updateSmartSearchHint:()=>{}};vm.createContext(ctx);
 vm.runInContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/tablucya/smartSearch.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,ctx);
 const file='src/ts/roboha/tablucya/tablucya.ts',ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),99,true);
 const names=['safeParseJSON','normalizeRecordId','getTextValue','getCarDisplayName','getClientInfo','getCarInfo','getActAmount','getActDiscount','getActDateAsDate','isActClosed','formatDate','parseSearchTerm','filterActs'];
 const source=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast)).join(';');
 vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,ctx);ctx.parseSmartSearch=()=>[];return ctx;
}
test('smart search SQL agrees with browser predicates for every smart-filter family and legacy JSON',async()=>{
 const db=new PGlite();try{
 await db.exec('create role anon;create role authenticated;create table cars(cars_id bigint,client_id bigint,data jsonb,is_deleted boolean);create table clients(client_id bigint,data jsonb);create table acts(act_id bigint primary key,client_id bigint,cars_id bigint,date_on timestamptz,date_off timestamptz,data jsonb,pruimalnyk text,"slusarsOn" boolean)');
 for(const name of ['20261005100000_traffic_service_book.sql','20261005110000_traffic_act_read_models.sql','20261011040000_traffic_act_search.sql'])await db.exec(fs.readFileSync('supabase/migrations/'+name,'utf8'));
 const b=browser();const client={client_id:1,data:{ПІБ:'Іваненко Петро',Телефон:'+38 (050) 111-22-33'}};
 const car={cars_id:1,data:{Марка:'BMW',Модель:'X5','Номер авто':'АВ 1234 КК'}};
 const rows=[{act_id:12,client_id:1,cars_id:1,date_on:'2026-10-11T09:00:00Z',date_off:null,avans:100,pruimalnyk:'Богдан',contrAgent_raxunok:54,contrAgent_act:88,data:{'Загальна сума':'1500.5',Знижка:10,Роботи:[{Робота:'Заміна масла',Слюсар:'Василь'}],Деталі:[{Деталь:'Фільтр'}],Рекомендації:'Гальма','Причина звернення':'Стук',Примітки:'Тест'}},
 {act_id:99,client_id:1,cars_id:1,date_on:'2025-01-01T00:00:00Z',date_off:'2025-01-02T00:00:00Z',rosraxovano:'yes',data:JSON.stringify({amount:'0x20',Роботи:[{Назва:'Ремонт'}],Деталі:[{Назва:'Болт'}]})},
 {act_id:102,client_id:2,cars_id:2,date_on:null,data:{'Загальна сума':0,total:'0',Авто:'Toyota','Номер авто':'АК0001'}},
 {act_id:103,client_id:1,cars_id:1,info:'{}',data:{amount:999}},
 {act_id:104,client_id:1,cars_id:1,info:'',data:{amount:'broken'}},
 {act_id:105,client_id:1,cars_id:1,data:false,details:{amount:25}},
 {act_id:106,client_id:1,cars_id:1,data:{Роботи:[{Робота:false,Назва:'Ремонт'}],Деталі:[{Деталь:0,Назва:'Болт'}]}}];
 const filters=[{type:'act',value:'12'},{type:'pib',value:'ІВАН'},{type:'phone',value:'050111'},
 {type:'car',value:'bmw'},{type:'carNumber',value:'АВ1234'},{type:'date',value:'',dateFrom:new Date('2026-10-01Z'),dateTo:new Date('2026-10-31Z')},
 ...['>=','<=','>','<','='].map(amountOp=>({type:'amount',value:'',amountOp,amountVal:32})),
 ...['open','closed','paid','unpaid','withAdvance','withDiscount'].map(value=>({type:'status',value})),
 {type:'work',value:'масла'},{type:'detail',value:'фільтр'},{type:'raxunok',value:'54'},{type:'actDoc',value:'88'},{type:'slusar',value:'вас'},{type:'pruimalnyk',value:'бог'},
 ...['Іван','1234','ремонт','болт','гальма','стук','тест','54','88','no match'].map(value=>({type:'text',value}))];
 for(const row of rows)for(const filter of filters){
  const expected=b.exports.applySmartFilters([row],[filter],[client],[car],b).length>0;
  const actual=(await db.query('select traffic_act_search_match($1,$2,$3,$4) v',[JSON.stringify(row),JSON.stringify(row.client_id===1?client.data:{}),JSON.stringify(row.cars_id===1?car.data:{}),JSON.stringify([filter])])).rows[0].v;
  assert.equal(actual,expected,JSON.stringify({row:row.act_id,filter}));
 }
 for(const row of rows)for(const [key,value] of [['акт','12'],['сума','-1.2x'],['сума','1e2tail'],['дата','11.10'],['тел','050111'],['піб','ІВАН'],['машина','BMW'],['номер','1234'],['','ремонт'],['','1500'],['','СФ-54'],['','ОУ-'],['','no match']]){
  const query=key?key+':'+value:value;const expected=b.filterActs([row],query,[client],[car]).length>0;
  const filters=[{type:'legacy',key,value,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}];
  const actual=(await db.query('select traffic_act_search_match($1,$2,$3,$4) v',[JSON.stringify(row),JSON.stringify(row.client_id===1?client.data:{}),JSON.stringify(row.cars_id===1?car.data:{}),JSON.stringify(filters)])).rows[0].v;
  assert.equal(actual,expected,JSON.stringify({row:row.act_id,key,value}));
 }
 await db.exec("insert into acts select n,1,1,'2026-10-11',null,jsonb_build_object('Роботи',jsonb_build_array(jsonb_build_object('Робота',case when n=1 then 'Last match' else 'Other' end))),'Admin',false from generate_series(1,1005) n");
 const result=(await db.query("select traffic_act_search_page(null,null,'open',$1,0,'id') v",[JSON.stringify([{type:'work',value:'Last match'}])])).rows[0].v;
 assert.equal(result.items.length,1);assert.equal(result.items[0].act_id,1);assert.equal(result.total,1005);assert.equal(result.matched,1);assert.equal(result.items[0].data.Роботи,undefined);
 const all=(await db.query("select traffic_act_search_page(null,null,'open','[]',0,'id') v")).rows[0].v;
 assert.equal(all.items.length,50);assert.equal(all.items[0].act_id,1005);assert.equal(all.next_offset,50);assert.equal(all.has_more,true);
 await db.exec("update acts set date_off='2026-10-12' where act_id=1;update acts set data=jsonb_set(data,'{Заморожений}','true') where act_id=2");
 for(const [mode,count]of [['open',1003],['closed',1],['frozen',1]]){
  const page=(await db.query("select traffic_act_search_page(null,null,$1,'[]',0,'id') v",[mode])).rows[0].v;assert.equal(page.matched,count,mode);
 }
 await db.exec("create table act_changes_notifications(act_id bigint,delit boolean,pruimalnyk text);insert into act_changes_notifications values (1,false,'A'),(1,false,'A'),(2,false,'B'),(1,true,'A')");
 assert.deepEqual((await db.query("select traffic_act_notification_counts(array[1,2]::bigint[],'A') v")).rows[0].v,[{act_id:1,count:2}]);
 await db.exec("grant select on acts,clients,cars,act_changes_notifications to authenticated;alter table acts enable row level security;create policy limited_acts on acts for select to authenticated using(act_id=1);set role authenticated");
 const restricted=(await db.query("select traffic_act_search_page(null,null,'closed','[]',0,'id') v")).rows[0].v;
 assert.equal(restricted.matched,1);assert.equal(restricted.items[0].act_id,1);
 assert.equal((await db.query("select traffic_act_search_page(null,null,'open','[]',0,'id') v")).rows[0].v.matched,0);
 await db.exec('reset role');
 // Every page retains global matching/counts; dates and sort apply before LIMIT.
 const ids=[];
 for(let offset=0;offset<1003;offset+=50){
  const p=(await db.query("select traffic_act_search_page(null,null,'open','[]',$1,'id') v",[offset])).rows[0].v;
  ids.push(...p.items.map(a=>a.act_id));assert.equal(p.matched,1003);assert.equal(p.total,1003);
  assert.equal(p.has_more,offset+50<1003);assert.equal(p.next_offset,offset+50<1003?offset+50:null);
 }
 assert.equal(ids.length,1003);assert.equal(new Set(ids).size,1003);assert.equal(ids.at(-1),3);
 await db.exec("update acts set date_on='2026-10-11T15:30:00Z' where act_id=3;update acts set date_on=null where act_id=4;update acts set date_off='2026-10-13' where act_id=5");
 const read=async(mode,sort,from=null,to=null)=>(await db.query('select traffic_act_search_page($1,$2,$3,\'[]\',0,$4) v',[from,to,mode,sort])).rows[0].v;
 assert.equal((await read('open','created')).items[0].act_id,3);
 assert.equal((await read('closed','closed')).items[0].act_id,5);
 const exact=await read(null,'id','2026-10-11T15:30:00Z','2026-10-11T15:30:00Z');
 assert.deepEqual(exact.items.map(a=>a.act_id),[3]);assert.equal(exact.total,1);
 const mixed=await read(null,'closed','2026-10-10T00:00:00Z','2026-10-12T00:00:00Z');
 assert.deepEqual(mixed.items.slice(0,2).map(a=>a.act_id),[5,1]);
 const openFirst=await read(null,'open','2026-10-10T00:00:00Z','2026-10-12T00:00:00Z');
 assert.ok(openFirst.items.every(a=>a.date_off===null));
 }finally{await db.close()}
});
