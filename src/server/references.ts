/**
 * Extract unit identity and references from parsed records.
 *
 * Each extractor names the plainbox function it mirrors; keep them in sync
 * (test/parity.test.ts compares the results with plainbox itself).
 */

import { Field, ListItem, RawUnit, stringValue, trimmedLine, ValueLine } from "./model";
import { qualify } from "./namespace";
import {
  classifyPattern,
  ImportStmt,
  parseImport,
  parseIncludeLine,
  parseOverrideLine,
  parseWordList,
  resourceNames,
} from "./syntax";

/** What kind of unit a reference must point to. */
export type Constraint =
  | "job"
  | "resource"
  | "category"
  | "test plan"
  | "setup_job"
  | "bootstrap"
  | "include";

export interface Reference {
  field: string;
  /** Text as written. */
  text: string;
  /** Qualified id or, when `pattern` is set, an anchored regex. */
  target: string;
  pattern?: boolean;
  start: number;
  end: number;
  constraint: Constraint;
}

export interface GeneratedId {
  id: string;
  plugin?: string;
  summary?: string;
  start: number;
  end: number;
}

export interface Problem {
  message: string;
  start: number;
  end: number;
  severity: "error" | "warning";
}

export interface UnitInfo {
  /** Value of plainbox Unit.unit ("job", "template", "setup_job", ...). */
  kind: string;
  partialId?: string;
  /** Qualified id (with placeholders for templates). */
  id?: string;
  idStart: number;
  idEnd: number;
  plugin?: string;
  summary?: string;
  /** Qualified template id (templates only). */
  templateId?: string;
  generated: GeneratedId[];
  references: Reference[];
  problems: Problem[];
  start: number;
  end: number;
}

const SUSPEND_FLAGS: [string, string][] = [
  ["also-after-suspend", "after-suspend"],
  ["also-after-suspend-manual", "after-suspend-manual"],
];

const JOB_LIST_FIELDS: [string, Constraint][] = [
  ["depends", "job"],
  ["after", "job"],
  ["before", "job"],
  ["salvages", "job"],
];

const TEST_PLAN_LIST_FIELDS: [string, Constraint][] = [
  ["setup_include", "setup_job"],
  ["bootstrap_include", "bootstrap"],
  ["nested_part", "test plan"],
];

export const INCLUDE_FIELDS = ["include", "exclude", "mandatory_include"];

/**
 * Every plainbox unit field (Meta.fields), classified. test/parity.test.ts
 * fails when plainbox gains a field missing here, so new reference fields
 * cannot be silently ignored.
 */
export const FIELD_CLASSES: Record<string, "reference" | "identity" | "other"> = {
  ...Object.fromEntries(
    [
      "depends",
      "after",
      "before",
      "salvages",
      "requires",
      "imports",
      "category_id",
      "template-resource",
      "template-imports",
      "template-filter",
      "include",
      "exclude",
      "mandatory_include",
      "bootstrap_include",
      "setup_include",
      "nested_part",
      "category-overrides",
    ].map((f) => [f, "reference"]),
  ),
  ...Object.fromEntries(
    ["id", "unit", "plugin", "flags", "siblings", "template-id"].map((f) => [f, "identity"]),
  ),
  ...Object.fromEntries(
    [
      "Depends",
      "Recommends",
      "Suggests",
      "auto_retry",
      "certification_status",
      "command",
      "data",
      "description",
      "entry_point",
      "environ",
      "estimated_duration",
      "file_extension",
      "group",
      "hidden-reason",
      "icon",
      "mime_type",
      "name",
      "options",
      "os-id",
      "os-version-id",
      "prompt",
      "purpose",
      "requires_manifest",
      "resource-key",
      "shell",
      "steps",
      "summary",
      "template-description",
      "template-summary",
      "template-unit",
      "user",
      "value-type",
      "value-unit",
      "verification",
      "xfail",
      "xfail-overrides",
    ].map((f) => [f, "other"]),
  ),
};

function lineEnd(line: ValueLine): number {
  return line.offset + line.text.length;
}

/** Mirrors plainbox.impl.unit.get_array_field_qualify. */
function arrayField(field: Field | undefined): ValueLine[] {
  if (!field) {
    return [];
  }
  if (field.value.kind === "string") {
    return parseWordList(field.value.lines);
  }
  if (field.value.kind === "list") {
    return field.value.items.flatMap((item) =>
      item.kind === "string" ? [item.line] : [],
    );
  }
  return [];
}

