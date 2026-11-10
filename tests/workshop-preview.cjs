// Local UI fixture: actual feature modules, in-memory fake DB and OCR; never loads credentials.
const http = require('node:http');
const path = require('node:path');
const esbuild = require('esbuild');
const sass = require('sass');
const mocks = {
  users: 'export let userAccessLevel="Адміністратор", userName="Тестовий майстер"; export async function canUserOpenActs(){return true}; export async function canUserViewActs(){return true}; export async function canUserSeePriceColumns(){return true}; export async function canUserSeeSkladButton(){return true}; export async function getCachedSettingForRole(){return true}',
  aiChat: 'export async function recognizeInvoiceDocument(){return JSON.stringify({supplier:"Тестовий постачальник",number:"ТЕСТ-001",date:"2026-09-26",currency:"UAH",total:"500",lines:[{catno:"00042",detail:"Фільтр масляний",qty:"2",price:"250",unit:"штук",warning:"Звірте артикул"}]})}',
  modalMain: 'export async function showModal(id){document.getElementById("test-output").textContent="Відкрито тестовий акт №"+id}',
  supabaseClient: [
    'const db={acts:[{act_id:1,cars_id:5,pruimalnyk:"Тестовий майстер",date_off:null,date_on:"2026-09-01",slusarsOn:true,data:{__act_revision:"r1",Роботи:[{Робота:"Перевірка",Кількість:1,Ціна:0}],Деталі:[],Рекомендації:"Перевірити систему охолодження",__workshop_v1:{version:1,defects:[{id:"d1",assembly:"Блок двигуна",component:"Циліндр №1",before:"80,41 мм",after:"",tolerance:"За ремонтною документацією",finding:"Зношення поверхні",operation:"Гільзування циліндра",photoUrl:"",state:"repair",author:"Тестовий майстер",updatedAt:"2026-09-26T10:00:00Z"}],recommendations:[]}}},{act_id:2,cars_id:5,pruimalnyk:"Тестовий майстер",date_off:"2026-08-01",data:{__workshop_v1:{version:1,defects:[],recommendations:[{id:"r2",text:"Замінити ремінь",state:"approved",author:"Тестовий майстер",updatedAt:"2026-08-01T10:00:00Z"}]}}}],sclad:[],post_arxiv:[]};',
    'export const supabase={from(table){let payload=null,filters=[],offset=0,end=Infinity; const read=(r,k)=>k.startsWith("data->>")?r.data[k.slice(7)]:r[k]; const q={select(){return q},update(p){payload=p;return q},eq(k,v){filters.push(r=>read(r,k)===v);return q},neq(k,v){filters.push(r=>read(r,k)!==v);return q},is(k,v){filters.push(r=>(read(r,k)??null)===v);return q},in(){return q},gte(){return q},lt(){return q},like(){return q},limit(n){end=n-1;return q},order(){return q},range(a,b){offset=a;end=b;return q},abortSignal(){return q},single(){return q.then(x=>({data:x.data[0],error:null}))},then(resolve,reject){try{const rows=(db[table]||[]).filter(r=>filters.every(f=>f(r))).slice(offset,end+1);if(payload)rows.forEach(r=>Object.assign(r,structuredClone(payload)));return Promise.resolve({data:structuredClone(rows),error:null}).then(resolve,reject)}catch(e){return Promise.reject(e).then(resolve,reject)}}};return q}};',
  ].join('\n'),
};
const entry = [
  'import {openWorkshop} from "./src/ts/roboha/workshop/workshopUI";',
  'import {openInvoiceRecognition} from "./src/ts/roboha/workshop/invoiceUI";',
  'import {openAttentionOverview} from "./src/ts/roboha/workshop/attentionUI";',
  'document.getElementById("defects").onclick=()=>openWorkshop(1);',
  'document.getElementById("recommendations").onclick=()=>openWorkshop(1,"recommendations",async name=>{document.getElementById("test-output").textContent="Рядок підготовлено: "+name});',
  'document.getElementById("attention").onclick=()=>openAttentionOverview();',
  'document.getElementById("invoice").onclick=async()=>{await openInvoiceRecognition(async rows=>{document.getElementById("test-output").textContent="Перевірені рядки: "+JSON.stringify(rows)},()=>["Фільтр масляний","Фільтр інший"]);const input=document.querySelector("dialog input[type=file]");const dt=new DataTransfer();dt.items.add(new File(["test"],"fixture.png",{type:"image/png"}));input.files=dt.files;};',
].join('\n');
(async()=>{
 const result=await esbuild.build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',plugins:[{name:'fixture-mocks',setup(build){
  build.onResolve({filter:/\/(users|supabaseClient|aiChat|modalMain)$/},args=>({path:path.basename(args.path),namespace:'fixture'}));
  build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:mocks[args.path],loader:'js'}));
 }}]});
 const css=sass.compile('src/scss/robocha/_workflows.scss').css;
 const page='<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>Тест нових функцій — без робочої бази</title><body style="font:16px system-ui;background:#edf3f0;padding:16px"><h1>Тестовий стенд</h1><p>Дані вигадані. База та OCR лише в пам’яті тесту.</p><button id="defects">Дефектування</button><button id="recommendations">Рекомендації</button><button id="invoice">Накладна</button><button id="attention">Огляд Атласа</button><p id="test-output"></p><script type="module" src="/app.js"></script></body></html>';
 const server=http.createServer((req,res)=>{
  const key=req.url.split('?')[0];
  res.setHeader('Content-Type',key==='/app.js'?'text/javascript; charset=utf-8':key==='/style.css'?'text/css; charset=utf-8':'text/html; charset=utf-8');
  res.end(key==='/app.js'?result.outputFiles[0].text:key==='/style.css'?css:key==='/phone'?'<html><meta charset="utf-8"><body><iframe title="Телефон 390px" width="390" height="820" src="/"></iframe></body></html>':page);
 });
 server.listen(5201,'127.0.0.1',()=>console.log('UI fixture http://127.0.0.1:5201 and /phone; no production network.'));
})();
