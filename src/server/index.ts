/**
 * Workspace-wide index of units, keyed by qualified id.
 */

import * as path from "path";
import { ParseError } from "./model";
import { namespaceDeclaration, NamespaceDeclaration, Provider, providerFor, unitFormat } from "./namespace";
import { parsePxu } from "./parsers/pxu";
import { parseYaml } from "./parsers/yaml";
import { extractUnits, UnitInfo } from "./references";
import { PrintedKey } from "./shellOutput";

/** Keys a provider script prints (from scripts/resource_keys.py). */
export interface ScriptAnalysis {
  keys: PrintedKey[];
  complete: boolean;
}

export interface FileEntry {
  file: string;
  text: string;
  namespace?: string;
  units: UnitInfo[];
  parseErrors: ParseError[];
}

/** A place where a unit id is defined. */
export interface Definition {
  /** Qualified id being defined. */
  id: string;
  file: string;
  start: number;
  end: number;
  unit: UnitInfo;
  /** Plugin of the defined job (differs from unit.plugin for siblings). */
  plugin?: string;
  /** Summary of the defined job (differs from unit.summary for siblings). */
  summary?: string;
}

export interface TemplateDef {
  file: string;
  unit: UnitInfo;
  /** Matches ids of instantiated jobs. */
  idRegex?: RegExp;
  /** Template ids, including generated after-suspend variants. */
  templateIds: string[];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex matching ids instantiated from a template id with placeholders. */
export function templateIdRegex(id: string): RegExp | undefined {
  const placeholder = /\{\{[^}]*\}\}|\{[^}]*\}/g;
  if (!placeholder.test(id)) {
    return undefined;
  }
  const parts = id.split(placeholder).map(escapeRegex);
  return new RegExp(`^${parts.join(".+")}$`);
}

/** Whether a `manifest.<key>` (may have placeholders) names `resourceKey`. */
export function manifestKeyMatches(key: string, resourceKey: string | undefined): boolean {
  if (resourceKey === undefined) {
    return false;
  }
  const regex = templateIdRegex(key);
  return regex ? regex.test(resourceKey) : key === resourceKey;
}

export class WorkspaceIndex {
  private providers = new Map<string, Provider>();
  readonly files = new Map<string, FileEntry>();
  /** Python script analyses by path; change through setScript. */
  readonly scriptKeys = new Map<string, ScriptAnalysis>();
  /** Bumped whenever units, providers or scripts change. */
  version = 0;
  /** keepTemplated: see extractUnit. */
  constructor(private readonly keepTemplated = false) {}

  private invalidate() {
    this.cache = undefined;
    this.version++;
  }

  setScript(file: string, analysis: ScriptAnalysis | undefined) {
    if (analysis) {
      this.scriptKeys.set(file, analysis);
    } else {
      this.scriptKeys.delete(file);
    }
    this.version++;
  }

  /**
   * Directories searched for a provider executable run by a unit or script
   * in `file`: its own provider's bin first, then every provider's (all are
   * on PATH when Checkbox runs a job).
   */
  binDirs(file: string): string[] {
    const roots = [...this.providers.keys()];
    const own = roots
      .filter((root) => file.startsWith(root + path.sep))
      .sort((a, b) => b.length - a.length)[0];
    const dirs = own ? [own, ...roots.filter((r) => r !== own)] : roots;
    return dirs.map((root) => path.join(root, "bin"));
  }

  private cache?: {
    ids: Map<string, Definition[]>;
    templates: TemplateDef[];
    namespaces: Set<string>;
  };

  setProvider(managePy: string, text: string): boolean {
    const declaration = namespaceDeclaration(managePy, text);
    const root = path.dirname(managePy);
    if (!declaration) {
      return this.removeProvider(managePy);
    }
    const namespace = declaration.namespace;
    const previous = this.providers.get(root);
    this.providers.set(root, { root, namespace, declaration });
    if (previous?.namespace !== namespace) {
      this.reassignNamespaces();
      return true;
    }
    this.invalidate();
    return false;
  }

  /** Manifest entry units exposing the given manifest resource attribute. */
  manifestEntries(key: string): { file: string; start: number; end: number }[] {
    return this.manifestUnits(key).map(({ file, unit }) => ({ file, start: unit.idStart, end: unit.idEnd }));
  }

  /** Manifest entry units whose resource key matches `key` (may have placeholders). */
  manifestUnits(key: string): { file: string; unit: UnitInfo }[] {
    return [...this.files.values()].flatMap((entry) =>
      entry.units
        .filter((u) => u.kind === "manifest entry" && manifestKeyMatches(key, u.resourceKey))
        .map((unit) => ({ file: entry.file, unit })),
    );
  }

