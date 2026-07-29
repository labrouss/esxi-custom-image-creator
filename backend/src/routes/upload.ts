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
  recordVibCache,
  listCachedEntries,
  findCachedBaseImageFile,
  findCachedSingleFile,
  readCacheOriginalName,
} from "../services/cacheIndex";

const DATA_DIR = process.env.DATA_DIR || "/data";
const UPLOAD_DIR = path.join(DATA_DIR, "uploads"); // transient landing spot for incoming multipart files
const EXTRACTED_SPP_DIR = path.join(DATA_DIR, "extracted-spp"); // persistent: unpacked SPP/SSP contents, keyed by sha256
const EXTRACTED_ESXI_DIR = path.join(DATA_DIR, "extracted-esxi"); // persistent: cached base ESXi depot files, keyed by sha256
const EXTRACTED_VIB_DIR = path.join(DATA_DIR, "extracted-vibs"); // persistent: cached individual .vib files, keyed by sha256

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(EXTRACTED_SPP_DIR, { recursive: true });
fs.mkdirSync(EXTRACTED_ESXI_DIR, { recursive: true });
fs.mkdirSync(EXTRACTED_VIB_DIR, { recursive: true });

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
  } catch (err: any) {
    updateJob(job.id, { phase: "error", error: err.message ?? String(err) });
  }
});

// --- Individual .vib upload — optional, additive alongside (or instead of) the SPP/SSP ---
router.post("/:jobId/vib", upload.single("file"), async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file received." });

  res.json({ status: "processing" });

  try {
    if (!/\.vib$/i.test(file.originalname)) {
      appendLog(job.id, `Warning: "${file.originalname}" doesn't have a .vib extension — uploading anyway.`);
    }

    appendLog(job.id, `Hashing ${file.originalname}...`);
    const vibHash = await hashFile(file.path);
    const vibCacheDir = path.join(EXTRACTED_VIB_DIR, vibHash);
    const cachedVibPath = path.join(vibCacheDir, file.originalname);

    if (fs.existsSync(cachedVibPath)) {
      appendLog(job.id, `VIB already cached (${vibHash.slice(0, 12)}...), reusing.`);
    } else {
      fs.mkdirSync(vibCacheDir, { recursive: true });
      await fs.promises.copyFile(file.path, cachedVibPath);
      appendLog(job.id, `Cached VIB at ${cachedVibPath}`);
    }
    recordVibCache(vibCacheDir, file.originalname, file.size);
    await fs.promises.unlink(file.path).catch(() => {});

    const current = getJob(job.id)!;
    const vibs = [...(current.vibs ?? [])];
    if (!vibs.some((v) => v.hash === vibHash)) {
      vibs.push({ path: cachedVibPath, originalName: file.originalname, hash: vibHash });
    }
    updateJob(job.id, { vibs });
    appendLog(job.id, `Added "${file.originalname}" to this job (${vibs.length} VIB(s) total).`);
  } catch (err: any) {
    updateJob(job.id, { phase: "error", error: err.message ?? String(err) });
  }
});

// --- Attach a previously cached VIB to this job without re-uploading ---
router.post("/:jobId/vib/reuse", async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const { hash } = req.body as { hash?: string };
  if (!hash) return res.status(400).json({ error: "hash is required" });

  const vibCacheDir = path.join(EXTRACTED_VIB_DIR, hash);
  const cachedVibPath = findCachedSingleFile(vibCacheDir);
  if (!cachedVibPath) {
    return res.status(404).json({ error: "No cached VIB found for that hash." });
  }

  const originalName = path.basename(cachedVibPath);
  const vibs = [...(job.vibs ?? [])];
  if (!vibs.some((v) => v.hash === hash)) {
    vibs.push({ path: cachedVibPath, originalName, hash });
  }
  updateJob(job.id, { vibs });
  appendLog(job.id, `Reusing cached VIB: ${originalName} (${vibs.length} VIB(s) total on this job).`);
  res.json({ status: "ready", originalName });
});