/** One entry per line (strings) or per item (lists), blank lines skipped. */
function lineField(field: Field | undefined): ValueLine[] {
  if (!field) {
    return [];
  }
  const lines =
    field.value.kind === "string"
      ? field.value.lines
      : field.value.kind === "list"
        ? field.value.items.flatMap((item) => (item.kind === "string" ? [item.line] : []))
        : [];
  return lines.filter((line) => line.text.trim() !== "");
}

/** Mirrors JobDefinition.get_flag_set. */
function flagWords(field: Field | undefined): ValueLine[] {
  if (!field) {
    return [];
  }
  if (field.value.kind === "list") {
    return arrayField(field);
  }
  const words: ValueLine[] = [];
  for (const line of lineField(field)) {
    const re = /[^\s,]+/g;
    for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
      words.push({ text: m[0], offset: line.offset + m.index });
    }
  }
  return words;
}

/** Mirrors TemplateUnit.slugify_template_id. */
export function slugifyTemplateId(id: string): string {
  return id.replace(/[^-_.:/\\A-Za-z0-9]/g, "");
}

/** Mirrors TestPlanUnit.qualify_pattern. */
export function qualifyPattern(pattern: string, namespace: string): string {
  let inner = pattern;
  if (inner.startsWith("^")) {
    inner = inner.slice(1);
  }
  if (inner.endsWith("$")) {
    inner = inner.slice(0, -1);
  }
  return `^${qualify(inner, namespace)}$`;
}

class Extractor {
  readonly info: UnitInfo;
  private readonly fields: Map<string, Field>;

  constructor(
    unit: RawUnit,
    private readonly namespace: string,
    private readonly keepTemplated = false,
  ) {
    this.fields = unit.fields;
    const kind = stringValue(unit.fields.get("unit")) ?? "job";
    const idLine = trimmedLine(unit.fields.get("id"));
    const idField = unit.fields.get("id");
    this.info = {
      kind: kind === "setup job" ? "setup_job" : kind,
      partialId: idLine?.text,
      summary: stringValue(unit.fields.get("summary")),
      id: idLine ? qualify(idLine.text, namespace) : undefined,
      idStart: idLine?.offset ?? idField?.keyStart ?? unit.start,
      idEnd: idLine ? lineEnd(idLine) : (idField?.keyEnd ?? unit.start),
      generated: [],
      references: [],
      problems: [],
      start: unit.start,
      end: unit.end,
    };
    const flags = flagWords(unit.fields.get("flags")).map((w) => w.text);
    this.info.plugin =
      stringValue(unit.fields.get("plugin")) ??
      (flags.includes("simple") ? "shell" : undefined);
  }

  private ref(field: string, line: ValueLine, target: string, constraint: Constraint, pattern = false) {
    this.info.references.push({
      field,
      text: line.text,
      target,
      pattern: pattern || undefined,
      start: line.offset,
      end: lineEnd(line),
      constraint,
    });
  }

  private problem(message: string, start: number, end: number, severity: Problem["severity"] = "error") {
    this.info.problems.push({ message, start, end, severity });
  }

  private listField(name: string, constraint: Constraint) {
    for (const word of arrayField(this.fields.get(name))) {
      this.ref(name, word, qualify(word.text, this.namespace), constraint);
    }
  }

  /** Mirrors parse_imports_stmt; reports parse errors. */
  private imports(name: string): ImportStmt[] {
    const result: ImportStmt[] = [];
    for (const line of lineField(this.fields.get(name))) {
      const stmt = parseImport(line);
      if (typeof stmt === "string") {
        const lead = line.text.length - line.text.trimStart().length;
        this.problem(stmt, line.offset + lead, lineEnd(line));
        continue;
      }
      result.push(stmt);
      this.ref(
        name,
        { text: stmt.partialId, offset: stmt.idOffset },
        `${stmt.namespace}::${stmt.partialId}`,
        "job",
      );
    }
    return result;
  }

  /** Mirrors ResourceExpression.resource_id_list. */
  private resourceProgram(name: string, namespace: string, imports: ImportStmt[]) {
    for (const line of lineField(this.fields.get(name))) {
      for (const alias of resourceNames(line)) {
        const imported = imports.find((stmt) => stmt.alias === alias.text);
        const target = imported
          ? `${imported.namespace}::${imported.partialId}`
          : qualify(alias.text, namespace);
        this.ref(name, alias, target, "resource");
      }
    }
  }

