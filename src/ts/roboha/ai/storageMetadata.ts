export interface StorageMetadataEntry {
  id: string | null;
  name: string;
  metadata?: { size?: number | string } | null;
}

/** Lists metadata only; never downloads image objects. Pages are kept bounded. */
export async function readStorageMetadata(
  list: (folder: string, offset: number, limit: number) => Promise<StorageMetadataEntry[]>,
): Promise<{ totalFiles: number; totalSizeMb: number; totalBytes: number }> {
  let totalFiles = 0;
  let totalBytes = 0;
  const folders = [""];
  const visited = new Set<string>();
  for (let index = 0; index < folders.length; index++) {
    const folder = folders[index];
    if (visited.has(folder)) continue;
    visited.add(folder);
    for (let offset = 0; ; offset += 200) {
      const rows = await list(folder, offset, 200);
      for (const row of rows) {
        if (row.id === null) {
          folders.push(folder ? `${folder}/${row.name}` : row.name);
        } else {
          totalFiles++;
          const rawSize = row.metadata?.size;
          const size = (typeof rawSize === "number" || (typeof rawSize === "string" && /^\d+$/.test(rawSize)))
            ? Number(rawSize) : NaN;
          if (!Number.isSafeInteger(size) || size < 0) throw new Error("Supabase не повернув розмір одного з файлів Атласу.");
          totalBytes += size;
          if (!Number.isSafeInteger(totalBytes)) throw new Error("Розмір файлів Атласу перевищує підтримуваний діапазон.");
        }
      }
      if (rows.length < 200) break;
    }
  }
  return { totalFiles, totalSizeMb: Math.round(totalBytes / 1024 / 1024 * 100) / 100, totalBytes };
}
