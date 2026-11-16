/**
 * Discover provider and unit files on disk and compute diagnostics.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { FileEntry, WorkspaceIndex } from "./index";
import { unitFormat } from "./namespace";
import { resolve } from "./resolve";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "build",
  ".tox",
  "venv",
  ".venv",
  "parts",
  "stage",
  "prime",
  "__pycache__",
]);

function walk(root: string, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

/** Tracked and untracked-but-not-ignored files, or a filtered walk. */
export function listFiles(root: string): string[] {
  try {
    const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split("\0")
      .filter((f) => f)
      .map((f) => path.join(root, f));
  } catch {
    const out: string[] = [];
    walk(root, out);
    return out;
  }
}

export function isManagePy(file: string): boolean {
  return path.basename(file) === "manage.py";
}

/** Index all providers and unit files found under the given roots. */
export function indexRoots(index: WorkspaceIndex, roots: string[]) {
  const files = roots.flatMap(listFiles);
  for (const file of files.filter(isManagePy)) {
    index.setProvider(file, fs.readFileSync(file, "utf8"));
  }
  for (const file of files) {
    if (unitFormat(file) && index.isUnitFile(file)) {
      index.updateFile(file, fs.readFileSync(file, "utf8"));
    }
  }
}

export interface OffsetDiagnostic {
  start: number;
  end: number;
  message: string;
  severity: "error" | "warning";
}

export function fileDiagnostics(index: WorkspaceIndex, entry: FileEntry): OffsetDiagnostic[] {
  const result: OffsetDiagnostic[] = entry.parseErrors.map((e) => ({ ...e, severity: "error" }));
  for (const unit of entry.units) {
    result.push(...unit.problems);
    for (const ref of unit.references) {
      const problem = resolve(index, ref).problem;
      if (problem) {
        result.push({ start: ref.start, end: ref.end, ...problem });
      }
    }
  }
  return result;
}
