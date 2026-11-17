/**
 * Find all references: every reference in the workspace that resolves to
 * the unit at the cursor.
 */

import { FileEntry, WorkspaceIndex } from "./index";
import { refersTo, resolve, Targets } from "./resolve";

export interface Span {
  file: string;
  start: number;
  end: number;
}

/**
 * Units named at `offset`: the unit whose id (or generated sibling id) is
 * under the cursor, or the units a reference under the cursor resolves to.
 */
export function targetsAt(index: WorkspaceIndex, entry: FileEntry, offset: number): Targets | undefined {
  const at = (r: { start: number; end: number }) => r.start <= offset && offset <= r.end;
  const unit = entry.units.find(at);
  if (!unit) {
    return undefined;
  }
  const ref = unit.references.find(at);
  if (ref) {
    const { definitions, templates } = resolve(index, ref);
    return { definitions, templates };
  }
  if (unit.kind === "template" && at({ start: unit.idStart, end: unit.idEnd })) {
    return { definitions: [], templates: index.templates().filter((t) => t.unit === unit) };
  }
  const id = at({ start: unit.idStart, end: unit.idEnd }) ? unit.id : unit.generated.find(at)?.id;
  return id ? { definitions: index.definitions(id), templates: [] } : undefined;
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
