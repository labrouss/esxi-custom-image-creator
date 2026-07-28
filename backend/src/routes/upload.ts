import { Router } from "express";
import multer from "multer";
import * as path from "path";
import * as fs from "fs";
import { createJob, getJob, updateJob, appendLog } from "../services/jobManager";
import {
  extractIso,
  findCandidateDepotFiles,
  findDepotsFromManifest,
  deriveEsxiVersionCode,
  hashFile,
} from "../services/extractor";
import { inspectDepots } from "../services/powercli";
import {
  recordBaseImageCache,
  recordSppExtractionCache,
  listCachedEntries,
  findCachedBaseImageFile,
  readCacheOriginalName,
} from "../services/cacheIndex";

const DATA_DIR = process.env.DATA_DIR || "/data";
const UPLOAD_DIR = path.join(DATA_DIR, "uploads"); // transient landing spot for incoming multipart files
const EXTRACTED_SPP_DIR = path.join(DATA_DIR, "extracted-spp"); // persistent: unpacked SPP/SSP contents, keyed by sha256
const EXTRACTED_ESXI_DIR = path.join(DATA_DIR, "extracted-esxi"); // persistent: cached base ESXi depot files, keyed by sha256

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(EXTRACTED_SPP_DIR, { recursive: true });
fs.mkdirSync(EXTRACTED_ESXI_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

// SPP/SSP + ESXi bundles run several GB; raise the default limit generously.
const upload = multer({ storage, limits: { fileSize: 12 * 1024 * 1024 * 1024 } });

const router = Router();

function isNonEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

// --- Step 1: create a job up front so both independent uploads can share an id ---
router.post("/create", (_req, res) => {
  const job = createJob();
  res.json({ jobId: job.id });
});

// --- Step 2a: base ESXi depot upload (independent of driver upload) ---
router.post("/:jobId/base", upload.single("file"), async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file received." });

  res.json({ status: "processing" });

  try {
    if (/\.iso$/i.test(file.originalname)) {
      appendLog(
        job.id,
        `Warning: "${file.originalname}" is a plain installer ISO, not an offline-bundle depot .zip. ` +
          `Add-EsxSoftwareDepot needs the depot zip format — this will likely fail at build time. ` +
          `Download the offline-bundle .zip for this ESXi version from Broadcom's support portal instead.`
      );
    }

    appendLog(job.id, `Hashing ${file.originalname}...`);
    const baseHash = await hashFile(file.path);
    const baseCacheDir = path.join(EXTRACTED_ESXI_DIR, baseHash);
    const cachedBasePath = path.join(baseCacheDir, file.originalname);

    if (fs.existsSync(cachedBasePath)) {
      appendLog(job.id, `Base ESXi depot already cached (${baseHash.slice(0, 12)}...), reusing.`);
    } else {
      fs.mkdirSync(baseCacheDir, { recursive: true });
      await fs.promises.copyFile(file.path, cachedBasePath);
      appendLog(job.id, `Cached base ESXi depot at ${cachedBasePath}`);
    }
    recordBaseImageCache(baseCacheDir, file.originalname, file.size);
    await fs.promises.unlink(file.path).catch(() => {});

    const versionCode = deriveEsxiVersionCode(file.originalname);
    appendLog(
      job.id,
      versionCode
        ? `Detected target ESXi version code "${versionCode}" from base image filename — will prefer matching "HPE-${versionCode}" depot(s).`
        : `Could not detect an ESXi version from "${file.originalname}" — all depot versions found in the SSP will be shown.`
    );

    updateJob(job.id, { baseImagePath: cachedBasePath, baseOriginalName: file.originalname, baseReady: true });
    await maybeFinalize(job.id);
  } catch (err: any) {
    updateJob(job.id, { phase: "error", error: err.message ?? String(err) });
  }
});