  /** Mirrors TemplateUnit.resource_id. */
  private templateResource(imports: ImportStmt[]): string {
    const line = trimmedLine(this.fields.get("template-resource"));
    if (!line) {
      return this.namespace;
    }
    const sep = line.text.indexOf("::");
    const partialId = sep === -1 ? line.text : line.text.slice(sep + 2);
    const namespace = sep === -1 ? this.namespace : line.text.slice(0, sep);
    const imported = imports.find((stmt) => stmt.alias === partialId);
    const target = imported
      ? `${imported.namespace}::${imported.partialId}`
      : `${namespace}::${partialId}`;
    this.ref("template-resource", line, target, "resource");
    return namespace;
  }

  /** Mirrors TestPlanUnit._get_matchers (IncludeStmtList). */
  private includeField(name: string) {
    const field = this.fields.get(name);
    if (!field) {
      return;
    }
    const patterns: ValueLine[] = [];
    if (field.value.kind === "string") {
      for (const line of field.value.lines) {
        const parsed = parseIncludeLine(line);
        if (parsed?.kind === "ok") {
          patterns.push(parsed.pattern);
        } else if (parsed?.kind === "error") {
          const lead = line.text.length - line.text.trimStart().length;
          this.problem(`Unable to parse ${name}: ${parsed.message}`, line.offset + lead, lineEnd(line));
        }
      }
    } else if (field.value.kind === "list") {
      field.value.items.forEach((item: ListItem) => {
        if (item.kind === "string") {
          patterns.push(item.line);
        } else if (item.kind === "map" && item.entries.length === 1) {
          patterns.push(item.entries[0].key);
        } else if (item.kind === "map" && item.entries[0]) {
          const key = item.entries[0].key;
          this.problem(`Include is a non-single value map`, key.offset, lineEnd(key));
        }
      });
    }
    for (const pattern of patterns) {
      const kind = classifyPattern(pattern.text);
      if (kind === "error") {
        this.problem(`Invalid regular expression: ${pattern.text}`, pattern.offset, lineEnd(pattern));
      } else if (kind === "pattern") {
        this.ref(name, pattern, qualifyPattern(pattern.text, this.namespace), "include", true);
      } else {
        this.ref(name, pattern, qualify(pattern.text, this.namespace), "include");
      }
    }
  }

  /** Mirrors TestPlanUnit.parse_category_overrides. */
  private categoryOverrides() {
    const name = "category-overrides";
    for (const line of lineField(this.fields.get(name))) {
      const parsed = parseOverrideLine(line);
      if (typeof parsed === "string") {
        const lead = line.text.length - line.text.trimStart().length;
        this.problem(`Unable to parse ${name}: ${parsed}`, line.offset + lead, lineEnd(line));
      } else if (parsed) {
        this.ref(name, parsed.value, qualify(parsed.value.text, this.namespace), "category");
        if (classifyPattern(parsed.pattern.text) === "error") {
          this.problem(`Invalid regular expression: ${parsed.pattern.text}`, parsed.pattern.offset, lineEnd(parsed.pattern));
        } else {
          const target = `^${qualify(parsed.pattern.text, this.namespace)}$`;
          this.ref(name, parsed.pattern, target, "include", true);
        }
      }
    }
  }

  /** Mirrors SessionState._add_job_siblings_unit / _get_flags_siblings. */
  private generatedIds() {
    const partialId = this.info.partialId;
    if (!partialId) {
      return;
    }
    const flags = flagWords(this.fields.get("flags"));
    const suspendIds = (id: string, flagList: string[], fallback: ValueLine) => {
      for (const [flag, prefix] of SUSPEND_FLAGS) {
        if (flagList.includes(flag)) {
          const at = flags.find((f) => f.text === flag) ?? fallback;
          this.info.generated.push({
            id: qualify(`${prefix}-${id}`, this.namespace),
            plugin: this.info.plugin,
            summary: this.info.summary,
            start: at.offset,
            end: lineEnd(at),
          });
        }
      }
    };
    const idLine = { text: partialId, offset: this.info.idStart };
    suspendIds(partialId, flags.map((f) => f.text), idLine);
    for (const sibling of this.siblings()) {
      this.info.generated.push({
        id: qualify(sibling.id.text, this.namespace),
        plugin: sibling.plugin ?? this.info.plugin,
        summary: sibling.summary ?? this.info.summary,
        start: sibling.id.offset,
        end: lineEnd(sibling.id),
      });
      const siblingFlags = sibling.flags ?? flags.map((f) => f.text);
      suspendIds(sibling.id.text, siblingFlags, sibling.id);
    }
  }

