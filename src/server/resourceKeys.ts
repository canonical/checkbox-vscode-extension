/**
 * Keys of the records printed by resource jobs (`res.key` in requires and
 * template-filter, `{key}` in templates), found without running anything:
 *
 * - "command": echo/printf/heredoc output of the job command;
 * - "script": provider bin/ scripts it runs (shell scripts are read like
 *   commands, Python scripts by scripts/resource_keys.py, see
 *   WorkspaceIndex.scriptKeys);
 * - "usage": keys other units use (never makes a key set complete);
 * - "manifest": the resource keys of manifest entries.
 */

import * as fs from "fs";
import * as path from "path";
import { ValueLine } from "./model";
import { ScriptAnalysis, WorkspaceIndex } from "./index";
import { MANIFEST_RESOURCE } from "./references";
import { ShellOutput, shellOutput } from "./shellOutput";

export interface KeySource {
  kind: "command" | "script" | "usage" | "manifest";
  file: string;
  start: number;
  end: number;
}

export interface ResourceKeys {
  keys: Map<string, KeySource[]>;
  /** True when the job is known to print no other key. */
  complete: boolean;
}

/** Nested shell scripts followed before giving up. */
const MAX_DEPTH = 4;

/** Output of scripts/resource_keys.py for one script. */
export interface RawScriptAnalysis {
  keys: { name: string; line: number; col: number }[];
  complete: boolean;
}

/** Converts helper positions (1-based line, UTF-8 column) to offsets. */
export function scriptAnalysis(text: string, raw: RawScriptAnalysis): ScriptAnalysis {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  const keys = raw.keys.map(({ name, line, col }) => {
    const lineStart = starts[line - 1] ?? 0;
    const lineText = text.slice(lineStart, starts[line] ?? text.length);
    const column = Buffer.from(lineText, "utf8").subarray(0, col).toString("utf8").length;
    // The position is the string literal the key comes from
    const found = lineText.indexOf(name, column);
    const start = lineStart + (found === -1 ? column : found);
    return { name, start, end: start + (found === -1 ? 0 : name.length) };
  });
  return { keys, complete: raw.complete };
}

function linesOf(text: string): ValueLine[] {
  let offset = 0;
  return text.split("\n").map((line) => {
    const value = { text: line, offset };
    offset += line.length + 1;
    return value;
  });
}

type ScriptKind = "python" | "shell" | "other";

function scriptKind(file: string, text: string): ScriptKind {
  const shebang = /^#!(.*)/.exec(text)?.[1] ?? "";
  if (file.endsWith(".py") || /python/.test(shebang)) {
    return "python";
  }
  if (file.endsWith(".sh") || /\b(ba|da)?sh\b/.test(shebang)) {
    return "shell";
  }
  return "other";
}