// --- Detach a VIB from this job (does not delete it from the cache) ---
router.delete("/:jobId/vib/:hash", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const { hash } = req.params;
  const vibs = (job.vibs ?? []).filter((v) => v.hash !== hash);
  updateJob(job.id, { vibs });
  appendLog(job.id, `Removed a VIB from this job (${vibs.length} VIB(s) remaining).`);
  res.json({ status: "removed" });
});

// --- List cached entries so the UI can offer "reuse" instead of re-upload ---
router.get("/cache/base", (_req, res) => {
  res.json(listCachedEntries(EXTRACTED_ESXI_DIR));
});

router.get("/cache/driver", (_req, res) => {
  res.json(listCachedEntries(EXTRACTED_SPP_DIR));
});

router.get("/cache/vib", (_req, res) => {
  res.json(listCachedEntries(EXTRACTED_VIB_DIR));
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

router.delete("/cache/vib/:hash", async (req, res) => {
  const { hash } = req.params;
  if (!isSafeHash(hash)) return res.status(400).json({ error: "Invalid hash." });
  const dir = path.join(EXTRACTED_VIB_DIR, hash);
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
});

// --- Explicit analyze trigger: base is required, plus SPP and/or at least one VIB ---
router.post("/:jobId/analyze", async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const hasDriverSource = job.driverReady || (job.vibs?.length ?? 0) > 0;
  if (!job.baseReady || !hasDriverSource) {
    return res.status(400).json({
      error: "Need a base ESXi depot, plus an SPP/SSP and/or at least one individual VIB, before analyzing.",
    });
  }
  if (["inspecting", "ready_for_selection", "building", "done"].includes(job.phase)) {
    return res.status(409).json({ error: `Job is already in phase '${job.phase}'.` });
  }

  res.json({ status: "analyzing" });

  const jobId = job.id;
  updateJob(jobId, { phase: "inspecting" });
  appendLog(jobId, "Analyzing depot(s)...");

  try {
    let candidates: string[] = [];

    if (job.driverReady && job.extractDir) {
      const versionCode = deriveEsxiVersionCode(path.basename(job.baseImagePath!));
      const manifestResult = findDepotsFromManifest(job.extractDir, versionCode);

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
        candidates.push(...manifestResult.depotFiles);
      } else {
        appendLog(jobId, `No vmware-addon-depot.txt manifest found, falling back to broad .zip/.vib scan.`);
        const broadCandidates = findCandidateDepotFiles(job.extractDir);
        if (versionCode) {
          const needle = `hpe-${versionCode}`.toLowerCase();
          const filtered = broadCandidates.filter((f) => path.basename(f).toLowerCase().includes(needle));
          const chosen = filtered.length > 0 ? filtered : broadCandidates;
          if (filtered.length > 0 && filtered.length < broadCandidates.length) {
            appendLog(
              jobId,
              `Filtered broad scan to ${filtered.length} file(s) matching "HPE-${versionCode}" (of ${broadCandidates.length} total .zip/.vib found).`
            );
          }
          candidates.push(...chosen);
        } else {
          candidates.push(...broadCandidates);
        }
      }
    } else if (!job.driverReady) {
      appendLog(jobId, "No SPP/SSP provided — using individually added VIB(s) only.");
    }

    if (job.vibs && job.vibs.length > 0) {
      appendLog(jobId, `Including ${job.vibs.length} individually added VIB(s): ${job.vibs.map((v) => v.originalName).join(", ")}`);
      candidates.push(...job.vibs.map((v) => v.path));
    }

    appendLog(jobId, `Validating ${candidates.length} candidate file(s) as depots...`);

    if (candidates.length === 0) {
      updateJob(jobId, {
        phase: "error",
        error:
          "No .vib or .zip files found to load as depots. The SPP/SSP may be firmware-only (SUM payload) rather than ESXi driver components, and no individual VIBs were added.",
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
});

export default router;
