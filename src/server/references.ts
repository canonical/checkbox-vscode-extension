/**
 * Extract unit identity and references from parsed records.
 *
 * Each extractor names the plainbox function it mirrors; keep them in sync
 * (test/parity.test.ts compares the results with plainbox itself).
 */

import { Field, ListItem, RawUnit, stringValue, trimmedLine, ValueLine } from "./model";
import { PLAINBOX_NAMESPACE, qualify } from "./namespace";
import { undeclaredEnviron } from "./environ";
import { shellOutput, ShellOutput } from "./shellOutput";
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

/** An attribute of the manifest resource, e.g. has_bt_adapter. */
export interface ManifestRef {
  key: string;
  start: number;
  end: number;
}

/** A namespace written in an imports statement. */
export interface NamespaceRef {
  namespace: string;
  start: number;
  end: number;
}

/**
 * A resource attribute used by a unit: `alias.key` in requires or
 * template-filter, or a placeholder in a template (a key of the
 * template-resource records).
 */
export interface ResourceAttr {
  field: string;
  /** Qualified id of the resource job. */
  target: string;
  key: string;
  start: number;
  end: number;
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
  /** Test plans and categories have a name instead of a summary. */
  name?: string;
  /** Qualified template id (templates only). */
  templateId?: string;
  /** Aliases from template-imports and the qualified ids they import. */
  templateImports?: { alias: string; target: string }[];
  generated: GeneratedId[];
  references: Reference[];
  namespaceRefs: NamespaceRef[];
  manifestRefs: ManifestRef[];
  /** Attribute name in the manifest resource (manifest entries only). */
  resourceKey?: string;
  resourceAttrs: ResourceAttr[];
  /** Value of template-engine (templates only). */
  templateEngine?: string;
  /** What the command prints (resource jobs and templates only). */
  output?: ShellOutput;
  problems: Problem[];
  start: number;
  end: number;
}

/** The resource job that exposes manifest entries by their resource key. */
export const MANIFEST_RESOURCE = `${PLAINBOX_NAMESPACE}::manifest`;

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
    ["id", "unit", "plugin", "flags", "siblings", "template-id", "parameters"].map((f) => [f, "identity"]),
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