  /** Siblings are YAML objects or, in PXU, a JSON string. */
  private siblings(): { id: ValueLine; plugin?: string; summary?: string; flags?: string[] }[] {
    const field = this.fields.get("siblings");
    if (!field) {
      return [];
    }
    const str = (value: unknown) => (typeof value === "string" ? value : undefined);
    const toFlags = (value: unknown): string[] | undefined =>
      Array.isArray(value)
        ? value.map(String)
        : typeof value === "string"
          ? value.split(/[\s,]+/)
          : undefined;
    if (field.value.kind === "list") {
      return field.value.items.flatMap((item) => {
        if (item.kind !== "map") {
          return [];
        }
        const get = (key: string) => item.entries.find((e) => e.key.text === key);
        const id = get("id")?.valueLine;
        if (!id) {
          return [];
        }
        return [{
          id,
          plugin: str(get("plugin")?.value),
          summary: str(get("_summary")?.value) ?? str(get("summary")?.value),
          flags: toFlags(get("flags")?.value),
        }];
      });
    }
    if (field.value.kind !== "string") {
      return [];
    }
    let parsed: unknown;
    try {
      let json = stringValue(field) ?? "";
      if (this.info.kind === "template") {
        // Template fields are str.format templates: {{ and }} are escapes
        json = json.replace(/\{\{/g, "{").replace(/\}\}/g, "}");
      }
      parsed = JSON.parse(json);
    } catch {
      this.problem("siblings is not valid JSON", field.keyStart, field.keyEnd);
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    const lines = field.value.lines;
    return parsed.flatMap((sibling: Record<string, unknown>) => {
      if (typeof sibling?.id !== "string") {
        return [];
      }
      const id = sibling.id;
      // Locate the "id": "<value>" occurrence for go to definition
      let at: ValueLine = { text: id, offset: field.keyStart };
      for (const line of lines) {
        const m = new RegExp(`"id"\\s*:\\s*"(${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})"`).exec(line.text);
        if (m) {
          at = { text: id, offset: line.offset + m.index + m[0].length - id.length - 1 };
          break;
        }
      }
      return [{
        id: at,
        plugin: str(sibling.plugin),
        summary: str(sibling._summary) ?? str(sibling.summary),
        flags: toFlags(sibling.flags),
      }];
    });
  }

  /**
   * Template fields are rendered (str.format or Jinja2) before plainbox
   * validates them; references on lines with placeholders are unknowable.
   */
  private dropTemplatedReferences() {
    const lines = (field: Field | undefined): ValueLine[] =>
      !field
        ? []
        : field.value.kind === "string"
          ? field.value.lines
          : field.value.kind === "list"
            ? field.value.items.flatMap((item) => (item.kind === "string" ? [item.line] : []))
            : [];
    this.info.references = this.info.references.filter((ref) => {
      const line = lines(this.fields.get(ref.field)).find(
        (l) => l.offset <= ref.start && ref.end <= lineEnd(l),
      );
      return !line || !/[{}]/.test(line.text);
    });
  }

  extract(): UnitInfo {
    const kind = this.info.kind;
    if (kind === "template") {
      const raw = stringValue(this.fields.get("template-id")) || slugifyTemplateId(this.info.partialId ?? "");
      if (raw) {
        this.info.templateId = `${this.namespace}::${raw}`;
      }
      const templateImports = this.imports("template-imports");
      const resourceNamespace = this.templateResource(templateImports);
      this.resourceProgram("template-filter", resourceNamespace, templateImports);
    }
    if (kind === "job" || kind === "template" || kind === "setup_job") {
      for (const [name, constraint] of JOB_LIST_FIELDS) {
        this.listField(name, constraint);
      }
      const imports = this.imports("imports");
      this.resourceProgram("requires", this.namespace, imports);
    }
    if (kind === "test plan") {
      for (const [name, constraint] of TEST_PLAN_LIST_FIELDS) {
        this.listField(name, constraint);
      }
      for (const name of INCLUDE_FIELDS) {
        this.includeField(name);
      }
      this.categoryOverrides();
    }
    const category = trimmedLine(this.fields.get("category_id"));
    if (category) {
      this.ref("category_id", category, qualify(category.text, this.namespace), "category");
    }
    if (kind === "job" || kind === "template") {
      this.generatedIds();
    }
    if (kind === "template" && !this.keepTemplated) {
      this.dropTemplatedReferences();
    }
    return this.info;
  }
}

/**
 * keepTemplated keeps template references containing placeholders (only
 * useful to compare with plainbox, which parses them verbatim).
 */
export function extractUnit(unit: RawUnit, namespace: string, keepTemplated = false): UnitInfo {
  return new Extractor(unit, namespace, keepTemplated).extract();
}