// --- Step 2b: SPP/SSP driver ISO upload (independent of base upload) ---
router.post("/:jobId/driver", upload.single("file"), async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file received." });

  res.json({ status: "processing" });

  try {
    appendLog(job.id, `Hashing ${file.originalname}...`);
    const sppHash = await hashFile(file.path);
    const extractDir = path.join(EXTRACTED_SPP_DIR, sppHash);

    if (isNonEmptyDir(extractDir)) {
      appendLog(job.id, `SPP/SSP already extracted (${sppHash.slice(0, 12)}...), reusing ${extractDir}`);
    } else {
      appendLog(job.id, `Extracting ${file.originalname} to ${extractDir}...`);
      await extractIso(file.path, extractDir);
    }
    recordSppExtractionCache(extractDir, file.originalname, file.size);
    await fs.promises.unlink(file.path).catch(() => {});

    updateJob(job.id, {
      driverIsoPath: extractDir,
      extractDir,
      driverOriginalName: file.originalname,
      driverReady: true,
    });
    await maybeFinalize(job.id);
  } catch (err: any) {
    updateJob(job.id, { phase: "error", error: err.message ?? String(err) });
  }
});

// --- List cached entries so the UI can offer "reuse" instead of re-upload ---
router.get("/cache/base", (_req, res) => {
  res.json(listCachedEntries(EXTRACTED_ESXI_DIR));
});

router.get("/cache/driver", (_req, res) => {
  res.json(listCachedEntries(EXTRACTED_SPP_DIR));
});

// --- Delete a cached entry (frees disk, removes it from the reuse list) ---
function isSafeHash(hash: string): boolean {
  // Hashes are always sha256 hex — guards against path traversal via the param.
  return /^[a-f0-9]{64}$/i.test(hash);
}