  /** Where each provider using a namespace declares it. */
  namespaceDeclarations(namespace: string): NamespaceDeclaration[] {
    return [...this.providers.values()]
      .filter((p) => p.namespace === namespace)
      .map((p) => p.declaration);
  }

  removeProvider(managePy: string): boolean {
    const root = path.dirname(managePy);
    if (this.providers.delete(root)) {
      this.reassignNamespaces();
      return true;
    }
    return false;
  }

  private reassignNamespaces() {
    for (const entry of this.files.values()) {
      const namespace = this.namespaceFor(entry.file);
      if (namespace !== entry.namespace) {
        this.updateFile(entry.file, entry.text);
      }
    }
    this.invalidate();
  }

  namespaceFor(file: string): string | undefined {
    return providerFor(file, [...this.providers.values()])?.namespace;
  }

  /** Whether the file is a unit source of a known provider. */
  isUnitFile(file: string): boolean {
    return unitFormat(file) !== undefined && this.namespaceFor(file) !== undefined;
  }

  updateFile(file: string, text: string): FileEntry {
    const namespace = this.namespaceFor(file);
    const format = unitFormat(file);
    const entry: FileEntry = { file, text, namespace, units: [], parseErrors: [] };
    if (namespace && format) {
      const parsed = format === "pxu" ? parsePxu(text) : parseYaml(text);
      entry.parseErrors = parsed.errors;
      entry.units = parsed.units.flatMap((unit) => extractUnits(unit, namespace, this.keepTemplated));
    }
    this.files.set(file, entry);
    this.invalidate();
    return entry;
  }

  removeFile(file: string) {
    if (this.files.delete(file)) {
      this.invalidate();
    }
  }

  private build() {
    if (this.cache) {
      return this.cache;
    }
    const ids = new Map<string, Definition[]>();
    const templates: TemplateDef[] = [];
    const namespaces = new Set([...this.providers.values()].map((p) => p.namespace));
    const add = (id: string, fields: Omit<Definition, "id">) => {
      const definition = { id, ...fields };
      const list = ids.get(id);
      if (list) {
        list.push(definition);
      } else {
        ids.set(id, [definition]);
      }
    };
    for (const entry of this.files.values()) {
      for (const unit of entry.units) {
        if (unit.kind === "parametric template") {
          // Its jobs are known (separate units): only the template id is open-ended
          templates.push({ file: entry.file, unit, templateIds: unit.templateId ? [unit.templateId] : [] });
          continue;
        }
        if (unit.kind === "template") {
          const suspendPrefixes = unit.generated
            .map((g) => g.id.slice(g.id.indexOf("::") + 2))
            .filter((id) => id === `after-suspend-${unit.partialId}` || id === `after-suspend-manual-${unit.partialId}`)
            .map((id) => id.slice(0, id.length - (unit.partialId?.length ?? 0)));
          const templateIds = unit.templateId ? [unit.templateId] : [];
          for (const prefix of suspendPrefixes) {
            if (unit.templateId) {
              const raw = unit.templateId.slice(unit.templateId.indexOf("::") + 2);
              templateIds.push(`${unit.templateId.slice(0, unit.templateId.indexOf("::") + 2)}${prefix}${raw}`);
            }
          }
          templates.push({ file: entry.file, unit, idRegex: unit.id ? templateIdRegex(unit.id) : undefined, templateIds });
          for (const generated of unit.generated) {
            const regex = templateIdRegex(generated.id);
            if (regex) {
              templates.push({ file: entry.file, unit, idRegex: regex, templateIds: [] });
            }
          }
          continue;
        }
        if (unit.id) {
          add(unit.id, { file: entry.file, start: unit.idStart, end: unit.idEnd, unit, plugin: unit.plugin, summary: unit.summary });
        }
        for (const generated of unit.generated) {
          add(generated.id, { file: entry.file, start: generated.start, end: generated.end, unit, plugin: generated.plugin, summary: generated.summary });
        }
      }
    }
    this.cache = { ids, templates, namespaces };
    return this.cache;
  }

  definitions(id: string): Definition[] {
    return this.build().ids.get(id) ?? [];
  }

  allIds(): IterableIterator<string> {
    return this.build().ids.keys();
  }

  templates(): TemplateDef[] {
    return this.build().templates;
  }

  hasNamespace(namespace: string): boolean {
    return this.build().namespaces.has(namespace);
  }
}
