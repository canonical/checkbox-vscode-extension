/**
 * Find all references: every reference in the workspace that resolves to
 * the unit at the cursor.
 */

import { FileEntry, manifestKeyMatches, WorkspaceIndex } from "./index";
import { isTemplate } from "./references";
import { refersTo, resolve, Targets } from "./resolve";

export interface Span {
  file: string;
  start: number;
  end: number;
}

/**
 * Units named at `offset`: the unit whose id (or generated sibling id) is
 * under the cursor, or the units a reference under the cursor resolves to.
 * A parametric template and its jobs share their text, so all units at
 * `offset` contribute.
 */
export function targetsAt(index: WorkspaceIndex, entry: FileEntry, offset: number): Targets | undefined {
  const at = (r: { start: number; end: number }) => r.start <= offset && offset <= r.end;
  const units = entry.units.filter(at);
  const targets: Targets = { definitions: [], templates: [] };
  const refs = units.flatMap((u) => u.references.filter(at));
  for (const ref of refs) {
    const { definitions, templates } = resolve(index, ref);
    targets.definitions.push(...definitions);
    targets.templates.push(...templates);
  }
  if (refs.length === 0) {
    for (const unit of units) {
      if (isTemplate(unit.kind) && at({ start: unit.idStart, end: unit.idEnd })) {
        targets.templates.push(...index.templates().filter((t) => t.unit === unit));
        continue;
      }
      const id = at({ start: unit.idStart, end: unit.idEnd }) ? unit.id : unit.generated.find(at)?.id;
      if (id) {
        targets.definitions.push(...index.definitions(id));
      }
    }
  }
  return targets.definitions.length > 0 || targets.templates.length > 0 ? targets : undefined;
}

export function findReferences(index: WorkspaceIndex, targets: Targets, includeDeclaration: boolean): Span[] {
  const spans: Span[] = [];
  if (includeDeclaration) {
    spans.push(...targets.definitions.map((d) => ({ file: d.file, start: d.start, end: d.end })));
    for (const unit of new Set(targets.templates.map((t) => t.unit))) {
      const file = targets.templates.find((t) => t.unit === unit)!.file;
      spans.push({ file, start: unit.idStart, end: unit.idEnd });
    }
  }
  for (const entry of index.files.values()) {
    for (const unit of entry.units) {
      for (const ref of unit.references) {
        if (refersTo(ref, targets)) {
          spans.push({ file: entry.file, start: ref.start, end: ref.end });
        }
      }
    }
  }
  return spans;
}

/**
 * Resource keys named at `offset`: a manifest entry's id, or a
 * `manifest.<key>` in a resource expression (the keys of the entries it
 * names, or the key itself if no entry defines it).
 */
export function manifestKeysAt(index: WorkspaceIndex, entry: FileEntry, offset: number): string[] | undefined {
  const at = (r: { start: number; end: number }) => r.start <= offset && offset <= r.end;
  const units = entry.units.filter(at);
  const entryUnit = units.find((u) => u.kind === "manifest entry" && at({ start: u.idStart, end: u.idEnd }));
  if (entryUnit?.resourceKey) {
    return [entryUnit.resourceKey];
  }
  const ref = units.flatMap((u) => u.manifestRefs.filter(at))[0];
  if (!ref) {
    return undefined;
  }
  const keys = index.manifestUnits(ref.key).map(({ unit }) => unit.resourceKey!);
  return keys.length > 0 ? keys : [ref.key];
}

/** Every `manifest.<key>` that names one of `keys`. */
export function findManifestReferences(index: WorkspaceIndex, keys: string[], includeDeclaration: boolean): Span[] {
  const named = (key: string) => keys.some((k) => key === k || manifestKeyMatches(key, k));
  const spans: Span[] = [];
  for (const entry of index.files.values()) {
    for (const unit of entry.units) {
      if (includeDeclaration && unit.kind === "manifest entry" && keys.includes(unit.resourceKey!)) {
        spans.push({ file: entry.file, start: unit.idStart, end: unit.idEnd });
      }
      for (const ref of unit.manifestRefs) {
        if (named(ref.key)) {
          spans.push({ file: entry.file, start: ref.start, end: ref.end });
        }
      }
    }
  }
  return spans;
}
