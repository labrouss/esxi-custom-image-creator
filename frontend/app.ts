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

interface VibEntry {
  path: string;
  originalName: string;
  hash: string;
}

interface JobState {
  id: string;
  phase: string;
  log: string[];
  candidatePackages?: CandidatePackage[];
  outputIsoPath?: string;
  outputBundlePath?: string;
  profileName?: string;
  creator?: string;
  description?: string;
  error?: string;
  baseReady?: boolean;
  baseOriginalName?: string;
  driverReady?: boolean;
  driverOriginalName?: string;
  vibs?: VibEntry[];
}

const uploadSection = document.getElementById("upload-section")!;
const selectionSection = document.getElementById("selection-section")!;
const downloadSection = document.getElementById("download-section")!;
const packageList = document.getElementById("package-list")!;
const logEl = document.getElementById("log")!;
const errorEl = document.getElementById("errorMsg")!;
const uploadBaseBtn = document.getElementById("uploadBaseBtn") as HTMLButtonElement;
const uploadDriverBtn = document.getElementById("uploadDriverBtn") as HTMLButtonElement;
const uploadVibBtn = document.getElementById("uploadVibBtn") as HTMLButtonElement;
const baseReuseSelect = document.getElementById("baseReuseSelect") as HTMLSelectElement;
const baseReuseBtn = document.getElementById("baseReuseBtn") as HTMLButtonElement;
const baseDeleteBtn = document.getElementById("baseDeleteBtn") as HTMLButtonElement;
const driverReuseSelect = document.getElementById("driverReuseSelect") as HTMLSelectElement;
const driverReuseBtn = document.getElementById("driverReuseBtn") as HTMLButtonElement;
const driverDeleteBtn = document.getElementById("driverDeleteBtn") as HTMLButtonElement;
const vibReuseSelect = document.getElementById("vibReuseSelect") as HTMLSelectElement;
const vibReuseBtn = document.getElementById("vibReuseBtn") as HTMLButtonElement;
const vibDeleteBtn = document.getElementById("vibDeleteBtn") as HTMLButtonElement;
const baseProgressTrack = document.getElementById("baseProgressTrack")!;
const baseProgressFill = document.getElementById("baseProgressFill")!;
const baseProgressLabel = document.getElementById("baseProgressLabel")!;
const driverProgressTrack = document.getElementById("driverProgressTrack")!;
const driverProgressFill = document.getElementById("driverProgressFill")!;
const driverProgressLabel = document.getElementById("driverProgressLabel")!;
const vibProgressTrack = document.getElementById("vibProgressTrack")!;
const vibProgressFill = document.getElementById("vibProgressFill")!;
const vibProgressLabel = document.getElementById("vibProgressLabel")!;
const addedVibsList = document.getElementById("addedVibsList")!;
const analyzeBtn = document.getElementById("analyzeBtn") as HTMLButtonElement;
const analyzeHint = document.getElementById("analyzeHint")!;
const buildBtn = document.getElementById("buildBtn") as HTMLButtonElement;
const buildProgressTrack = document.getElementById("buildProgressTrack")!;
const buildProgressLabel = document.getElementById("buildProgressLabel")!;
const analyzeProgressTrack = document.getElementById("analyzeProgressTrack")!;
const analyzeProgressLabel = document.getElementById("analyzeProgressLabel")!;
const downloadIsoLink = document.getElementById("downloadIsoLink") as HTMLAnchorElement;
const downloadBundleLink = document.getElementById("downloadBundleLink") as HTMLAnchorElement;

let currentJobId: string | null = null;
let pollTimer: number | null = null;

// --- Onboarding tour ---
interface TourStep {
  targetId: string;
  title: string;
  body: string;
}

const tourSteps: TourStep[] = [
  {
    targetId: "tourStepBase",
    title: "1. Add the base ESXi depot",
    body: "Upload the offline-bundle .zip (not the plain install ISO), or reuse one you've already cached. This is required.",
  },
  {
    targetId: "tourStepDriverVib",
    title: "2. Add drivers",
    body: "Add an SPP/SSP, one or more individual .vib files, or both — at least one is required alongside the base image.",
  },
  {
    targetId: "tourStepAnalyze",
    title: "3. Analyze",
    body: "Once the base image plus a driver source are ready, click Analyze to inspect the depot(s) and pick which drivers to include.",
  },
];