function readText(file: string): string | undefined {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** Provider executable run as `name` from `file`, like PATH lookup. */
export function findScript(index: WorkspaceIndex, name: string, file: string): string | undefined {
  if (name.includes("/") || name === "") {
    return undefined;
  }
  return index
    .binDirs(file)
    .map((dir) => path.join(dir, name))
    .find((candidate) => fs.existsSync(candidate));
}

class Collector {
  readonly keys = new Map<string, KeySource[]>();
  complete = true;
  /** Python scripts the result depends on. */
  readonly pythonScripts = new Set<string>();
  private readonly seen = new Set<string>();

  constructor(private readonly index: WorkspaceIndex) {}

  add(name: string, source: KeySource) {
    const list = this.keys.get(name);
    if (!list) {
      this.keys.set(name, [source]);
    } else if (!list.some((s) => s.file === source.file && s.start === source.start)) {
      list.push(source);
    }
  }

  output(output: ShellOutput, file: string, kind: "command" | "script", depth = 0) {
    this.complete &&= output.complete;
    for (const key of output.keys) {
      this.add(key.name, { kind, file, start: key.start, end: key.end });
    }
    for (const command of output.commands) {
      const script = findScript(this.index, command.name, file);
      if (!script || !this.script(script, depth)) {
        this.complete = false;
        // e.g. the "key: " strings of an awk program
        for (const key of command.keys) {
          this.add(key.name, { kind, file, start: key.start, end: key.end });
        }
      }
    }
  }

  /** Adds the keys printed by a script; false if it cannot be analysed. */
  private script(file: string, depth: number): boolean {
    const text = readText(file);
    if (text === undefined) {
      return false;
    }
    const kind = scriptKind(file, text);
    if (kind === "python") {
      this.pythonScripts.add(file);
      const analysis = this.index.scriptKeys.get(file);
      if (!analysis) {
        return false;
      }
      this.complete &&= analysis.complete;
      for (const key of analysis.keys) {
        this.add(key.name, { kind: "script", file, start: key.start, end: key.end });
      }
      return true;
    }
    if (kind === "shell" && depth < MAX_DEPTH) {
      if (!this.seen.has(file)) {
        this.seen.add(file);
        this.output(shellOutput(linesOf(text)), file, "script", depth + 1);
      }
      return true;
    }
    return false;
  }
}

interface Cache {
  version: number;
  /** Keys used per resource id. */
  usage: Map<string, { key: string; source: KeySource }[]>;
  results: Map<string, ResourceKeys>;
}

const caches = new WeakMap<WorkspaceIndex, Cache>();

function cacheFor(index: WorkspaceIndex): Cache {
  let cache = caches.get(index);
  if (!cache || cache.version !== index.version) {
    const usage: Cache["usage"] = new Map();
    for (const entry of index.files.values()) {
      for (const unit of entry.units) {
        for (const { target, key, start, end } of unit.resourceAttrs) {
          const list = usage.get(target) ?? [];
          list.push({ key, source: { kind: "usage", file: entry.file, start, end } });
          usage.set(target, list);
        }
      }
    }
    cache = { version: index.version, usage, results: new Map() };
    caches.set(index, cache);
  }
  return cache;
}

function collect(index: WorkspaceIndex, id: string): Collector {
  const collector = new Collector(index);
  let printers = 0;
  for (const def of index.definitions(id)) {
    if (def.plugin !== "resource") {
      continue;
    }
    printers++;
    if (def.unit.output) {
      collector.output(def.unit.output, def.file, "command");
    } else {
      collector.complete = false;
    }
  }
  for (const template of index.templates()) {
    if (template.idRegex?.test(id) && template.unit.plugin === "resource") {
      printers++;
      collector.complete = false;
      if (template.unit.output) {
        collector.output(template.unit.output, template.file, "command");
      }
    }
  }
  if (id === MANIFEST_RESOURCE) {
    collector.complete = false;
    for (const entry of index.files.values()) {
      for (const unit of entry.units) {
        if (unit.kind === "manifest entry" && unit.resourceKey) {
          collector.add(unit.resourceKey, { kind: "manifest", file: entry.file, start: unit.idStart, end: unit.idEnd });
        }
      }
    }
  } else if (printers === 0) {
    collector.complete = false;
  }
  return collector;
}

/** Keys of the records printed by resource job `id`. */
export function resourceKeys(index: WorkspaceIndex, id: string): ResourceKeys {
  const cache = cacheFor(index);
  let result = cache.results.get(id);
  if (!result) {
    const collector = collect(index, id);
    for (const { key, source } of cache.usage.get(id) ?? []) {
      collector.add(key, source);
    }
    result = { keys: collector.keys, complete: collector.complete };
    cache.results.set(id, result);
  }
  return result;
}

/** Python scripts run by resource jobs (to analyse with the helper). */
export function resourcePythonScripts(index: WorkspaceIndex): Set<string> {
  const scripts = new Set<string>();
  for (const entry of index.files.values()) {
    for (const unit of entry.units) {
      if (unit.output) {
        const collector = new Collector(index);
        collector.output(unit.output, entry.file, "command");
        collector.pythonScripts.forEach((s) => scripts.add(s));
      }
    }
  }
  return scripts;
}
