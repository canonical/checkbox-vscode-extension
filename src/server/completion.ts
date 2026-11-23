/**
 * Completion of unit ids in test plan "include", "exclude",
 * "bootstrap_include" and "nested_part" fields, and in template
 * "template-resource".
 */

import { WorkspaceIndex } from "./index";
import { namespaceOf } from "./namespace";
import { toJsRegex } from "./syntax";
import { Constraint, UnitInfo } from "./references";
import { resolve, satisfies } from "./resolve";

/** Completed fields and the units they may reference. */
const FIELDS = {
  include: "include",
  exclude: "include",
  bootstrap_include: "bootstrap",
  nested_part: "test plan",
  "template-resource": "resource",
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
  kind: "job" | "template" | "test plan" | "import";
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
  const found = fieldAt(text, offset);
  if (!found || !(found.field in FIELDS)) {
    return undefined;
  }
  const field = found.field as CompletionField;
  // Parametric templates must not have template-resource
  if (unit?.kind !== (field === "template-resource" ? "template" : "test plan")) {
    return undefined;
  }
  // Drop indentation and a YAML list marker
  const value = found.value.replace(/^\s*(-\s+)?/, "");
  if (/^[|>"']/.test(value)) {
    return undefined;
  }
  let prefix: string;
  if (field === "include" || field === "exclude" || field === "template-resource") {
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
/**
 * Jobs and template ids selected by the include fields of a test plan and,
 * recursively, of its nested parts: the units its exclude field can affect
 * (TestPlanUnit.get_qualifier).
 */
function includedUnits(index: WorkspaceIndex, plan: UnitInfo, seen = new Set<UnitInfo>()): Map<string, Candidate> {
  const included = new Map<string, Candidate>();
  if (seen.has(plan)) {
    return included;
  }
  seen.add(plan);
  for (const ref of plan.references) {
    if (ref.field === "include") {
      const { definitions, templates } = resolve(index, ref);
      for (const def of definitions) {
        included.set(def.id, { label: def.id, kind: "job", summary: def.summary });
      }
      // Only the template ids (or instance id) that the include line names
      const regex = ref.pattern ? new RegExp(toJsRegex(ref.target)) : undefined;
      for (const template of templates) {
        const ids = regex ? template.templateIds.filter((id) => regex.test(id)) : [ref.target];
        for (const id of ids) {
          included.set(id, { label: id, kind: "template", summary: template.unit.summary });
        }
      }
    } else if (ref.field === "nested_part") {
      for (const def of resolve(index, ref).definitions) {
        if (def.unit.kind === "test plan") {
          for (const [id, candidate] of includedUnits(index, def.unit, seen)) {
            included.set(id, candidate);
          }
        }
      }
    }
  }
  return included;
}

/**
 * Ids that may appear in the field; ids in `namespace` are partial.
 * `unit` is the test plan or template being edited.
 */
export function completionCandidates(
  index: WorkspaceIndex,
  context: CompletionContext,
  namespace: string | undefined,
  unit?: UnitInfo,
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
  if (context.field === "exclude") {
    for (const [id, candidate] of unit ? includedUnits(index, unit) : []) {
      add(id, candidate.kind, candidate.summary);
    }
    return [...candidates.values()];
  }
  if (context.field === "template-resource" && !qualified) {
    // Mirrors TemplateUnit.resource_id: an alias from template-imports wins
    for (const { alias, target } of unit?.templateImports ?? []) {
      const def = index.definitions(target).find((d) => satisfies("resource", d));
      candidates.set(alias, { label: alias, kind: "import", summary: def?.summary ?? target });
    }
  }
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