const tourOverlay = document.getElementById("tourOverlay")!;
const tourTooltip = document.getElementById("tourTooltip")!;
const tourProgress = document.getElementById("tourProgress")!;
const tourTitle = document.getElementById("tourTitle")!;
const tourBody = document.getElementById("tourBody")!;
const tourNextBtn = document.getElementById("tourNextBtn") as HTMLButtonElement;
const tourSkipBtn = document.getElementById("tourSkipBtn") as HTMLButtonElement;
const TOUR_SEEN_KEY = "esxiBuilderTourSeen";

let tourStepIndex = 0;
let tourCurrentTarget: HTMLElement | null = null;

function positionTourTooltip() {
  if (!tourCurrentTarget) return;
  const rect = tourCurrentTarget.getBoundingClientRect();
  const tooltipRect = tourTooltip.getBoundingClientRect();
  const margin = 14;

  let top = rect.bottom + margin;
  if (top + tooltipRect.height > window.innerHeight - margin) {
    top = rect.top - tooltipRect.height - margin;
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - tooltipRect.height - margin));

  let left = rect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - tooltipRect.width - margin));

  tourTooltip.style.top = `${top}px`;
  tourTooltip.style.left = `${left}px`;
}

function showTourStep(index: number) {
  if (tourCurrentTarget) tourCurrentTarget.classList.remove("tour-highlight-target");

  const step = tourSteps[index];
  const target = document.getElementById(step.targetId);
  if (!target) return;

  tourCurrentTarget = target;
  target.classList.add("tour-highlight-target");
  target.scrollIntoView({ behavior: "smooth", block: "center" });

  tourProgress.textContent = `Step ${index + 1} of ${tourSteps.length}`;
  tourTitle.textContent = step.title;
  tourBody.textContent = step.body;
  tourNextBtn.textContent = index === tourSteps.length - 1 ? "Done" : "Next";

  // Let the smooth scroll settle before measuring position.
  setTimeout(positionTourTooltip, 350);
}

function endTour() {
  if (tourCurrentTarget) tourCurrentTarget.classList.remove("tour-highlight-target");
  tourCurrentTarget = null;
  tourOverlay.classList.add("hidden");
  window.removeEventListener("resize", positionTourTooltip);
  window.removeEventListener("scroll", positionTourTooltip, true);
  localStorage.setItem(TOUR_SEEN_KEY, "1");
}

function startTour() {
  tourStepIndex = 0;
  tourOverlay.classList.remove("hidden");
  showTourStep(tourStepIndex);
  window.addEventListener("resize", positionTourTooltip);
  window.addEventListener("scroll", positionTourTooltip, true);
}

tourNextBtn.addEventListener("click", () => {
  if (tourStepIndex >= tourSteps.length - 1) {
    endTour();
    return;
  }
  tourStepIndex++;
  showTourStep(tourStepIndex);
});

tourSkipBtn.addEventListener("click", endTour);

document.getElementById("showTourLink")?.addEventListener("click", (e) => {
  e.preventDefault();
  startTour();
});

if (!localStorage.getItem(TOUR_SEEN_KEY)) {
  setTimeout(startTour, 400);
}

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
  if (phase === "ready_for_selection") {
    showToast(`Job ${shortId}: drivers ready to select`, "success");
    setTimeout(focusBuildSection, 0);
  } else if (phase === "building") showToast(`Job ${shortId}: build started`, "info");
  else if (phase === "done") {
    showToast(`Job ${shortId}: build complete — ready to download`, "success");
    setTimeout(focusDownloadSection, 0);
  } else if (phase === "error") showToast(`Job ${shortId} failed: ${extra ?? "unknown error"}`, "error");
}

/** Scrolls to the export-format/build panel and briefly highlights it once analysis finishes. */
function focusBuildSection() {
  const buildSection = document.getElementById("build-section");
  if (!buildSection) return;
  buildSection.scrollIntoView({ behavior: "smooth", block: "center" });
  buildSection.classList.add("tour-highlight-target");
  setTimeout(() => buildSection.classList.remove("tour-highlight-target"), 1600);
}

