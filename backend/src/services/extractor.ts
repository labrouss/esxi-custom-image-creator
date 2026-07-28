import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

/**
 * SHA-256 of a file's contents, used to key persistent cache directories so
 * re-uploading the same SPP/SSP ISO or base ESXi depot doesn't redo the work.
 */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Extract an ISO's contents using 7z (works without loop-mount / root privileges,
 * unlike Mount-DiskImage which is Windows-only anyway).
 */
export async function extractIso(isoPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const { code, stderr } = await run("7z", ["x", "-y", `-o${destDir}`, isoPath]);
  if (code !== 0) {
    throw new Error(`7z extraction failed for ${isoPath}: ${stderr}`);
  }
}

/**
 * Recursively walk a directory looking for files that are plausible ESXi
 * depot sources: offline-bundle zips, generic component zips, or loose .vib files.
 * This is a broad fallback filter — used only when the manifest-based lookup
 * below can't find anything, since it's noisy on real SSP layouts (firmware
 * payloads, SUM tooling, etc. all show up as .zip too).
 */
export function findCandidateDepotFiles(rootDir: string): string[] {
  const results: string[] = [];
  const patterns = [/\.vib$/i, /\.zip$/i];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (patterns.some((p) => p.test(entry.name))) {
        results.push(full);
      }
    }
  }

  walk(rootDir);
  return results;
}

/**
 * Find a file by exact name anywhere under a directory tree (case-insensitive,
 * since ISO9660/Joliet extraction can vary in casing across SSP releases).
 */
function findFileByName(rootDir: string, targetName: string): string | undefined {
  const target = targetName.toLowerCase();
  let found: string | undefined;

  function walk(dir: string) {
    if (found) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.toLowerCase() === target) {
        found = full;
      }
    }
  }

  walk(rootDir);
  return found;
}

export interface ManifestDepotResult {
  manifestPath?: string;
  depotFiles: string[];
  missingFromManifest: string[];
  skippedByVersionFilter: string[];
}

/**
 * Derives a compact version code from an ESXi base depot filename to match
 * HPE's own convention (e.g. "HPE-803..." = ESXi 8.0.3, "HPE-902..." = 9.0.2,
 * "HPE-910..." = 9.1.0).
 *
 * HPE's own custom-built ESXi ISOs (e.g. "ESXi80U3g-with-HPE-803-...") embed
 * this exact code directly as "HPE-<code>" — that's checked first since it's
 * an exact match to the manifest naming, not a guess. Only if that's absent
 * does this fall back to parsing a generic version pattern, which handles
 * both dotted ("8.0.3") and update-letter ("8.0U3"/"80U3") styles used
 * elsewhere by Broadcom/VMware and HPE. The generic fallback is intentionally
 * conservative (major version restricted to a plausible ESXi range) since
 * build numbers and other digit strings in a filename can otherwise produce
 * false matches.
 */
export function deriveEsxiVersionCode(filename: string): string | null {
  const explicit = filename.match(/HPE-(\d{3,4})/i);
  if (explicit) return explicit[1];

  // Dotless update style: "80U3", "80U3g", "90U2" -> major, minor, update
  const dotless = filename.match(/\b([6-9])(\d)[uU](\d+)/);
  if (dotless) return `${dotless[1]}${dotless[2]}${dotless[3]}`;

  // Dotted style: "8.0.3", "8.0U3", "8.0U3g" -> major restricted to 6-9 to
  // avoid matching arbitrary build-number-looking substrings elsewhere in
  // the name. No trailing boundary requirement, since patch-letter suffixes
  // ("g" in "8.0U3g") are common and would otherwise block the match.
  const dotted = filename.match(/\b([6-9])\.(\d)(?:\.(\d+)|[uU](\d+))?/);
  if (dotted) {
    const update = dotted[3] ?? dotted[4] ?? "0";
    return `${dotted[1]}${dotted[2]}${update}`;
  }

  return null;
}

/**
 * HPE Synergy SSP layout: manifest/vmw/vmware-addon-depot.txt lists the exact
 * depot zip filenames (one per ESXi major version, e.g. HPE-803.x-...-Addon-depot.zip
 * for 8.0.3, HPE-902.x-... for 9.0.2). This is the real source of truth for
 * "which zips are actual ESXi depots" — far more precise than scanning for
 * every .zip in the ISO, which also catches firmware/SUM payloads.
 *
 * If versionCode is provided (e.g. "803"), only manifest entries whose
 * filename contains "HPE-<versionCode>" are located/returned — the rest are
 * reported in skippedByVersionFilter so the UI/log can show what was excluded
 * and why, rather than silently dropping them.
 */
export function findDepotsFromManifest(rootDir: string, versionCode?: string | null): ManifestDepotResult {
  const manifestPath = findFileByName(rootDir, "vmware-addon-depot.txt");
  if (!manifestPath) {
    return { depotFiles: [], missingFromManifest: [], skippedByVersionFilter: [] };
  }

  const allLines = fs
    .readFileSync(manifestPath, "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && /\.zip$/i.test(l));

  let lines = allLines;
  const skippedByVersionFilter: string[] = [];

  if (versionCode) {
    const needle = `hpe-${versionCode}`.toLowerCase();
    const matched = allLines.filter((l) => l.toLowerCase().includes(needle));
    const skipped = allLines.filter((l) => !l.toLowerCase().includes(needle));
    if (matched.length > 0) {
      lines = matched;
      skippedByVersionFilter.push(...skipped);
    }
    // If nothing matches the version filter, fall through and use all lines
    // rather than returning zero depots — better to show too much than nothing.
  }

  const depotFiles: string[] = [];
  const missingFromManifest: string[] = [];

  for (const line of lines) {
    const found = findFileByName(rootDir, line);
    if (found) {
      depotFiles.push(found);
    } else {
      missingFromManifest.push(line);
    }
  }

  return { manifestPath, depotFiles, missingFromManifest, skippedByVersionFilter };
}