router.delete("/cache/base/:hash", async (req, res) => {
  const { hash } = req.params;
  if (!isSafeHash(hash)) return res.status(400).json({ error: "Invalid hash." });
  const dir = path.join(EXTRACTED_ESXI_DIR, hash);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    res.json({ status: "deleted" });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

router.delete("/cache/driver/:hash", async (req, res) => {
  const { hash } = req.params;
  if (!isSafeHash(hash)) return res.status(400).json({ error: "Invalid hash." });
  const dir = path.join(EXTRACTED_SPP_DIR, hash);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    res.json({ status: "deleted" });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

// --- Reuse a previously cached base image without re-uploading ---
router.post("/:jobId/base/reuse", async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const { hash } = req.body as { hash?: string };
  if (!hash) return res.status(400).json({ error: "hash is required" });

  const baseCacheDir = path.join(EXTRACTED_ESXI_DIR, hash);
  const cachedBasePath = findCachedBaseImageFile(baseCacheDir);
  if (!cachedBasePath) {
    return res.status(404).json({ error: "No cached base image found for that hash." });
  }

  const originalName = path.basename(cachedBasePath);
  appendLog(job.id, `Reusing cached base ESXi depot: ${originalName}`);
  if (/\.iso$/i.test(originalName)) {
    appendLog(
      job.id,
      `Warning: "${originalName}" is a plain installer ISO, not an offline-bundle depot .zip. ` +
        `Add-EsxSoftwareDepot needs the depot zip format — this will likely fail at build time.`
    );
  }

  const versionCode = deriveEsxiVersionCode(originalName);
  appendLog(
    job.id,
    versionCode
      ? `Detected target ESXi version code "${versionCode}" from base image filename — will prefer matching "HPE-${versionCode}" depot(s).`
      : `Could not detect an ESXi version from "${originalName}" — all depot versions found in the SSP will be shown.`
  );

  updateJob(job.id, { baseImagePath: cachedBasePath, baseOriginalName: originalName, baseReady: true });
  res.json({ status: "ready", originalName });
  await maybeFinalize(job.id);
});

// --- Reuse a previously extracted SPP/SSP without re-uploading ---
router.post("/:jobId/driver/reuse", async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const { hash } = req.body as { hash?: string };
  if (!hash) return res.status(400).json({ error: "hash is required" });

  const extractDir = path.join(EXTRACTED_SPP_DIR, hash);
  if (!isNonEmptyDir(extractDir)) {
    return res.status(404).json({ error: "No cached SPP/SSP extraction found for that hash." });
  }

  appendLog(job.id, `Reusing cached SPP/SSP extraction at ${extractDir}`);
  const driverOriginalName = readCacheOriginalName(extractDir);
  updateJob(job.id, { driverIsoPath: extractDir, extractDir, driverOriginalName, driverReady: true });
  res.json({ status: "ready" });
  await maybeFinalize(job.id);
});

/**
 * Once both the base image and driver ISO have finished their independent
 * uploads + initial processing, run manifest lookup / version filtering /
 * PowerCLI depot inspection. Safe to call from either upload handler —
 * only proceeds when both sides are ready and only runs once.
 */
async function maybeFinalize(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job || !job.baseReady || !job.driverReady) return;
  if (
    job.phase === "inspecting" ||
    job.phase === "ready_for_selection" ||
    job.phase === "building" ||
    job.phase === "done"
  ) {
    return; // already finalized or in progress
  }

  updateJob(jobId, { phase: "inspecting" });
  appendLog(jobId, "Both files ready — inspecting depots...");

  try {
    const extractDir = job.extractDir!;
    const versionCode = deriveEsxiVersionCode(path.basename(job.baseImagePath!));

    const manifestResult = findDepotsFromManifest(extractDir, versionCode);
    let candidates: string[];

    if (manifestResult.manifestPath) {
      appendLog(
        jobId,
        `Found manifest at ${manifestResult.manifestPath}: ${manifestResult.depotFiles.length} depot(s) located.`
      );
      if (manifestResult.skippedByVersionFilter.length > 0) {
        appendLog(
          jobId,
          `Skipped ${manifestResult.skippedByVersionFilter.length} depot(s) not matching version "${versionCode}": ${manifestResult.skippedByVersionFilter.join(", ")}`
        );
      }
      if (manifestResult.missingFromManifest.length > 0) {
        appendLog(
          jobId,
          `Warning: manifest lists ${manifestResult.missingFromManifest.length} file(s) not found on disk: ${manifestResult.missingFromManifest.join(", ")}`
        );
      }
      candidates = manifestResult.depotFiles;
    } else {
      appendLog(jobId, `No vmware-addon-depot.txt manifest found, falling back to broad .zip/.vib scan.`);
      const broadCandidates = findCandidateDepotFiles(extractDir);
      if (versionCode) {
        const needle = `hpe-${versionCode}`.toLowerCase();
        const filtered = broadCandidates.filter((f) => path.basename(f).toLowerCase().includes(needle));
        candidates = filtered.length > 0 ? filtered : broadCandidates;
        if (filtered.length > 0 && filtered.length < broadCandidates.length) {
          appendLog(
            jobId,
            `Filtered broad scan to ${filtered.length} file(s) matching "HPE-${versionCode}" (of ${broadCandidates.length} total .zip/.vib found).`
          );
        }
      } else {
        candidates = broadCandidates;
      }
    }

    appendLog(jobId, `Validating ${candidates.length} candidate file(s) as depots...`);

    if (candidates.length === 0) {
      updateJob(jobId, {
        phase: "error",
        error:
          "No .vib or .zip files found inside the driver ISO. It may be firmware-only (SUM payload) rather than ESXi driver components.",
      });
      return;
    }

    const result = await inspectDepots(candidates, (line) => appendLog(jobId, line));
    updateJob(jobId, {
      phase: "ready_for_selection",
      candidateDepotFiles: result.loadedDepotFiles ?? [],
      candidatePackages: result.packages ?? [],
    });
    appendLog(
      jobId,
      `${result.loadedDepotFiles?.length ?? 0} file(s) loaded as valid depots, ${
        result.packages?.length ?? 0
      } package(s) available for selection.`
    );
  } catch (err: any) {
    updateJob(jobId, { phase: "error", error: err.message ?? String(err) });
  }
}

export default router;
