import { v4 as uuidv4 } from "uuid";
import { JobState } from "../types";

// Small-team internal tool: single-process in-memory job tracking is enough.
// Underlying files still live on disk under DATA_DIR so restarts don't lose uploads.
const jobs = new Map<string, JobState>();

export function createJob(): JobState {
  const job: JobState = {
    id: uuidv4(),
    phase: "uploaded",
    log: [],
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): JobState | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, patch: Partial<JobState>): JobState {
  const existing = jobs.get(id);
  if (!existing) throw new Error(`Unknown job ${id}`);
  const updated = { ...existing, ...patch };
  jobs.set(id, updated);
  return updated;
}

export function appendLog(id: string, line: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.log.push(line);
}