/** Scrolls to and briefly highlights the download panel once the build finishes. */
function focusDownloadSection() {
  downloadSection.scrollIntoView({ behavior: "smooth", block: "center" });
  downloadSection.classList.add("tour-highlight-target");
  setTimeout(() => downloadSection.classList.remove("tour-highlight-target"), 1600);
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
      // (per the heuristic comparator above) checked by default. A radio
      // can't be natively unchecked once one's selected, so an explicit
      // "don't include this driver" option is added to the same group —
      // otherwise there'd be no way to fully exclude a grouped driver.
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

      const excludeRow = document.createElement("div");
      excludeRow.className = "package-row";
      excludeRow.innerHTML = `
        <input type="radio" name="${groupName}" id="pkg-${rowIdx}" data-exclude="true" />
        <label for="pkg-${rowIdx}" style="font-weight:normal; margin:0; color: var(--text-dim); font-style: italic;">
          Don't include ${name}
        </label>
      `;
      wrapper.appendChild(excludeRow);
      rowIdx++;

      packageList.appendChild(wrapper);
    }
  }

  updateSelectionCount();
}

const selectionCountEl = document.getElementById("selectionCount")!;

function updateSelectionCount() {
  const allInputs = Array.from(
    packageList.querySelectorAll("input[type=checkbox], input[type=radio]")
  ) as HTMLInputElement[];

  // Group membership is driven by shared "name" attribute for radios, and by
  // individual checkboxes for single-version drivers — "exclude" options
  // carry no data-name, so they naturally don't count as a distinct driver.
  const groupKeys = new Set(
    allInputs.map((el) => (el.type === "radio" ? el.name : el.dataset.name)).filter(Boolean)
  );
  const total = groupKeys.size;
  if (total === 0) {
    selectionCountEl.textContent = "";
    return;
  }

  const selectedNames = new Set(allInputs.filter((el) => el.checked && el.dataset.name).map((el) => el.dataset.name));
  selectionCountEl.textContent = `${selectedNames.size}/${total} selected`;
}

// Delegated listener: covers all checkboxes/radios, including ones added after a re-render.
packageList.addEventListener("change", (e) => {
  if ((e.target as HTMLElement)?.matches('input[type="checkbox"], input[type="radio"]')) {
    updateSelectionCount();
  }
});

document.getElementById("selectAllBtn")?.addEventListener("click", () => {
  packageList.querySelectorAll("input[type=checkbox]").forEach((el) => ((el as HTMLInputElement).checked = true));
  // Re-select the highest version (rendered first) in every group, undoing any "exclude" choice.
  packageList.querySelectorAll(".package-group").forEach((group) => {
    const firstVersionRadio = group.querySelector('input[type=radio]:not([data-exclude])') as HTMLInputElement | null;
    if (firstVersionRadio) firstVersionRadio.checked = true;
  });
  updateSelectionCount();
});

document.getElementById("selectNoneBtn")?.addEventListener("click", () => {
  packageList.querySelectorAll("input[type=checkbox]").forEach((el) => ((el as HTMLInputElement).checked = false));
  // Fully deselect every grouped driver via its "exclude" option.
  packageList.querySelectorAll("input[data-exclude]").forEach((el) => ((el as HTMLInputElement).checked = true));
  updateSelectionCount();
});

interface SelectedPackage {
  name: string;
  version: string;
}

function getSelectedPackages(): SelectedPackage[] {
  return Array.from(packageList.querySelectorAll("input[type=checkbox]:checked, input[type=radio]:checked"))
    .filter((el) => (el as HTMLInputElement).dataset.name)
    .map((el) => ({
      name: (el as HTMLInputElement).dataset.name!,
      version: (el as HTMLInputElement).dataset.version!,
    }));
}

function renderAddedVibs(vibs: VibEntry[]) {
  addedVibsList.innerHTML = vibs
    .map(
      (v) => `
        <div class="added-vib-row">
          <span class="added-vib-name">✓ ${v.originalName}</span>
          <button type="button" class="secondary danger" data-action="remove-vib" data-hash="${v.hash}">Remove</button>
        </div>
      `
    )
    .join("");
}

