export type ExportFormat = "iso" | "bundle";

export type JobPhase =
  | "uploaded"
  | "extracting"
  | "inspecting"
  | "ready_for_selection"
  | "building"
  | "done"
  | "error";

export interface CandidatePackage {
  name: string;
  vendor: string;
  version: string;
  vibId: string;
  sourceFile: string; // depot zip/vib path this package came from
}

export interface JobState {
  id: string;
  phase: JobPhase;
  log: string[];
  baseImagePath?: string;
  baseOriginalName?: string;
  driverIsoPath?: string;
  driverOriginalName?: string;
  extractDir?: string;
  vibs?: { path: string; originalName: string; hash: string }[];
  baseReady?: boolean;
  driverReady?: boolean;
  candidateDepotFiles?: string[]; // zip/vib files found & successfully loaded as depots
  candidatePackages?: CandidatePackage[];
  selectedPackages?: { name: string; version: string }[];
  exportFormats?: ExportFormat[];
  outputIsoPath?: string;
  outputBundlePath?: string;
  profileName?: string;
  creator?: string;
  description?: string;
  error?: string;
}