/** Every string of a field value, including YAML mapping values. */
function valueLines(field: Field): ValueLine[] {
  const value = field.value;
  if (value.kind === "string") {
    return value.lines;
  }
  if (value.kind === "list") {
    return value.items.flatMap((item) =>
      item.kind === "string"
        ? [item.line]
        : item.kind === "map"
          ? item.entries.flatMap((e) => (e.valueLine ? [e.valueLine] : []))
          : [],
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

/** Template units whose id has placeholders. */
export function isTemplate(kind: string): boolean {
  return kind === "template" || kind === "parametric template";
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
      // YAML keeps the "_" translatable prefix; mirrors Unit.get_record_value
      summary: stringValue(unit.fields.get("_summary") ?? unit.fields.get("summary")),
      name: stringValue(unit.fields.get("_name") ?? unit.fields.get("name")),
      id: idLine ? qualify(idLine.text, namespace) : undefined,
      idStart: idLine?.offset ?? idField?.keyStart ?? unit.start,
      idEnd: idLine ? lineEnd(idLine) : (idField?.keyEnd ?? unit.start),
      generated: [],
      references: [],
      namespaceRefs: [],
      manifestRefs: [],
      resourceAttrs: [],
      problems: [],
      start: unit.start,
      end: unit.end,
    };
    if (this.info.kind === "manifest entry") {
      // Mirrors ManifestEntryUnit.resource_key
      this.info.resourceKey = stringValue(unit.fields.get("resource-key")) ?? this.info.partialId;
    }
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
      this.info.namespaceRefs.push({
        namespace: stmt.namespace,
        start: stmt.namespaceOffset,
        end: stmt.namespaceOffset + stmt.namespace.length,
      });
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
        if (alias.attr?.text) {
          const span = { start: alias.attr.offset, end: lineEnd(alias.attr) };
          this.info.resourceAttrs.push({ field: name, target, key: alias.attr.text, ...span });
          if (target === MANIFEST_RESOURCE) {
            this.info.manifestRefs.push({ key: alias.attr.text, ...span });
          }
        }
      }
    }
  }

  /** Mirrors TemplateUnit.resource_id; returns its namespace and id. */
  private templateResource(imports: ImportStmt[]): { namespace: string; target?: string } {
    const line = trimmedLine(this.fields.get("template-resource"));
    if (!line) {
      return { namespace: this.namespace };
    }
    const sep = line.text.indexOf("::");
    const partialId = sep === -1 ? line.text : line.text.slice(sep + 2);
    const namespace = sep === -1 ? this.namespace : line.text.slice(0, sep);
    const imported = imports.find((stmt) => stmt.alias === partialId);
    const target = imported
      ? `${imported.namespace}::${imported.partialId}`
      : `${namespace}::${partialId}`;
    this.ref("template-resource", line, target, "resource");
    return { namespace, target };
  }

  /**
   * Placeholders of template fields (template-* fields are not rendered):
   * str.format "{name}" or Jinja2 "{{ name }}" (TemplateUnit.template_engine).
   */
  private placeholders(target: string) {
    const jinja = this.info.templateEngine === "jinja2";
    const regex = jinja ? /\{\{-?\s*([A-Za-z_]\w*)(?!\s*\()/g : /\{\{|\}\}|\{([A-Za-z_][\w-]*)(?=[}!:.[])/g;
    for (const [key, field] of this.fields) {
      if (key.startsWith("template-") || key === "unit") {
        continue;
      }
      for (const line of valueLines(field)) {
        for (const m of line.text.matchAll(regex)) {
          // __index__, __checkbox_env__, ... are not resource keys
          if (m[1] && !m[1].startsWith("__")) {
            const start = line.offset + m.index + m[0].indexOf(m[1], 1);
            this.info.resourceAttrs.push({ field: key, target, key: m[1], start, end: start + m[1].length });
          }
        }
      }
    }
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
      if (isTemplate(this.info.kind)) {
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
    if (isTemplate(kind)) {
      const raw = stringValue(this.fields.get("template-id")) || slugifyTemplateId(this.info.partialId ?? "");
      if (raw) {
        this.info.templateId = `${this.namespace}::${raw}`;
      }
      this.info.templateEngine = stringValue(this.fields.get("template-engine"));
      const templateImports = this.imports("template-imports");
      this.info.templateImports = templateImports.map((stmt) => ({
        alias: stmt.alias,
        target: `${stmt.namespace}::${stmt.partialId}`,
      }));
      const resource = this.templateResource(templateImports);
      this.resourceProgram("template-filter", resource.namespace, templateImports);
      if (resource.target && kind === "template") {
        this.placeholders(resource.target);
      }
    }
    if (kind === "job" || isTemplate(kind) || kind === "setup_job") {
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
    const command = lineField(this.fields.get("command"));
    if (this.info.plugin === "resource" && command.length > 0) {
      this.info.output = shellOutput(command);
    }
    if (isTemplate(kind) && !this.keepTemplated) {
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

/**
 * The unit and, for a parametric template, the jobs it instantiates (like
 * ProviderContentPlugIn._prepare_unit).
 */
export function extractUnits(unit: RawUnit, namespace: string, keepTemplated = false): UnitInfo[] {
  const info = extractUnit(unit, namespace, keepTemplated);
  if (info.kind === "job" || isTemplate(info.kind) || info.kind === "setup_job") {
    info.problems.push(...undeclaredEnviron(unit));
  }
  return info.kind === "parametric template" ? [info, ...parametricInstances(unit, info, namespace)] : [info];
}

/** Python str() of a parameter value. */
function pyStr(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (value === null || value === undefined) {
    return "None";
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

class MissingParam extends Error {}

/** Mirrors string.Formatter().vformat(text, (), parameters) for {name}. */
function pyFormat(text: string, parameters: Record<string, unknown>): string {
  return text.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (match, field: string | undefined) => {
    if (field === undefined) {
      return match[0];
    }
    const name = field.split(/[.[!:]/)[0];
    if (!(name in parameters)) {
      throw new MissingParam(name);
    }
    return pyStr(parameters[name]);
  });
}

/** Mirrors ParametricTemplateUnit.parameter_records. */
function parameterRecords(field: Field | undefined): Record<string, unknown>[] | undefined {
  let records: unknown;
  if (field?.value.kind === "list") {
    records = field.value.items.map((item) =>
      item.kind === "map" ? Object.fromEntries(item.entries.map((e) => [e.key.text, e.value])) : undefined,
    );
  } else if (field?.value.kind === "string") {
    try {
      records = JSON.parse(stringValue(field) ?? "");
    } catch {
      return undefined;
    }
  }
  const isRecord = (r: unknown) => typeof r === "object" && r !== null && !Array.isArray(r);
  return Array.isArray(records) && records.every(isRecord) ? (records as Record<string, unknown>[]) : undefined;
}

/**
 * Jobs of a parametric template (ParametricTemplateUnit.instantiate_jobs).
 * Each field is rendered with the record; spans on rendered lines cover the
 * whole template line, since rendering moves text around.
 */
function parametricInstances(unit: RawUnit, template: UnitInfo, namespace: string): UnitInfo[] {
  const field = unit.fields.get("parameters");
  const records = parameterRecords(field);
  if (!records) {
    const at = field ?? { keyStart: template.idStart, keyEnd: template.idEnd };
    template.problems.push({
      message: "parameters must be a list of mappings",
      start: at.keyStart,
      end: at.keyEnd,
      severity: "error",
    });
    return [];
  }
  const instances: UnitInfo[] = [];
  records.forEach((record, index) => {
    // Rendered lines: offset -> [rendered length, original length]
    const changed = new Map<number, [number, number]>();
    const render = (line: ValueLine): ValueLine => {
      const text = pyFormat(line.text, record);
      if (text !== line.text) {
        changed.set(line.offset, [text.length, line.text.length]);
      }
      return { text, offset: line.offset };
    };
    const renderValue = (value: unknown): unknown =>
      typeof value === "string"
        ? pyFormat(value, record)
        : Array.isArray(value)
          ? value.map(renderValue)
          : value && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderValue(v)]))
            : value;
    const renderField = (f: Field): Field => {
      const value = f.value;
      if (value.kind === "string") {
        return { ...f, value: { kind: "string", lines: value.lines.map(render) } };
      }
      if (value.kind === "list") {
        const items = value.items.map((item): ListItem =>
          item.kind === "string"
            ? { kind: "string", line: render(item.line) }
            : item.kind === "map"
              ? {
                  kind: "map",
                  entries: item.entries.map((e) => ({
                    key: e.key,
                    value: renderValue(e.value),
                    valueLine: e.valueLine && render(e.valueLine),
                  })),
                }
              : item,
        );
        return { ...f, value: { kind: "list", items } };
      }
      return f;
    };
    const fields = new Map<string, Field>();
    try {
      for (const [key, f] of unit.fields) {
        // The instance is a plain job: no parameters, no template- fields
        if (key !== "parameters" && key !== "unit" && (!key.startsWith("template-") || key === "template-id")) {
          fields.set(key, renderField(f));
        }
      }
    } catch (error) {
      if (!(error instanceof MissingParam)) {
        throw error;
      }
      template.problems.push({
        message: `parameter ${error.message} is missing in parameters record ${index + 1}`,
        start: field!.keyStart,
        end: field!.keyEnd,
        severity: "error",
      });
      return;
    }
    const info = extractUnit({ fields, start: unit.start, end: unit.end }, namespace);
    const remap = (span: { start: number; end: number }) => {
      for (const [offset, [rendered, original]] of changed) {
        if (offset <= span.start && span.start <= offset + rendered) {
          span.start = offset;
          span.end = offset + original;
          return;
        }
      }
    };
    const id = { start: info.idStart, end: info.idEnd };
    remap(id);
    info.idStart = id.start;
    info.idEnd = id.end;
    [
      ...info.references,
      ...info.generated,
      ...info.namespaceRefs,
      ...info.manifestRefs,
      ...info.resourceAttrs,
      ...info.problems,
      ...(info.output?.keys ?? []),
      ...(info.output?.commands ?? []),
    ].forEach(remap);
    instances.push(info);
  });
  return instances;
}
