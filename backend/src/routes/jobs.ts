import { Router } from "express";
import * as fs from "fs";
import * as path from "path";
import { getJob, updateJob, appendLog } from "../services/jobManager";
import { buildImage } from "../services/powercli";

const DATA_DIR = process.env.DATA_DIR || "/data";
const OUTPUT_DIR = path.join(DATA_DIR, "output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const router = Router();

function isSafeOutputFilename(name: string): boolean {
  // Must be a bare filename (no path separators / traversal) ending in .iso or .zip.
  return (
    path.basename(name) === name &&
    /^[A-Za-z0-9._-]+\.(iso|zip)$/i.test(name)
  );
}

// --- List previously built outputs (declared before "/:id" so it isn't swallowed by it) ---
router.get("/outputs", (_req, res) => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true });
  } catch {
    return res.json([]);
  }

  const outputs = entries
    .filter((e) => e.isFile() && /\.(iso|zip)$/i.test(e.name))
    .map((e) => {
      const stat = fs.statSync(path.join(OUTPUT_DIR, e.name));
      return { filename: e.name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  res.json(outputs);
});

router.get("/outputs/:filename/download", (req, res) => {
  const { filename } = req.params;
  if (!isSafeOutputFilename(filename)) return res.status(400).json({ error: "Invalid filename." });
  const filePath = path.join(OUTPUT_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found." });
  res.download(filePath);
});

router.delete("/outputs/:filename", async (req, res) => {
  const { filename } = req.params;
  if (!isSafeOutputFilename(filename)) return res.status(400).json({ error: "Invalid filename." });
  const filePath = path.join(OUTPUT_DIR, filename);
  try {
    await fs.promises.unlink(filePath);
    res.json({ status: "deleted" });
  } catch (err: any) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "File not found." });
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

router.get("/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

function sanitizeForFilename(name: string): string {
  return name
    .replace(/\.(iso|zip)$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
}

router.post("/:id/build", async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.phase !== "ready_for_selection") {
    return res.status(409).json({ error: `Job is in phase '${job.phase}', not ready to build.` });
  }

  const {
    selectedPackages,
    exportFormats,
    namingMode,
    customSuffix,
    creatorMode,
    customCreator,
    descriptionMode,
    customDescription,
  } = req.body as {
    selectedPackages: { name: string; version: string }[];
    exportFormats?: ("iso" | "bundle")[];
    namingMode?: "jobid" | "spp" | "date" | "combined" | "manual";
    customSuffix?: string;
    creatorMode?: "default" | "manual";
    customCreator?: string;
    descriptionMode?: "auto" | "inherit" | "manual";
    customDescription?: string;
  };
  if (!Array.isArray(selectedPackages) || selectedPackages.length === 0) {
    return res.status(400).json({ error: "selectedPackages must be a non-empty array." });
  }
  if (selectedPackages.some((p) => !p || typeof p.name !== "string" || typeof p.version !== "string")) {
    return res.status(400).json({ error: "Each selectedPackages entry needs a name and version." });
  }
  const formats: ("iso" | "bundle")[] =
    exportFormats && exportFormats.length > 0 ? exportFormats : ["iso"];
  if (formats.some((f) => f !== "iso" && f !== "bundle")) {
    return res.status(400).json({ error: "exportFormats may only contain 'iso' and/or 'bundle'." });
  }
  if (namingMode === "manual" && !customSuffix?.trim()) {
    return res.status(400).json({ error: "customSuffix is required when namingMode is 'manual'." });
  }
  if (creatorMode === "manual" && !customCreator?.trim()) {
    return res.status(400).json({ error: "customCreator is required when creatorMode is 'manual'." });
  }
  if (descriptionMode === "manual" && !customDescription?.trim()) {
    return res.status(400).json({ error: "customDescription is required when descriptionMode is 'manual'." });
  }

  if (job.baseImagePath && !/\.zip$/i.test(job.baseImagePath)) {
    return res.status(400).json({
      error:
        `Base image "${path.basename(job.baseImagePath)}" is not a depot .zip — it looks like a plain ` +
        `installer ISO. Add-EsxSoftwareDepot can only load the offline-bundle .zip format. Download the ` +
        `"Offline Bundle" (not "ISO") for this ESXi build from Broadcom's support portal and upload that instead.`,
    });
  }

  updateJob(job.id, { phase: "building", selectedPackages, exportFormats: formats });
  res.json({ status: "building" });

  (async () => {
    try {
      const shortJobId = job.id.split("-")[0];
      const sppLabel = job.driverOriginalName ? sanitizeForFilename(job.driverOriginalName) : "spp";
      const baseName = `${shortJobId}-${sppLabel}-custom-esxi`;

      const outputIsoPath = formats.includes("iso") ? path.join(OUTPUT_DIR, `${baseName}.iso`) : undefined;
      const outputBundlePath = formats.includes("bundle")
        ? path.join(OUTPUT_DIR, `${baseName}-bundle.zip`)
        : undefined;

      // Profile name embedded inside the ISO itself (visible via esxcli on a
      // deployed host, and in \UPGRADE\PROFILE.XML) — separate from the output
      // filename above, though they share the same short-job-id convention.
      const now = new Date();
      const dateStamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
      let profileSuffix: string;
      switch (namingMode) {
        case "spp":
          profileSuffix = job.driverOriginalName ? sanitizeForFilename(job.driverOriginalName) : "Custom";
          break;
        case "date":
          profileSuffix = `Custom-${dateStamp}`;
          break;
        case "combined":
          profileSuffix = `${shortJobId}-${dateStamp}`;
          break;
        case "manual":
          profileSuffix = sanitizeForFilename(customSuffix!.trim());
          break;
        case "jobid":
        default:
          profileSuffix = shortJobId;
          break;
      }
      appendLog(job.id, `Profile name suffix: "${profileSuffix}" (mode: ${namingMode ?? "jobid"})`);

      const vendor = creatorMode === "manual" ? customCreator!.trim() : "InternalTooling";

      let description: string | undefined;
      if (descriptionMode === "manual") {
        description = customDescription!.trim();
      } else if (descriptionMode === "auto" || !descriptionMode) {
        const driverSourceLabel = job.driverOriginalName
          ? job.driverOriginalName
          : (job.vibs?.length ?? 0) > 0
            ? "individually added VIB(s) only"
            : "none";
        description =
          `Custom ESXi image built ${dateStamp} via ESXi Custom Image Builder. ` +
          `Base: ${job.baseOriginalName ?? path.basename(job.baseImagePath ?? "unknown")}. ` +
          `Driver source: ${driverSourceLabel}. ${selectedPackages.length} driver(s) injected.`;
      }
      // descriptionMode === "inherit" leaves `description` undefined, so the
      // build script doesn't pass -Description and the cloned profile keeps
      // the base image's original description.
      appendLog(job.id, `Creator: "${vendor}" | Description mode: ${descriptionMode ?? "auto"}`);

      appendLog(
        job.id,
        `Building image (${formats.join(" + ")}) with packages: ${selectedPackages
          .map((p) => `${p.name}@${p.version}`)
          .join(", ")}`
      );

      const result = await buildImage(
        {
          baseDepotPath: job.baseImagePath!,
          driverDepotFiles: job.candidateDepotFiles ?? [],
          selectedPackages,
          exportFormats: formats as ("iso" | "bundle")[],
          outputIsoPath,
          outputBundlePath,
          profileSuffix,
          vendor,
          description,
        },
        (line) => appendLog(job.id, line)
      );

      if (!result.success) {
        updateJob(job.id, { phase: "error", error: result.error });
        return;
      }

      updateJob(job.id, {
        phase: "done",
        outputIsoPath: result.outputIsoPath ?? undefined,
        outputBundlePath: result.outputBundlePath ?? undefined,
      });
      appendLog(
        job.id,
        `Done. ${result.outputIsoPath ? `ISO: ${result.outputIsoPath} ` : ""}${
          result.outputBundlePath ? `Bundle: ${result.outputBundlePath}` : ""
        }`
      );
    } catch (err: any) {
      updateJob(job.id, { phase: "error", error: err.message ?? String(err) });
    }
  })();
});

router.get("/:id/download/iso", (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.phase !== "done" || !job.outputIsoPath) {
    return res.status(404).json({ error: "ISO output not available for this job." });
  }
  res.download(job.outputIsoPath);
});

router.get("/:id/download/bundle", (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.phase !== "done" || !job.outputBundlePath) {
    return res.status(404).json({ error: "Bundle output not available for this job." });
  }
  res.download(job.outputBundlePath);
});

export default router;
