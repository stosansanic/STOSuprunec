// Local verification only; no network or database access.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
async function verifyExportFile(folder, table) {
  if (!/^public\.[a-zA-Z_][a-zA-Z0-9_]*\.jsonb$/.test(table.file || '')) throw Error('Invalid export filename');
  const manifest = table.fileIntegrity;
  if (manifest?.algorithm !== 'sha256-chunk-manifest-v1' || !Array.isArray(manifest.chunks) ||
      digest(JSON.stringify(manifest.chunks)) !== manifest.hash) throw Error('Invalid integrity manifest');
  const file = await fs.open(path.join(path.resolve(folder), table.file), 'r');
  let offset = 0;
  try {
    const buffer = Buffer.alloc(65536);
    for (const chunk of manifest.chunks) {
      if (!Number.isSafeInteger(chunk.bytes) || chunk.bytes < 0 || !/^[a-f0-9]{64}$/.test(chunk.hash)) throw Error('Invalid chunk');
      const hash = createHash('sha256'); let remaining = chunk.bytes;
      while (remaining) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, remaining), offset);
        if (!bytesRead) throw Error('Truncated file');
        hash.update(buffer.subarray(0, bytesRead)); remaining -= bytesRead; offset += bytesRead;
      }
      if (hash.digest('hex') !== chunk.hash) throw Error('File content checksum mismatch');
    }
    if ((await file.stat()).size !== offset || table.bytes !== offset) throw Error('File length mismatch');
  } finally { await file.close(); }
}
module.exports = { verifyExportFile };
if (require.main === module) (async () => {
  const folder = process.argv[2];
  if (!folder) throw Error('Usage: node scripts/verify-export-files.cjs <export-folder>');
  const report = JSON.parse(await fs.readFile(path.join(folder, 'export-report.json'), 'utf8'));
  if (report.status !== 'exported_visible_tables' || !Array.isArray(report.tables)) throw Error('Export is incomplete');
  for (const table of report.tables) {
    if (table.status !== 'exported') throw Error('Table was not exported');
    await verifyExportFile(folder, table);
    console.log('OK ' + table.file);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
