// UI fixture with fake rows and a memory-only directory picker. No production credentials or files.
const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const esbuild=require('esbuild');const sass=require('sass');
const source=fs.readFileSync('src/ts/roboha/nalachtuvannay/nalachtuvannay.ts','utf8');
const section=source.match(/<div class="database-export-control" hidden>[\s\S]*?<\/div>/)[0].replace(' hidden','');
const entry=`import {openDatabaseExport} from './src/ts/roboha/nalachtuvannay/export/ui';
const files=new Map();
const directory={name:'Тестова папка (тільки пам’ять)',async getDirectoryHandle(){return this},async getFileHandle(name){return {async createWritable(){let text='';return {async write(t){text+=t},async close(){files.set(name,text);document.getElementById('output').textContent='Файли в тестовій пам’яті: '+[...files.keys()].join(', ')},async abort(){}}}}}};
Object.defineProperty(window,'showDirectoryPicker',{value:async()=>directory,configurable:true});
document.getElementById('export-database-button').onclick=openDatabaseExport;
document.getElementById('zip-mode').onclick=()=>{Object.defineProperty(window,'showDirectoryPicker',{value:undefined});openDatabaseExport()};`;
(async()=>{
 const bundle=await esbuild.build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',plugins:[{name:'mock',setup(build){
   build.onResolve({filter:/\/(users|supabaseClient|project\.config)$/},args=>({path:path.basename(args.path),namespace:'mock'}));
   build.onLoad({filter:/.*/,namespace:'mock'},args=>({loader:'js',contents:args.path==='users'?'export let userAccessLevel="Адміністратор",userName="Тест";export async function verifyRoleIntegrity(){return true}':args.path==='supabaseClient'?'export const supabase={auth:{async getSession(){return {data:{session:{access_token:"fake-token"}}}}}}':'export const SUPABASE_CONFIG={url:location.origin,anonKey:"fake-anon"}'}));
 }}]});
 const css=sass.compile('src/scss/robocha/_workflows.scss').css+sass.compile('src/scss/robocha/nalachtuvannay/_nalachtuvannay.scss').css;
 const server=http.createServer((req,res)=>{
   const url=new URL(req.url,'http://127.0.0.1:5202');
   if(req.method!=='GET'){res.writeHead(405);res.end();return;}
   if(url.pathname.startsWith('/rest/v1/')){
     res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
     if(url.pathname==='/rest/v1/'){res.end(JSON.stringify({paths:{'/acts':{get:{}},'/cars':{get:{}}},definitions:{acts:{properties:{act_id:{description:'<pk/>'},data:{type:'object'}}},cars:{properties:{cars_id:{description:'<pk/>'}}}}}));return;}
     const rows=url.pathname.endsWith('acts')?Array.from({length:503},(_,i)=>({act_id:i+1,data:{Роботи:[{Робота:'Вигадана робота',Сума:100}]}})):[];
     const offset=Number(url.searchParams.get('offset')),limit=Math.min(Number(url.searchParams.get('limit')),100),page=rows.slice(offset,offset+limit);
     res.setHeader('Content-Range',page.length?offset+'-'+(offset+page.length-1)+'/'+rows.length:'*/'+rows.length);res.end(JSON.stringify(page));return;
   }
   res.setHeader('Content-Type',url.pathname==='/app.js'?'text/javascript':url.pathname==='/style.css'?'text/css':'text/html; charset=utf-8');
   res.end(url.pathname==='/app.js'?bundle.outputFiles[0].text:url.pathname==='/style.css'?css:`<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Тест експорту — вигадані дані</title><link rel="stylesheet" href="/style.css"><body style="font:16px system-ui"><div class="modal-settings"><div class="modal-window"><div class="percentage-control">Націнка на запчастини (тест)</div>${section}<button id="zip-mode">Тест ZIP без вибору папки</button><p id="output">Без робочої бази та записів на диск</p></div></div><script type="module" src="/app.js"></script></body></html>`);
 });
 server.listen(5202,'127.0.0.1',()=>console.log('Export UI fixture at http://127.0.0.1:5202 — fake data only'));
})();