addedVibsList.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement)?.closest('[data-action="remove-vib"]') as HTMLButtonElement | null;
  if (!btn || !currentJobId) return;
  const hash = btn.dataset.hash!;
  btn.disabled = true;
  try {
    await fetch(`/api/upload/${currentJobId}/vib/${hash}`, { method: "DELETE" });
    await poll(currentJobId);
  } catch (e: any) {
    showError(e.message);
    btn.disabled = false;
  }
});

function updateAnalyzeVisibility(job: JobState) {
  const readyToAnalyze = !!job.baseReady && (!!job.driverReady || (job.vibs?.length ?? 0) > 0);
  const analysisAlreadyStarted = job.phase !== "uploaded";
  if (analysisAlreadyStarted) {
    analyzeBtn.classList.add("hidden");
    analyzeHint.classList.add("hidden");
  } else if (readyToAnalyze) {
    analyzeBtn.classList.remove("hidden");
    analyzeHint.classList.add("hidden");
  } else {
    analyzeBtn.classList.add("hidden");
    analyzeHint.classList.remove("hidden");
  }
}

/**
 * Keeps the driver-selection panel's height matched to the upload panel's
 * actual content height, so the right column scrolls internally instead of
 * either stretching the shorter left column to match a long driver list, or
 * growing the whole page unbounded. Left panel content varies (progress
 * bars, reuse rows, added-VIBs list), so this is recalculated whenever
 * either side's content could have changed, rather than set once.
 */
function syncPanelHeight() {
  const leftHeight = uploadSection.getBoundingClientRect().height;
  if (leftHeight > 0) {
    selectionSection.style.maxHeight = `${leftHeight}px`;
  }
}
window.addEventListener("resize", syncPanelHeight);

async function poll(jobId: string) {
  const res = await fetch(`/api/jobs/${jobId}`);
  const job: JobState = await res.json();
  renderLog(job.log ?? []);
  notifyPhaseChange(jobId, job.phase, job.error);
  renderAddedVibs(job.vibs ?? []);
  updateAnalyzeVisibility(job);
  lastKnownDriverName = job.driverOriginalName ?? null;
  lastKnownBaseName = job.baseOriginalName ?? null;
  updateNamingPreviews();
  syncPanelHeight();

  if (job.phase === "building") {
    buildProgressTrack.classList.remove("hidden");
    buildProgressLabel.classList.remove("hidden");
    const lastLine = (job.log ?? [])[job.log.length - 1];
    buildProgressLabel.textContent = lastLine ?? "Building...";
  } else {
    buildProgressTrack.classList.add("hidden");
    buildProgressLabel.classList.add("hidden");
  }

  if (job.phase === "inspecting") {
    analyzeProgressTrack.classList.remove("hidden");
    analyzeProgressLabel.classList.remove("hidden");
    const lastLine = (job.log ?? [])[job.log.length - 1];
    analyzeProgressLabel.textContent = lastLine ?? "Analyzing...";
  } else {
    analyzeProgressTrack.classList.add("hidden");
    analyzeProgressLabel.classList.add("hidden");
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
    renderBuildSummary(job);
    loadOutputsList();
    return;
  }
}

