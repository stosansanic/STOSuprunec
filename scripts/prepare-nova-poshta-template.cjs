// Portable, secret-free installation kit for new STO projects.
const fs = require('node:fs');
const path = require('node:path');
const { buildDatabaseSQL, buildUpdateSQL, buildFunction } = require('./prepare-nova-poshta-dashboard.cjs');
const root = path.resolve(__dirname, '..');
const destination = path.resolve(process.argv[2] || path.join(root, 'errorSTO/template-update-prepared/nova-poshta'));
fs.mkdirSync(destination, { recursive: true });
const files = {
  '9 Нова пошта база.sql': '-- NEW STO PROJECT: run after the base STO schema. SQL Editor only.\n' + buildDatabaseSQL(),
  '9.1 Нова пошта index.ts': buildFunction(),
  '9.2 Нова пошта інструкція.md': fs.readFileSync(path.join(root, 'docs/nova-poshta-template.md'), 'utf8'),
  '9.3 Нова пошта створити ключ.ps1': `# Run once per NEW project. Output is saved locally, never printed.
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9]{20}$')][string]$ProjectRef)
$secretFile = Join-Path $PSScriptRoot ("nova-poshta-" + $ProjectRef + ".secrets.env")
if (Test-Path -LiteralPath $secretFile) { throw "Key file already exists. Preserve the existing encryption key." }
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$key = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
$stream = [System.IO.File]::Open($secretFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
try {
  $content = [System.Text.Encoding]::ASCII.GetBytes("NP_ENCRYPTION_KEY=" + $key + [Environment]::NewLine)
  $stream.Write($content, 0, $content.Length)
} finally { $stream.Dispose(); [Array]::Clear($bytes, 0, $bytes.Length); $key = $null }
Write-Host "Key saved locally. Add NP_ENCRYPTION_KEY to Supabase Edge Functions Secrets. Do not share this file."
`,
  '9.4 Нова пошта оновити наявну.sql': buildUpdateSQL(),
};
for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(destination, name), content);
console.log(`Prepared ${Object.keys(files).length} files: ${destination}`);
