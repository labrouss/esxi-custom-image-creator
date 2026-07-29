import * as fs from "fs";
import * as path from "path";

const META_FILENAME = "cache-meta.json";

interface CacheMeta {
  originalName: string;
  cachedAt: string;
  sizeBytes?: number;
}

function writeMeta(dir: string, meta: CacheMeta): void {
  fs.writeFileSync(path.join(dir, META_FILENAME), JSON.stringify(meta, null, 2));
}

function readMeta(dir: string): CacheMeta | undefined {
  try {
    const raw = fs.readFileSync(path.join(dir, META_FILENAME), "utf-8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function recordBaseImageCache(baseCacheDir: string, originalName: string, sizeBytes: number): void {
  writeMeta(baseCacheDir, { originalName, cachedAt: new Date().toISOString(), sizeBytes });
}

export function recordSppExtractionCache(extractDir: string, originalName: string, sizeBytes: number): void {
  writeMeta(extractDir, { originalName, cachedAt: new Date().toISOString(), sizeBytes });
}

export function readCacheOriginalName(dir: string): string | undefined {
  return readMeta(dir)?.originalName;
}

export function recordVibCache(vibCacheDir: string, originalName: string, sizeBytes: number): void {
  writeMeta(vibCacheDir, { originalName, cachedAt: new Date().toISOString(), sizeBytes });
}

export interface CachedEntry {
  hash: string;
  originalName: string;
  cachedAt: string;
  sizeBytes?: number;
}

/**
 * Lists cached entries under a hash-keyed directory (extracted-esxi or
 * extracted-spp), reading each subdirectory's cache-meta.json. Entries from
 * before this metadata existed are skipped rather than guessed at.
 */
export function listCachedEntries(rootDir: string): CachedEntry[] {
  let hashDirs: string[];
  try {
    hashDirs = fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const entries: CachedEntry[] = [];
  for (const hash of hashDirs) {
    const meta = readMeta(path.join(rootDir, hash));
    if (meta) {
      entries.push({ hash, originalName: meta.originalName, cachedAt: meta.cachedAt, sizeBytes: meta.sizeBytes });
    }
  }
  // Most recently cached first — usually what you want to reuse.
  entries.sort((a, b) => new Date(b.cachedAt).getTime() - new Date(a.cachedAt).getTime());
  return entries;
}

/**
 * Finds the single cached base-image file inside a hash directory
 * (it's stored as <baseCacheDir>/<originalFilename>, alongside cache-meta.json).
 */
export function findCachedBaseImageFile(baseCacheDir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(baseCacheDir);
  } catch {
    return undefined;
  }
  const file = entries.find((f) => f !== META_FILENAME);
  return file ? path.join(baseCacheDir, file) : undefined;
}

/** Same lookup as findCachedBaseImageFile — generic to any single-file cache dir (also used for VIBs). */
export const findCachedSingleFile = findCachedBaseImageFile;
