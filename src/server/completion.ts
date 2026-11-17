/**
 * Completion of unit ids in test plan "include", "bootstrap_include" and
 * "nested_part" fields.
 */

import { WorkspaceIndex } from "./index";
import { namespaceOf } from "./namespace";
import { Constraint, UnitInfo } from "./references";
import { satisfies } from "./resolve";

/** Completed fields and the units they may reference. */
const FIELDS = {
  include: "include",
  bootstrap_include: "bootstrap",
  nested_part: "test plan",
} satisfies Record<string, Constraint>;

export type CompletionField = keyof typeof FIELDS;

export interface CompletionContext {
  field: CompletionField;
  /** Text typed so far and its document offset. */
  prefix: string;
  start: number;
}

export interface Candidate {
  label: string;
  kind: "job" | "template" | "test plan";
  summary?: string;
}

const KEY_RE = /^_?([A-Za-z][\w-]*)\s*:(.*)$/;

/**
 * The field being edited at `offset`, found from the text rather than the
 * parsed units because the line being typed may not parse yet. Fields are
 * at column 0 in both PXU and YAML units; value lines are indented.
 */
function fieldAt(text: string, offset: number): { field: string; value: string } | undefined {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const before = text.slice(lineStart, offset);
  const key = KEY_RE.exec(before);
  if (key) {
    return { field: key[1], value: key[2] };
  }
  if (!/^\s/.test(before)) {
    return undefined;
  }
  let end = lineStart - 1;
  while (end > 0) {
    const start = text.lastIndexOf("\n", end - 1) + 1;
    const line = text.slice(start, end);
    end = start - 1;
    if (line.startsWith("#") || /^\s/.test(line) || line === "") {
      continue;
    }
    const match = KEY_RE.exec(line);
    return match ? { field: match[1], value: before } : undefined;
  }
  return undefined;
}

export function completionContext(text: string, offset: number, unit: UnitInfo | undefined): CompletionContext | undefined {
  if (unit?.kind !== "test plan") {
    return undefined;
  }
  const found = fieldAt(text, offset);
  if (!found || !(found.field in FIELDS)) {
    return undefined;
  }
  const field = found.field as CompletionField;
  // Drop indentation and a YAML list marker
  const value = found.value.replace(/^\s*(-\s+)?/, "");
  if (/^[|>"']/.test(value)) {
    return undefined;
  }
  let prefix: string;
  if (field === "include") {
    // Only the pattern, not the "field=value" overrides after it
    if (/\s/.test(value)) {
      return undefined;
    }
    prefix = value;
  } else {
    prefix = /[^\s,]*$/.exec(value)?.[0] ?? "";
  }
  return { field, prefix, start: offset - prefix.length };
}

/** Ids that may appear in the field; ids in `namespace` are partial. */
export function completionCandidates(
  index: WorkspaceIndex,
  context: CompletionContext,
  namespace: string | undefined,
): Candidate[] {
  const qualified = context.prefix.includes("::");
  const label = (id: string) =>
    !qualified && namespace && namespaceOf(id) === namespace ? id.slice(namespace.length + 2) : id;
  const candidates = new Map<string, Candidate>();
  const add = (id: string, kind: Candidate["kind"], summary?: string) => {
    const text = label(id);
    if (!candidates.has(text)) {
      candidates.set(text, { label: text, kind, summary });
    }
  };
  const constraint = FIELDS[context.field];
  for (const id of index.allIds()) {
    const def = index.definitions(id).find((d) => satisfies(constraint, d));
    if (def) {
      add(id, context.field === "nested_part" ? "test plan" : "job", def.summary ?? def.unit.name);
    }
  }
  if (context.field === "include") {
    for (const template of index.templates()) {
      for (const id of template.templateIds) {
        add(id, "template", template.unit.summary);
      }
    }
  }
  return [...candidates.values()];
}
