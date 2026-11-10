const fs = require('node:fs');
const path = require('node:path');
const { prepare, readProjectUrlFromFiles } = require('./prepare-nova-poshta-dashboard.cjs');

const root = path.resolve(__dirname, '..');
let debounce;
let lastRef = '';

function refresh() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    try {
      const url = readProjectUrlFromFiles();
      if (!url) throw new Error('VITE_SUPABASE_URL ще не знайдено у .env.local або .env');
      const ref = new URL(url).hostname.split('.')[0];
      if (ref === lastRef) return;
      prepare(url);
      lastRef = ref;
      console.log(`Підготовлено файли Нової пошти для Supabase-проєкту ${ref}.`);
    } catch (error) {
      console.error(`Файли Нової пошти не оновлено: ${error.message}`);
    }
  }, 800);
}

console.log('Стежу за .env та .env.local. Зупинка: Ctrl+C.');
refresh();
fs.watch(root, (_event, filename) => {
  if (filename && ['.env', '.env.local'].includes(String(filename))) refresh();
});