function renderBuildSummary(job: JobState) {
  const rows: { label: string; value: string }[] = [];
  if (job.outputIsoPath) rows.push({ label: "ISO file", value: job.outputIsoPath.split("/").pop()! });
  if (job.outputBundlePath) rows.push({ label: "Bundle file", value: job.outputBundlePath.split("/").pop()! });
  if (job.profileName) rows.push({ label: "Profile name", value: job.profileName });
  if (job.creator) rows.push({ label: "Creator", value: job.creator });
  rows.push({ label: "Description", value: job.description ?? "(inherited from base image)" });

  const buildSummary = document.getElementById("buildSummary")!;
  buildSummary.innerHTML = rows
    .map(
      (r) => `
        <div class="build-summary-row">
          <span class="build-summary-label">${r.label}:</span>
          <span class="build-summary-value">${r.value}</span>
        </div>
      `
    )
    .join("");
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
    const [baseRes, driverRes, vibRes] = await Promise.all([
      fetch("/api/upload/cache/base"),
      fetch("/api/upload/cache/driver"),
      fetch("/api/upload/cache/vib"),
    ]);
    const baseEntries: CachedEntry[] = await baseRes.json();
    const driverEntries: CachedEntry[] = await driverRes.json();
    const vibEntries: CachedEntry[] = await vibRes.json();
    populateReuseSelect(baseReuseSelect, baseEntries);
    populateReuseSelect(driverReuseSelect, driverEntries);
    populateReuseSelect(vibReuseSelect, vibEntries);
  } catch {
    // Non-fatal — reuse is a convenience, not required for the tool to work.
    populateReuseSelect(baseReuseSelect, []);
    populateReuseSelect(driverReuseSelect, []);
    populateReuseSelect(vibReuseSelect, []);
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

async function deleteCachedEntry(kind: "base" | "driver" | "vib", hash: string): Promise<void> {
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

vibDeleteBtn.addEventListener("click", async () => {
  clearError();
  const hash = vibReuseSelect.value;
  if (!hash) return;
  const label = vibReuseSelect.selectedOptions[0]?.textContent ?? "this cached entry";
  if (!confirm(`Delete cached VIB?\n\n${label}\n\nThis frees the disk space and removes it from the list.`)) {
    return;
  }
  vibDeleteBtn.disabled = true;
  try {
    await deleteCachedEntry("vib", hash);
    await loadCacheLists();
  } catch (e: any) {
    showError(e.message);
  } finally {
    vibDeleteBtn.disabled = false;
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
    await poll(jobId);
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
    await poll(jobId);
  } catch (e: any) {
    showError(e.message);
  } finally {
    driverReuseBtn.disabled = false;
  }
});

vibReuseBtn.addEventListener("click", async () => {
  clearError();
  const hash = vibReuseSelect.value;
  if (!hash) return;

  vibReuseBtn.disabled = true;
  try {
    const jobId = await ensureJob();
    const res = await fetch(`/api/upload/${jobId}/vib/reuse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to attach cached VIB");
    }
    await poll(jobId);
  } catch (e: any) {
    showError(e.message);
  } finally {
    vibReuseBtn.disabled = false;
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
    await poll(jobId);
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
    await poll(jobId);
  } catch (e: any) {
    showError(e.message);
    uploadDriverBtn.disabled = false;
    uploadDriverBtn.textContent = "Upload Driver ISO";
  }
});

uploadVibBtn.addEventListener("click", async () => {
  clearError();
  const input = document.getElementById("vibFile") as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    showError("Choose a .vib file first.");
    return;
  }

  try {
    const jobId = await ensureJob();
    await uploadWithProgress(jobId, "vib", file, vibProgressTrack, vibProgressFill, vibProgressLabel, uploadVibBtn);
    // Unlike base/driver, VIBs are additive — re-enable so more can be added.
    uploadVibBtn.disabled = false;
    uploadVibBtn.textContent = "Add VIB";
    input.value = "";
    await poll(jobId);
  } catch (e: any) {
    showError(e.message);
    uploadVibBtn.disabled = false;
    uploadVibBtn.textContent = "Add VIB";
  }
});

analyzeBtn.addEventListener("click", async () => {
  clearError();
  if (!currentJobId) return;
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "Analyzing...";
  try {
    const res = await fetch(`/api/upload/${currentJobId}/analyze`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to start analysis");
    }
  } catch (e: any) {
    showError(e.message);
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analyze";
  }
});

function getSelectedExportFormats(): string[] {
  const formats: string[] = [];
  if ((document.getElementById("formatIso") as HTMLInputElement).checked) formats.push("iso");
  if ((document.getElementById("formatBundle") as HTMLInputElement).checked) formats.push("bundle");
  return formats;
}

// --- Profile naming preview ---
const manualSuffixInput = document.getElementById("manualSuffixInput") as HTMLInputElement;
const namingRadios = Array.from(document.querySelectorAll('input[name="namingMode"]')) as HTMLInputElement[];
const manualCreatorInput = document.getElementById("manualCreatorInput") as HTMLInputElement;
const creatorRadios = Array.from(document.querySelectorAll('input[name="creatorMode"]')) as HTMLInputElement[];
const manualDescriptionInput = document.getElementById("manualDescriptionInput") as HTMLTextAreaElement;
const descriptionRadios = Array.from(document.querySelectorAll('input[name="descriptionMode"]')) as HTMLInputElement[];
let lastKnownDriverName: string | null = null;
let lastKnownBaseName: string | null = null;

/** Mirrors the backend's sanitizeForFilename() so previews match the real output. */
function sanitizeForPreview(name: string): string {
  return name
    .replace(/\.(iso|zip|vib)$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
}

function getSelectedNamingMode(): string {
  return namingRadios.find((r) => r.checked)?.value ?? "jobid";
}
function getSelectedCreatorMode(): string {
  return creatorRadios.find((r) => r.checked)?.value ?? "default";
}
function getSelectedDescriptionMode(): string {
  return descriptionRadios.find((r) => r.checked)?.value ?? "auto";
}

function updateManualInputState() {
  manualSuffixInput.disabled = getSelectedNamingMode() !== "manual";
  manualCreatorInput.disabled = getSelectedCreatorMode() !== "manual";
  manualDescriptionInput.disabled = getSelectedDescriptionMode() !== "manual";
}
namingRadios.forEach((r) => r.addEventListener("change", updateManualInputState));
creatorRadios.forEach((r) => r.addEventListener("change", updateManualInputState));
descriptionRadios.forEach((r) => r.addEventListener("change", updateManualInputState));
updateManualInputState();

manualSuffixInput.addEventListener("focus", () => {
  (document.getElementById("namingManual") as HTMLInputElement).checked = true;
  updateManualInputState();
});
manualCreatorInput.addEventListener("focus", () => {
  (document.getElementById("creatorManual") as HTMLInputElement).checked = true;
  updateManualInputState();
});
manualDescriptionInput.addEventListener("focus", () => {
  (document.getElementById("descManual") as HTMLInputElement).checked = true;
  updateManualInputState();
});

function updateNamingPreviews() {
  const shortId = currentJobId ? currentJobId.split("-")[0] : "job1234";
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const sppSuffix = lastKnownDriverName ? sanitizeForPreview(lastKnownDriverName) : "Custom";

  document.getElementById("previewJobid")!.textContent = `→ ...-${shortId}`;
  document.getElementById("previewSpp")!.textContent = `→ ...-${sppSuffix}`;
  document.getElementById("previewDate")!.textContent = `→ ...-Custom-${dateStr}`;
  document.getElementById("previewCombined")!.textContent = `→ ...-${shortId}-${dateStr}`;

  const driverSourceLabel = lastKnownDriverName
    ? lastKnownDriverName
    : (document.querySelectorAll("#addedVibsList .added-vib-row").length > 0
        ? "individually added VIB(s) only"
        : "none");
  const selectedCount = packageList.querySelectorAll(
    "input[type=checkbox]:checked, input[type=radio]:checked"
  ).length;
  const dateReadable = now.toISOString().slice(0, 10);
  document.getElementById("previewDescAuto")!.textContent =
    `Custom ESXi image built ${dateReadable} via ESXi Custom Image Builder. ` +
    `Base: ${lastKnownBaseName ?? "(not yet uploaded)"}. ` +
    `Driver source: ${driverSourceLabel}. ${selectedCount} driver(s) injected.`;
}
updateNamingPreviews();

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

  const namingMode = getSelectedNamingMode();
  const customSuffix = manualSuffixInput.value.trim();
  if (namingMode === "manual" && !customSuffix) {
    showError("Enter a custom profile name, or choose one of the other naming options.");
    return;
  }

  const creatorMode = getSelectedCreatorMode();
  const customCreator = manualCreatorInput.value.trim();
  if (creatorMode === "manual" && !customCreator) {
    showError("Enter a custom creator name, or use the default.");
    return;
  }

  const descriptionMode = getSelectedDescriptionMode();
  const customDescription = manualDescriptionInput.value.trim();
  if (descriptionMode === "manual" && !customDescription) {
    showError("Enter a custom description, or choose Auto-generated / Inherit.");
    return;
  }

  buildBtn.disabled = true;
  buildBtn.textContent = "Building...";

  try {
    const res = await fetch(`/api/jobs/${currentJobId}/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedPackages,
        exportFormats,
        namingMode,
        customSuffix,
        creatorMode,
        customCreator,
        descriptionMode,
        customDescription,
      }),
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

setTimeout(syncPanelHeight, 300);
