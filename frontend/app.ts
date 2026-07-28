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

// --- Toast notifications ---
const toastContainer = document.getElementById("toastContainer")!;

function showToast(message: string, type: "info" | "success" | "error" = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 200);
  }, 5000);
}

// --- Task tracking (persisted in localStorage so a reload doesn't lose the list) ---
interface TrackedTask {
  id: string;
  label: string;
  createdAt: string;
}

const TASKS_STORAGE_KEY = "esxiBuilderTrackedTasks";

function getTrackedTasks(): TrackedTask[] {
  try {
    return JSON.parse(localStorage.getItem(TASKS_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveTrackedTasks(tasks: TrackedTask[]) {
  localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(tasks));
}

function trackTask(id: string, label: string) {
  const tasks = getTrackedTasks();
  if (!tasks.some((t) => t.id === id)) {
    tasks.unshift({ id, label, createdAt: new Date().toISOString() });
    saveTrackedTasks(tasks);
  }
  renderTasksCount();
}

function updateTaskLabel(id: string, label: string) {
  const tasks = getTrackedTasks();
  const task = tasks.find((t) => t.id === id);
  if (task) {
    task.label = label;
    saveTrackedTasks(tasks);
  }
}

function untrackTask(id: string) {
  saveTrackedTasks(getTrackedTasks().filter((t) => t.id !== id));
  renderTasksCount();
}

function renderTasksCount() {
  const count = getTrackedTasks().length;
  const countEl = document.getElementById("tasksCount")!;
  countEl.textContent = String(count);
  countEl.classList.toggle("hidden", count === 0);
}
renderTasksCount();

// Avoid re-toasting the same phase transition on every 2s poll tick.
const lastNotifiedPhase = new Map<string, string>();
function notifyPhaseChange(jobId: string, phase: string, extra?: string) {
  if (lastNotifiedPhase.get(jobId) === phase) return;
  lastNotifiedPhase.set(jobId, phase);
  const shortId = jobId.split("-")[0];
  if (phase === "ready_for_selection") showToast(`Job ${shortId}: drivers ready to select`, "success");
  else if (phase === "building") showToast(`Job ${shortId}: build started`, "info");
  else if (phase === "done") showToast(`Job ${shortId}: build complete — ready to download`, "success");
  else if (phase === "error") showToast(`Job ${shortId} failed: ${extra ?? "unknown error"}`, "error");
}

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

/**
 * Best-effort VIB version comparator: splits on '.' and '-' and compares
 * segment by segment, numerically when both sides of a segment are pure
 * digits, lexically otherwise. VIB version strings mix numeric and
 * alphanumeric segments (e.g. "2.1.34.0-1OEM.700.1.0.15843807"), so this
 * isn't a guaranteed-correct semver comparison — it's a heuristic for
 * picking a sensible default radio selection. The person can always
 * override it by clicking the other version's radio button.
 */
function compareVibVersions(a: string, b: string): number {
  const segsA = a.split(/[.-]/);
  const segsB = b.split(/[.-]/);
  const len = Math.max(segsA.length, segsB.length);
  for (let i = 0; i < len; i++) {
    const sa = segsA[i] ?? "";
    const sb = segsB[i] ?? "";
    const na = /^\d+$/.test(sa) ? parseInt(sa, 10) : null;
    const nb = /^\d+$/.test(sb) ? parseInt(sb, 10) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

function renderPackages(packages: CandidatePackage[]) {
  packagePlaceholder.classList.add("hidden");
  selectAllRow.classList.remove("hidden");
  packageList.innerHTML = "";

  // Group by driver name — an offline bundle can carry multiple versions of
  // the same VIB (e.g. from different SSP releases layered together).
  const groups = new Map<string, CandidatePackage[]>();
  for (const pkg of packages) {
    if (!groups.has(pkg.name)) groups.set(pkg.name, []);
    groups.get(pkg.name)!.push(pkg);
  }

  let rowIdx = 0;
  for (const [name, versions] of groups) {
    if (versions.length === 1) {
      const pkg = versions[0];
      const row = document.createElement("div");
      row.className = "package-row";
      row.innerHTML = `
        <input type="checkbox" id="pkg-${rowIdx}" data-name="${pkg.name}" data-version="${pkg.version}" checked />
        <label for="pkg-${rowIdx}" style="font-weight:normal; margin:0;">
          ${pkg.name} <span style="color:#888;">(${pkg.vendor}, v${pkg.version})</span>
        </label>
      `;
      packageList.appendChild(row);
      rowIdx++;
    } else {
      // Multiple versions of the same driver: radio group, highest version
      // (per the heuristic comparator above) checked by default.
      const sorted = [...versions].sort((x, y) => compareVibVersions(y.version, x.version));
      const groupName = `group-${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;

      const wrapper = document.createElement("div");
      wrapper.className = "package-group";
      sorted.forEach((pkg, i) => {
        const row = document.createElement("div");
        row.className = "package-row";
        row.innerHTML = `
          <input type="radio" name="${groupName}" id="pkg-${rowIdx}" data-name="${pkg.name}" data-version="${pkg.version}" ${i === 0 ? "checked" : ""} />
          <label for="pkg-${rowIdx}" style="font-weight:normal; margin:0;">
            ${pkg.name} <span style="color:#888;">(${pkg.vendor}, v${pkg.version})</span>
          </label>
        `;
        wrapper.appendChild(row);
        rowIdx++;
      });
      packageList.appendChild(wrapper);
    }
  }

  updateSelectionCount();
}

const selectionCountEl = document.getElementById("selectionCount")!;

function updateSelectionCount() {
  const names = new Set(
    Array.from(packageList.querySelectorAll("input[type=checkbox], input[type=radio]")).map(
      (el) => (el as HTMLInputElement).dataset.name
    )
  );
  const total = names.size;
  if (total === 0) {
    selectionCountEl.textContent = "";
    return;
  }
  const selectedNames = new Set(
    Array.from(packageList.querySelectorAll("input[type=checkbox]:checked, input[type=radio]:checked")).map(
      (el) => (el as HTMLInputElement).dataset.name
    )
  );
  selectionCountEl.textContent = `${selectedNames.size}/${total} selected`;
}

// Delegated listener: covers all checkboxes/radios, including ones added after a re-render.
packageList.addEventListener("change", (e) => {
  if ((e.target as HTMLElement)?.matches('input[type="checkbox"], input[type="radio"]')) {
    updateSelectionCount();
  }
});

document.getElementById("selectAllBtn")?.addEventListener("click", () => {
  // Only meaningful for single-version drivers — a radio group always has
  // exactly one version selected by design.
  packageList.querySelectorAll("input[type=checkbox]").forEach((el) => ((el as HTMLInputElement).checked = true));
  updateSelectionCount();
});

document.getElementById("selectNoneBtn")?.addEventListener("click", () => {
  packageList.querySelectorAll("input[type=checkbox]").forEach((el) => ((el as HTMLInputElement).checked = false));
  updateSelectionCount();
});

interface SelectedPackage {
  name: string;
  version: string;
}

function getSelectedPackages(): SelectedPackage[] {
  return Array.from(packageList.querySelectorAll("input[type=checkbox]:checked, input[type=radio]:checked")).map(
    (el) => ({
      name: (el as HTMLInputElement).dataset.name!,
      version: (el as HTMLInputElement).dataset.version!,
    })
  );
}

async function poll(jobId: string) {
  const res = await fetch(`/api/jobs/${jobId}`);
  const job: JobState = await res.json();
  renderLog(job.log ?? []);
  notifyPhaseChange(jobId, job.phase, job.error);

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
    loadOutputsList();
    return;
  }
}

const tasksBtn = document.getElementById("tasksBtn") as HTMLButtonElement;
const tasksPanel = document.getElementById("tasksPanel")!;
const tasksList = document.getElementById("tasksList")!;

async function renderTasksPanel() {
  const tasks = getTrackedTasks();
  if (tasks.length === 0) {
    tasksList.innerHTML = '<p class="tasks-empty">No jobs tracked yet.</p>';
    return;
  }

  // Fetch each tracked job's live phase; treat a failed/404 lookup as "expired"
  // (e.g. the server restarted and its in-memory job store was cleared).
  const rows = await Promise.all(
    tasks.map(async (t) => {
      try {
        const res = await fetch(`/api/jobs/${t.id}`);
        if (!res.ok) return { ...t, phase: "expired" };
        const job: JobState = await res.json();
        return { ...t, phase: job.phase };
      } catch {
        return { ...t, phase: "expired" };
      }
    })
  );

  tasksList.innerHTML = rows
    .map((r) => {
      const isCurrent = r.id === currentJobId;
      return `
        <div class="task-row">
          <span class="task-label" title="${r.label}">${r.label}${isCurrent ? " (current)" : ""}</span>
          <span class="task-badge phase-${r.phase}">${r.phase}</span>
          <button type="button" class="secondary" data-action="view-task" data-id="${r.id}">View</button>
          <button type="button" class="secondary danger" data-action="remove-task" data-id="${r.id}">✕</button>
        </div>
      `;
    })
    .join("");
}

tasksBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  const isHidden = tasksPanel.classList.contains("hidden");
  if (isHidden) {
    tasksPanel.classList.remove("hidden");
    await renderTasksPanel();
  } else {
    tasksPanel.classList.add("hidden");
  }
});

document.addEventListener("click", (e) => {
  if (!tasksPanel.classList.contains("hidden") && !tasksPanel.contains(e.target as Node) && e.target !== tasksBtn) {
    tasksPanel.classList.add("hidden");
  }
});

function switchToJob(jobId: string) {
  currentJobId = jobId;
  clearError();
  downloadSection.classList.add("hidden");
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = window.setInterval(() => poll(jobId), 2000);
  poll(jobId);
  showToast(`Switched to job ${jobId.split("-")[0]}`, "info");
}

tasksList.addEventListener("click", async (e) => {
  const viewBtn = (e.target as HTMLElement)?.closest('[data-action="view-task"]') as HTMLButtonElement | null;
  const removeBtn = (e.target as HTMLElement)?.closest('[data-action="remove-task"]') as HTMLButtonElement | null;

  if (viewBtn) {
    switchToJob(viewBtn.dataset.id!);
    tasksPanel.classList.add("hidden");
  }

  if (removeBtn) {
    untrackTask(removeBtn.dataset.id!);
    await renderTasksPanel();
  }
});

async function ensureJob(): Promise<string> {
  if (currentJobId) return currentJobId;
  const res = await fetch("/api/upload/create", { method: "POST" });
  if (!res.ok) throw new Error("Failed to create job");
  const { jobId } = await res.json();
  currentJobId = jobId;
  trackTask(jobId, `Job ${jobId.split("-")[0]}`);
  showToast(`New job started (${jobId.split("-")[0]})`, "info");
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

interface OutputEntry {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

const outputsPlaceholder = document.getElementById("outputsPlaceholder")!;
const outputsList = document.getElementById("outputsList")!;

function renderOutputsList(entries: OutputEntry[]) {
  if (entries.length === 0) {
    outputsPlaceholder.classList.remove("hidden");
    outputsList.innerHTML = "";
    return;
  }
  outputsPlaceholder.classList.add("hidden");
  outputsList.innerHTML = entries
    .map((e) => {
      const date = new Date(e.createdAt).toLocaleString();
      return `
        <div class="output-row">
          <span class="output-name" title="${e.filename}">${e.filename}</span>
          <span class="output-meta">${formatSize(e.sizeBytes)} — ${date}</span>
          <a href="/api/jobs/outputs/${encodeURIComponent(e.filename)}/download">
            <button type="button" class="secondary">Download</button>
          </a>
          <button type="button" class="secondary danger" data-filename="${e.filename}" data-action="delete-output">Delete</button>
        </div>
      `;
    })
    .join("");
}

async function loadOutputsList() {
  try {
    const res = await fetch("/api/jobs/outputs");
    const entries: OutputEntry[] = await res.json();
    renderOutputsList(entries);
  } catch {
    renderOutputsList([]);
  }
}
loadOutputsList();

outputsList.addEventListener("click", async (e) => {
  const target = (e.target as HTMLElement)?.closest('[data-action="delete-output"]') as HTMLButtonElement | null;
  if (!target) return;
  const filename = target.dataset.filename!;
  if (!confirm(`Delete this built image?\n\n${filename}\n\nThis cannot be undone.`)) return;

  target.disabled = true;
  try {
    const res = await fetch(`/api/jobs/outputs/${encodeURIComponent(filename)}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to delete output");
    }
    await loadOutputsList();
  } catch (err: any) {
    showError(err.message);
    target.disabled = false;
  }
});

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
    const label = driverReuseSelect.selectedOptions[0]?.textContent?.split(" (")[0];
    if (label) updateTaskLabel(jobId, label);
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
    updateTaskLabel(jobId, file.name);
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

  const selectedPackages = getSelectedPackages();
  if (selectedPackages.length === 0) {
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
      body: JSON.stringify({ selectedPackages, exportFormats }),
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
