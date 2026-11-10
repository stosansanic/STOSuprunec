import type { ExportTarget, ExportWriter } from "./core";

// Structural interfaces keep this feature independent of experimental DOM typings.
interface WritableFile { write(text: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
export interface ExportDirectory {
  name: string;
  getDirectoryHandle(name: string, options: { create: boolean }): Promise<ExportDirectory>;
  getFileHandle(name: string, options: { create: boolean }): Promise<{ createWritable(): Promise<WritableFile> }>;
}
export function directoryTarget(directory: ExportDirectory): ExportTarget {
  return { async open(name) { return (await directory.getFileHandle(name, { create: true })).createWritable(); } };
}

export function memoryTarget(maxBytes = 100 * 1024 * 1024) {
  const files = new Map<string, Blob>(); let total = 0;
  const target: ExportTarget = { async open(name): Promise<ExportWriter> {
    let parts: string[] = [], size = 0;
    return {
      async write(text) {
        size += new TextEncoder().encode(text).length;
        if (total - (files.get(name)?.size || 0) + size > maxBytes) throw new Error("ZIP перевищує безпечний обсяг пам’яті (100 МБ). Використайте експорт у папку в Chrome/Edge на ПК.");
        parts.push(text);
      },
      async close() { const blob = new Blob(parts, { type: "application/json;charset=utf-8" }); total += blob.size - (files.get(name)?.size || 0); files.set(name, blob); parts = []; },
      async abort() { parts = []; },
    };
  } };
  return { target, files };
}

// ZIP STORE (no compression). Every table remains a separate UTF-8 .jsonb entry.
// No remote archive service, dependency download, or browser persistence is involved.
export async function zipFiles(files: Map<string, Blob>): Promise<Blob> {
  const records: BlobPart[] = [], directory: BlobPart[] = []; let offset = 0, directorySize = 0;
  if (files.size > 65535) throw new Error("Забагато файлів для ZIP.");
  for (const [name, blob] of files) {
    const filename = new TextEncoder().encode(name), bytes = new Uint8Array(await blob.arrayBuffer());
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint16(12, 33, true);
    l.setUint32(14, crc, true); l.setUint32(18, bytes.length, true); l.setUint32(22, bytes.length, true); l.setUint16(26, filename.length, true);
    const central = new Uint8Array(46), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(14, 33, true);
    c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, filename.length, true); c.setUint32(42, offset, true);
    records.push(local, filename, blob); directory.push(central, filename);
    offset += local.length + filename.length + bytes.length; directorySize += central.length + filename.length;
    if (offset + directorySize > 0xffffffff) throw new Error("ZIP перевищує 4 ГБ. Використайте експорт у папку.");
  }
  const end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.size, true); view.setUint16(10, files.size, true);
  view.setUint32(12, directorySize, true); view.setUint32(16, offset, true);
  return new Blob([...records, ...directory, end], { type: "application/zip" });
}
