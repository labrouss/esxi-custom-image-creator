import { spawn } from "child_process";
import * as path from "path";

const SCRIPTS_DIR = path.join(__dirname, "..", "..", "scripts");

const JSON_MARKER_RE = /###JSON_START###[\s\S]*?###JSON_END###/;

function runPwsh(scriptName: string, args: string[], onLine?: (line: string) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    const proc = spawn("pwsh", ["-NoLogo", "-NonInteractive", "-File", scriptPath, ...args]);

    let stdout = "";
    let stderr = "";
    let stdoutLeftover = "";
    let stderrLeftover = "";

    const emitLines = (buffer: string, leftover: string, prefix: string): string => {
      const combined = leftover + buffer;
      const lines = combined.split(/\r?\n/);
      const newLeftover = lines.pop() ?? "";
      if (onLine) {
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || JSON_MARKER_RE.test(trimmed)) continue; // skip blank lines and the machine marker
          onLine(prefix ? `${prefix}${trimmed}` : trimmed);
        }
      }
      return newLeftover;
    };

    proc.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      stdoutLeftover = emitLines(chunk, stdoutLeftover, "");
    });
    proc.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      stderrLeftover = emitLines(chunk, stderrLeftover, "[stderr] ");
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      const match = stdout.match(/###JSON_START###([\s\S]*?)###JSON_END###/);
      if (!match) {
        reject(
          new Error(
            `${scriptName} exited ${code} with no parseable output.\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        );
        return;
      }
      try {
        resolve(JSON.parse(match[1]));
      } catch (e) {
        reject(new Error(`Failed to parse JSON from ${scriptName}: ${e}\nRaw: ${match[1]}`));
      }
    });
  });
}

export function inspectDepots(candidateFiles: string[], onLog?: (line: string) => void) {
  return runPwsh("inspect-depots.ps1", ["-CandidateFilesJson", JSON.stringify(candidateFiles)], onLog);
}

export function buildImage(
  opts: {
    baseDepotPath: string;
    driverDepotFiles: string[];
    selectedPackageNames: string[];
    exportFormats: ("iso" | "bundle")[];
    outputIsoPath?: string;
    outputBundlePath?: string;
  },
  onLog?: (line: string) => void
) {
  const args = [
    "-BaseDepotPath",
    opts.baseDepotPath,
    "-DriverDepotFilesJson",
    JSON.stringify(opts.driverDepotFiles),
    "-SelectedPackageNamesJson",
    JSON.stringify(opts.selectedPackageNames),
    "-ExportFormatsJson",
    JSON.stringify(opts.exportFormats),
  ];
  if (opts.outputIsoPath) args.push("-OutputIsoPath", opts.outputIsoPath);
  if (opts.outputBundlePath) args.push("-OutputBundlePath", opts.outputBundlePath);
  return runPwsh("build-image.ps1", args, onLog);
}
