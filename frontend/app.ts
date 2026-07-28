interface CachedEntry {
  hash: string;
  originalName: string;
  cachedAt: string;
  sizeBytes?: number;
}
interface CandidatePackage {
  name: string;
  vendor: string;
  version: string;
  vibId: string;
  sourceFile: string;
}

interface JobState {
  id: string;
  phase: string;
  log: string[];
  candidatePackages?: CandidatePackage[];
  outputIsoPath?: string;
  outputBundlePath?: string;
  error?: string;
}

const uploadSection = document.getElementById("upload-section")!;
const selectionSection = document.getElementById("selection-section")!;
const downloadSection = document.getElementById("download-section")!;
const packageList = document.getElementById("package-list")!;
const logEl = document.getElementById("log")!;
const errorEl = document.getElementById("errorMsg")!;
const uploadBaseBtn = document.getElementById("uploadBaseBtn") as HTMLButtonElement;
const uploadDriverBtn = document.getElementById("uploadDriverBtn") as HTMLButtonElement;
const baseReuseSelect = document.getElementById("baseReuseSelect") as HTMLSelectElement;
const baseReuseBtn = document.getElementById("baseReuseBtn") as HTMLButtonElement;
const baseDeleteBtn = document.getElementById("baseDeleteBtn") as HTMLButtonElement;
const driverReuseSelect = document.getElementById("driverReuseSelect") as HTMLSelectElement;
const driverReuseBtn = document.getElementById("driverReuseBtn") as HTMLButtonElement;
const driverDeleteBtn = document.getElementById("driverDeleteBtn") as HTMLButtonElement;
const baseProgressTrack = document.getElementById("baseProgressTrack")!;
const baseProgressFill = document.getElementById("baseProgressFill")!;
const baseProgressLabel = document.getElementById("baseProgressLabel")!;
const driverProgressTrack = document.getElementById("driverProgressTrack")!;
const driverProgressFill = document.getElementById("driverProgressFill")!;
const driverProgressLabel = document.getElementById("driverProgressLabel")!;
const buildBtn = document.getElementById("buildBtn") as HTMLButtonElement;
const buildProgressTrack = document.getElementById("buildProgressTrack")!;
const buildProgressLabel = document.getElementById("buildProgressLabel")!;
const downloadIsoLink = document.getElementById("downloadIsoLink") as HTMLAnchorElement;
const downloadBundleLink = document.getElementById("downloadBundleLink") as HTMLAnchorElement;

let currentJobId: string | null = null;
let pollTimer: number | null = null;

function startOver(e?: Event) {
  e?.preventDefault();
  window.location.reload();
}
document.getElementById("startOverBtn")?.addEventListener("click", startOver);
document.getElementById("startOverErrorBtn")?.addEventListener("click", startOver);
document.getElementById("startOverTopBtn")?.addEventListener("click", startOver);

const startOverErrorBtn = document.getElementById("startOverErrorBtn")!;

function showError(msg: string) {
  errorEl.textContent = msg;
  errorEl.classList.remove("hidden");
  startOverErrorBtn.classList.remove("hidden");
}

function clearError() {
  errorEl.classList.add("hidden");
  errorEl.textContent = "";
  startOverErrorBtn.classList.add("hidden");
}

