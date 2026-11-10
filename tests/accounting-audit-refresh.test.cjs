const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function fixture(response){
 const source=fs.readFileSync('src/ts/roboha/bukhhalteriya/bukhhalteriya.ts','utf8'),ast=ts.createSourceFile('a.ts',source,99,true);
 const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='updateAuditTable');
 const container={innerHTML:'',replaceChildren(node){this.node=node}},ctx={auditRawData:[{action:'old'}],byId:()=>container,populateAuditUserFilter(){},populateAuditRoleFilter(){},renderAuditRows(){},document:{createElement:()=>({})}};
 const chain={select:()=>chain,order:()=>chain,limit:async()=>response};ctx.supabase={from:()=>chain};vm.createContext(ctx);vm.runInContext(ts.transpileModule(fn.getText(ast),{compilerOptions:{target:99}}).outputText,ctx);return {ctx,container};
}
test('empty audit refresh clears stale filter source',async()=>{const {ctx,container}=fixture({data:[]});await ctx.updateAuditTable();assert.equal(ctx.auditRawData.length,0);assert.match(container.innerHTML,/Логів поки немає/);});
test('audit failure clears stale rows and treats server message as text',async()=>{const {ctx,container}=fixture({error:{message:'<img src=x onerror=alert(1)>'}});await ctx.updateAuditTable();assert.equal(ctx.auditRawData.length,0);assert.match(container.node.textContent,/<img/);assert.equal(container.node.innerHTML,undefined);});
test('accounting CSP permits Google loader and Drive frame in addition to Vercel policy',()=>{
 const html=fs.readFileSync('bukhhalteriya.html','utf8');const csp=html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];const policies=[csp,JSON.parse(fs.readFileSync('vercel.json','utf8')).headers.flatMap(x=>x.headers).find(x=>x.key.toLowerCase()==='content-security-policy').value];
 for(const policy of policies){const directives=Object.fromEntries(policy.split(';').map(x=>x.trim().split(/\s+/)).filter(x=>x[0]).map(([name,...values])=>[name,values]));assert.ok(directives['script-src'].includes('https://apis.google.com'));assert.ok(directives['frame-src'].includes('https://content.googleapis.com'));}
});
