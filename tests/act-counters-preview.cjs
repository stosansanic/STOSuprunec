// Isolated visual fixture: real header markup/styles, no application JS or DB.
// Run npm run build first, then node tests/act-counters-preview.cjs.
// Visit http://127.0.0.1:5199
const http = require('node:http');
const fs = require('node:fs');
const ts = require('typescript');
const builtHtml = fs.readFileSync('dist/main.html', 'utf8');
const css = [...builtHtml.matchAll(/href="(\/assets\/[^\"]+\.css)"/g)]
  .map(match => fs.readFileSync(`dist${match[1]}`, 'utf8')).join('\n');
const source = fs.readFileSync('main.html', 'utf8');
const nav = source.match(/<nav\b[\s\S]*?<\/nav>/)[0]
  .replace('id="menu-items-to-hide" style="display: none;"', 'id="menu-items-to-hide"')
  .replace('style="display: none;" id="menu-item-planyvannya"', 'id="menu-item-planyvannya"')
  .replace('id="dateRangePicker" readonly', 'id="dateRangePicker" value="Відкриті" readonly')
  .replace('class="act-counters" hidden', 'class="act-counters"')
  .replace('class="act-count act-count-open"></span>', 'class="act-count act-count-open">265</span>');
http.createServer((req, res) => {
  if (req.url === '/menu-tooltips.js') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.end(ts.transpileModule(fs.readFileSync('src/ts/utils/menuTooltips.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    }).outputText);
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/frame') {
    res.end(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>
      <body class="page-2">${nav}<div id="act-search-summary">Знайдено 8 із 142</div>
      <script>
        Object.assign(document.getElementById('searchInput').style,{width:'0',padding:'0',opacity:'0',visibility:'hidden'});
        document.getElementById('menu-items-to-hide').scrollLeft=10000;
      </script><script type="module">import {initMenuTooltips} from '/menu-tooltips.js'; initMenuTooltips();</script></body></html>`);
  } else {
    res.end(`<!doctype html><meta charset="utf-8"><style>body{font-family:Arial;background:#eee}iframe{display:block;height:160px;border:1px solid #aaa;margin-bottom:24px}</style>
      <h2>Перевірка лічильників — тестові числа, без бази даних</h2>
      ${[1440, 768, 390, 320].map(width => `<h3>${width} px</h3><iframe width="${width}" src="/frame"></iframe>`).join('')}`);
  }
}).listen(5199, '127.0.0.1', () => console.log('Counter fixture: http://127.0.0.1:5199'));