function renderLog(lines: string[]) {
  logEl.textContent = lines.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

const packagePlaceholder = document.getElementById("packagePlaceholder")!;
const selectAllRow = document.getElementById("selectAllRow")!;

function renderPackages(packages: CandidatePackage[]) {
  packagePlaceholder.classList.add("hidden");
  selectAllRow.classList.remove("hidden");
  packageList.innerHTML = "";
  packages.forEach((pkg, idx) => {
    const row = document.createElement("div");
    row.className = "package-row";
    row.innerHTML = `
      <input type="checkbox" id="pkg-${idx}" value="${pkg.name}" checked />
      <label for="pkg-${idx}" style="font-weight:normal; margin:0;">
        ${pkg.name} <span style="color:#888;">(${pkg.vendor}, v${pkg.version})</span>
      </label>
    `;
    packageList.appendChild(row);
  });
  updateSelectionCount();
}

const selectionCountEl = document.getElementById("selectionCount")!;

function updateSelectionCount() {
  const total = packageList.querySelectorAll("input[type=checkbox]").length;
  if (total === 0) {
    selectionCountEl.textContent = "";
    return;
  }
  const selected = packageList.querySelectorAll("input[type=checkbox]:checked").length;
  selectionCountEl.textContent = `${selected}/${total} selected`;
}

// Delegated listener: covers all checkboxes, including ones added after a re-render.
packageList.addEventListener("change", (e) => {
  if ((e.target as HTMLElement)?.matches('input[type="checkbox"]')) {
    updateSelectionCount();
  }
});

document.getElementById("selectAllBtn")?.addEventListener("click", () => {
  packageList.querySelectorAll("input[type=checkbox]").forEach((el) => ((el as HTMLInputElement).checked = true));
  updateSelectionCount();
});

document.getElementById("selectNoneBtn")?.addEventListener("click", () => {
  packageList.querySelectorAll("input[type=checkbox]").forEach((el) => ((el as HTMLInputElement).checked = false));
  updateSelectionCount();
});

function getSelectedPackageNames(): string[] {
  return Array.from(packageList.querySelectorAll("input[type=checkbox]:checked")).map(
    (el) => (el as HTMLInputElement).value
  );
}

async function poll(jobId: string) {
  const res = await fetch(`/api/jobs/${jobId}`);
  const job: JobState = await res.json();
  renderLog(job.log ?? []);

  if (job.phase === "building") {
    buildProgressTrack.classList.remove("hidden");
    buildProgressLabel.classList.remove("hidden");
    const lastLine = (job.log ?? [])[job.log.length - 1];
    buildProgressLabel.textContent = lastLine ?? "Building...";
  } else {
    buildProgressTrack.classList.add("hidden");
    buildProgressLabel.classList.add("hidden");
  }

  if (job.phase === "error") {
    showError(job.error ?? "Unknown error");
    if (pollTimer) clearInterval(pollTimer);
    uploadBaseBtn.disabled = false;
    uploadDriverBtn.disabled = false;
    buildBtn.disabled = false;
    return;
  }

  if (job.phase === "ready_for_selection" && job.candidatePackages) {
    if (pollTimer) clearInterval(pollTimer);
    renderPackages(job.candidatePackages);
    buildBtn.disabled = false;
    return;
  }

  if (job.phase === "done") {
    if (pollTimer) clearInterval(pollTimer);
    downloadSection.classList.remove("hidden");

    if (job.outputIsoPath) {
      downloadIsoLink.href = `/api/jobs/${jobId}/download/iso`;
      downloadIsoLink.classList.remove("hidden");
    }
    if (job.outputBundlePath) {
      downloadBundleLink.href = `/api/jobs/${jobId}/download/bundle`;
      downloadBundleLink.classList.remove("hidden");
    }
    return;
  }
}

async function ensureJob(): Promise<string> {
  if (currentJobId) return currentJobId;
  const res = await fetch("/api/upload/create", { method: "POST" });
  if (!res.ok) throw new Error("Failed to create job");
  const { jobId } = await res.json();
  currentJobId = jobId;
  if (!pollTimer) pollTimer = window.setInterval(() => poll(currentJobId!), 2000);
  return jobId;
}

function uploadWithProgress(
  jobId: string,
  endpoint: string,
  file: File,
  progressTrack: HTMLElement,
  progressFill: HTMLElement,
  progressLabel: HTMLElement,
  button: HTMLButtonElement
): Promise<void> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload/${jobId}/${endpoint}`);

    progressTrack.classList.remove("hidden");
    progressLabel.classList.remove("hidden");
    progressFill.style.width = "0%";
    progressLabel.textContent = "Starting upload...";
    button.disabled = true;

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      progressFill.style.width = `${pct}%`;
      const mbLoaded = (e.loaded / (1024 * 1024)).toFixed(0);
      const mbTotal = (e.total / (1024 * 1024)).toFixed(0);
      progressLabel.textContent = `${pct}% (${mbLoaded} MB / ${mbTotal} MB)`;
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        progressLabel.textContent = "Uploaded — processing on server...";
        button.textContent = "Uploaded ✓";
        resolve();
      } else {
        let msg = `Upload failed (HTTP ${xhr.status})`;
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch {
          /* ignore parse error, use default msg */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(formData);
  });
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? ` (${gb.toFixed(1)} GB)` : ` (${(bytes / (1024 * 1024)).toFixed(0)} MB)`;
}

function populateReuseSelect(select: HTMLSelectElement, entries: CachedEntry[]) {
  select.innerHTML = "";
  if (entries.length === 0) {
    select.innerHTML = `<option value="">No cached files yet</option>`;
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = entries
    .map((e) => {
      const date = new Date(e.cachedAt).toLocaleString();
      return `<option value="${e.hash}">${e.originalName}${formatSize(e.sizeBytes)} — ${date}</option>`;
    })
    .join("");
}

async function loadCacheLists() {
  try {
    const [baseRes, driverRes] = await Promise.all([
      fetch("/api/upload/cache/base"),
      fetch("/api/upload/cache/driver"),
    ]);
    const baseEntries: CachedEntry[] = await baseRes.json();
    const driverEntries: CachedEntry[] = await driverRes.json();
    populateReuseSelect(baseReuseSelect, baseEntries);
    populateReuseSelect(driverReuseSelect, driverEntries);
  } catch {
    // Non-fatal — reuse is a convenience, not required for the tool to work.
    populateReuseSelect(baseReuseSelect, []);
    populateReuseSelect(driverReuseSelect, []);
  }
}
loadCacheLists();

async function deleteCachedEntry(kind: "base" | "driver", hash: string): Promise<void> {
  const res = await fetch(`/api/upload/cache/${kind}/${hash}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to delete cached entry");
  }
}

baseDeleteBtn.addEventListener("click", async () => {
  clearError();
  const hash = baseReuseSelect.value;
  if (!hash) return;
  const label = baseReuseSelect.selectedOptions[0]?.textContent ?? "this cached entry";
  if (!confirm(`Delete cached file?\n\n${label}\n\nThis frees the disk space and removes it from the list.`)) {
    return;
  }
  baseDeleteBtn.disabled = true;
  try {
    await deleteCachedEntry("base", hash);
    await loadCacheLists();
  } catch (e: any) {
    showError(e.message);
  } finally {
    baseDeleteBtn.disabled = false;
  }
});

driverDeleteBtn.addEventListener("click", async () => {
  clearError();
  const hash = driverReuseSelect.value;
  if (!hash) return;
  const label = driverReuseSelect.selectedOptions[0]?.textContent ?? "this cached entry";
  if (!confirm(`Delete cached extraction?\n\n${label}\n\nThis frees the disk space and removes it from the list.`)) {
    return;
  }
  driverDeleteBtn.disabled = true;
  try {
    await deleteCachedEntry("driver", hash);
    await loadCacheLists();
  } catch (e: any) {
    showError(e.message);
  } finally {
    driverDeleteBtn.disabled = false;
  }
});

baseReuseBtn.addEventListener("click", async () => {
  clearError();
  const hash = baseReuseSelect.value;
  if (!hash) return;

  baseReuseBtn.disabled = true;
  try {
    const jobId = await ensureJob();
    const res = await fetch(`/api/upload/${jobId}/base/reuse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to reuse cached base image");
    }
    uploadBaseBtn.textContent = "Using cached ✓";
    uploadBaseBtn.disabled = true;
  } catch (e: any) {
    showError(e.message);
  } finally {
    baseReuseBtn.disabled = false;
  }
});

driverReuseBtn.addEventListener("click", async () => {
  clearError();
  const hash = driverReuseSelect.value;
  if (!hash) return;

  driverReuseBtn.disabled = true;
  try {
    const jobId = await ensureJob();
    const res = await fetch(`/api/upload/${jobId}/driver/reuse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to reuse cached SPP/SSP");
    }
    uploadDriverBtn.textContent = "Using cached ✓";
    uploadDriverBtn.disabled = true;
  } catch (e: any) {
    showError(e.message);
  } finally {
    driverReuseBtn.disabled = false;
  }
});

uploadBaseBtn.addEventListener("click", async () => {
  clearError();
  const input = document.getElementById("baseImage") as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    showError("Choose a base ESXi depot file first.");
    return;
  }

  try {
    const jobId = await ensureJob();
    await uploadWithProgress(
      jobId,
      "base",
      file,
      baseProgressTrack,
      baseProgressFill,
      baseProgressLabel,
      uploadBaseBtn
    );
  } catch (e: any) {
    showError(e.message);
    uploadBaseBtn.disabled = false;
    uploadBaseBtn.textContent = "Upload Base Image";
  }
});

uploadDriverBtn.addEventListener("click", async () => {
  clearError();
  const input = document.getElementById("driverIso") as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    showError("Choose an SPP/SSP driver ISO first.");
    return;
  }

  try {
    const jobId = await ensureJob();
    await uploadWithProgress(
      jobId,
      "driver",
      file,
      driverProgressTrack,
      driverProgressFill,
      driverProgressLabel,
      uploadDriverBtn
    );
  } catch (e: any) {
    showError(e.message);
    uploadDriverBtn.disabled = false;
    uploadDriverBtn.textContent = "Upload Driver ISO";
  }
});

function getSelectedExportFormats(): string[] {
  const formats: string[] = [];
  if ((document.getElementById("formatIso") as HTMLInputElement).checked) formats.push("iso");
  if ((document.getElementById("formatBundle") as HTMLInputElement).checked) formats.push("bundle");
  return formats;
}

buildBtn.addEventListener("click", async () => {
  clearError();
  if (!currentJobId) return;

  const selectedPackageNames = getSelectedPackageNames();
  if (selectedPackageNames.length === 0) {
    showError("Select at least one driver package.");
    return;
  }

  const exportFormats = getSelectedExportFormats();
  if (exportFormats.length === 0) {
    showError("Select at least one export format (ISO and/or vLCM bundle).");
    return;
  }

  buildBtn.disabled = true;
  buildBtn.textContent = "Building...";

  try {
    const res = await fetch(`/api/jobs/${currentJobId}/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedPackageNames, exportFormats }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Build failed to start");
    }
    pollTimer = window.setInterval(() => poll(currentJobId!), 2000);
  } catch (e: any) {
    showError(e.message);
    buildBtn.disabled = false;
    buildBtn.textContent = "Build Custom ISO";
  }
});
