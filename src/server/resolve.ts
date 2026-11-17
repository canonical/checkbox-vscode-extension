/**
 * Resolve references against the workspace index.
 *
 * Mirrors plainbox.impl.unit.validators.UnitReferenceValidator (unknown ids,
 * ReferenceConstraint checks) and, for test plan include patterns,
 * TestPlanUnit._get_matchers. Template instances only exist at runtime, so
 * ids matching a template id are accepted (heuristic, avoids false
 * positives).
 */

import { Definition, TemplateDef, WorkspaceIndex } from "./index";
import { namespaceOf } from "./namespace";
import { Constraint, Reference } from "./references";
import { toJsRegex } from "./syntax";

export interface Resolution {
  definitions: Definition[];
  templates: TemplateDef[];
  problem?: { message: string; severity: "error" | "warning" };
}

const JOB_KINDS = ["job", "setup_job"];
const AUTOMATED = ["shell", "resource", "attachment"];

/** Returns the constraint failure message, if any. */
function violation(constraint: Constraint, def: Definition): string | undefined {
  const kind = def.unit.kind;
  switch (constraint) {
    case "job":
      return kind === "job" ? undefined : "the referenced unit is not a job";
    case "include":
      return JOB_KINDS.includes(kind) ? undefined : "the referenced unit is not a job";
    case "resource":
      if (kind !== "job") {
        return "the referenced unit is not a job";
      }
      return def.plugin === "resource" ? undefined : "the referenced job is not a resource job";
    case "category":
      return kind === "category" ? undefined : "the referenced unit is not a category";
    case "test plan":
      return kind === "test plan" ? undefined : "the referenced unit is not a test plan";
    case "setup_job":
      if (kind !== "setup_job") {
        return "the referenced unit is not a setup job";
      }
      return AUTOMATED.includes(def.plugin ?? "") ? undefined : "only automated jobs are allowed in setup_include";
    case "bootstrap":
      if (kind !== "job") {
        return "the referenced unit is not a job";
      }
      return AUTOMATED.includes(def.plugin ?? "")
        ? undefined
        : "only automated jobs are allowed in bootstrapping_include";
  }
}

/** Whether a definition can be referenced from a field with the constraint. */
export function satisfies(constraint: Constraint, def: Definition): boolean {
  return violation(constraint, def) === undefined;
}

/** Whether template instances can satisfy the constraint. */
function templateAllowed(constraint: Constraint, template: TemplateDef): boolean {
  const plugin = template.unit.plugin;
  switch (constraint) {
    case "job":
    case "include":
      return true;
    case "resource":
      return plugin === "resource";
    case "bootstrap":
      return AUTOMATED.includes(plugin ?? "");
    default:
      return false;
  }
}

/** Namespace targeted by a reference (patterns: literal text before ::). */
function targetNamespace(ref: Reference): string | undefined {
  if (!ref.pattern) {
    return namespaceOf(ref.target);
  }
  const inner = ref.target.replace(/^\^/, "");
  const sep = inner.indexOf("::");
  if (sep === -1) {
    return undefined;
  }
  const namespace = inner.slice(0, sep).replace(/\\(.)/g, "$1");
  // Only check namespaces written literally (dots are allowed)
  return /^[\w.-]+$/.test(namespace) ? namespace : undefined;
}

/**
 * A string the pattern would plausibly match, used to test patterns against
 * template id regexes, e.g. "^ns::foo/.*_bar$" -> "ns::foo/x_bar".
 */
export function samplePattern(pattern: string): string {
  return pattern
    .replace(/^\^|\$$/g, "")
    .replace(/\\d[+*]?/g, "1")
    .replace(/\[[^\]]*\][+*?]?/g, "x")
    .replace(/\.[+*]\??/g, "x")
    .replace(/\\(.)/g, "$1");
}

/**
 * Leading single-character tokens of a regex, up to the first construct
 * that is not a plain or wildcard character; null stands for ".".
 */
export function leadingChars(pattern: string): (string | null)[] {
  const out: (string | null)[] = [];
  for (let i = pattern.startsWith("^") ? 1 : 0; i < pattern.length; i++) {
    let token: string | null;
    const c = pattern[i];
    if (c === "\\" && /[^A-Za-z0-9]/.test(pattern[i + 1] ?? "")) {
      token = pattern[++i];
    } else if (c === ".") {
      token = null;
    } else if ("^$*+?|()[]{}\\".includes(c)) {
      break;
    } else {
      token = c;
    }
    if ("*+?{".includes(pattern[i + 1] ?? "")) {
      break;
    }
    out.push(token);
  }
  return out;
}

const patternShapes = new Map<string, { sample: string; chars: (string | null)[] }>();
const templatePrefixes = new WeakMap<RegExp, string>();

/** Whether a pattern may match ids instantiated from a template. */
function patternMatchesTemplate(regex: RegExp, pattern: string, template: TemplateDef): boolean {
  const id = template.unit.id;
  if (template.templateIds.some((t) => regex.test(t)) || (id !== undefined && regex.test(id))) {
    return true;
  }
  if (!template.idRegex) {
    return false;
  }
  // Memoized: these only depend on the pattern or the template
  let shape = patternShapes.get(pattern);
  if (!shape) {
    shape = { sample: samplePattern(pattern), chars: leadingChars(pattern) };
    patternShapes.set(pattern, shape);
  }
  if (template.idRegex.test(shape.sample)) {
    return true;
  }
  let templatePrefix = templatePrefixes.get(template.idRegex);
  if (templatePrefix === undefined) {
    const source = template.idRegex.source.replace(/^\^/, "");
    templatePrefix = source.slice(0, source.indexOf(".+")).replace(/\\(.)/g, "$1");
    templatePrefixes.set(template.idRegex, templatePrefix);
  }
  const patternChars = shape.chars;
  const length = Math.min(patternChars.length, templatePrefix.length);
  for (let i = 0; i < length; i++) {
    if (patternChars[i] !== null && patternChars[i] !== templatePrefix[i]) {
      return false;
    }
  }
  return true;
}

export function resolve(index: WorkspaceIndex, ref: Reference): Resolution {
  const namespace = targetNamespace(ref);
  if (namespace && !index.hasNamespace(namespace)) {
    return {
      definitions: [],
      templates: [],
      problem: { message: `unknown namespace ${namespace}`, severity: "error" },
    };
  }
  return ref.pattern ? resolvePattern(index, ref) : resolveId(index, ref);
}

function resolveId(index: WorkspaceIndex, ref: Reference): Resolution {
  const definitions = index.definitions(ref.target);
  const isInclude = ref.constraint === "include";
  const templates = index
    .templates()
    .filter(
      (t) =>
        templateAllowed(ref.constraint, t) &&
        ((isInclude && t.templateIds.includes(ref.target)) || t.idRegex?.test(ref.target)),
    );
  if (definitions.length > 0) {
    const failures = definitions.map((def) => violation(ref.constraint, def));
    const message = failures.find((f) => f !== undefined);
    if (message && templates.length === 0 && failures.every((f) => f !== undefined)) {
      return { definitions, templates, problem: { message, severity: "error" } };
    }
    return { definitions, templates };
  }
  if (templates.length > 0) {
    return { definitions, templates };
  }
  return {
    definitions,
    templates,
    problem: { message: `unit ${ref.target} is not available`, severity: "error" },
  };
}

function resolvePattern(index: WorkspaceIndex, ref: Reference): Resolution {
  let regex: RegExp;
  try {
    regex = new RegExp(toJsRegex(ref.target));
  } catch {
    return { definitions: [], templates: [] };
  }
  const definitions: Definition[] = [];
  for (const id of index.allIds()) {
    if (regex.test(id)) {
      definitions.push(...index.definitions(id).filter((d) => JOB_KINDS.includes(d.unit.kind)));
    }
  }
  const templates = index.templates().filter((t) => patternMatchesTemplate(regex, ref.target, t));
  if (definitions.length === 0 && templates.length === 0) {
    return {
      definitions,
      templates,
      problem: { message: `pattern ${ref.text} does not match any unit`, severity: "warning" },
    };
  }
  return { definitions, templates };
}

/** Units that references are searched for (see refersTo). */
export interface Targets {
  definitions: Definition[];
  templates: TemplateDef[];
}

const patternCache = new Map<string, RegExp | null>();

function compilePattern(pattern: string): RegExp | null {
  let regex = patternCache.get(pattern);
  if (regex === undefined) {
    try {
      regex = new RegExp(toJsRegex(pattern));
    } catch {
      regex = null;
    }
    patternCache.set(pattern, regex);
  }
  return regex;
}

/**
 * Whether resolve(index, ref) would return one of the targets. Equivalent
 * to resolving the reference, but only tests the targets, which is much
 * faster when checking every reference in the workspace.
 */
export function refersTo(ref: Reference, targets: Targets): boolean {
  if (!ref.pattern) {
    return (
      targets.definitions.some((d) => d.id === ref.target) ||
      targets.templates.some(
        (t) =>
          templateAllowed(ref.constraint, t) &&
          ((ref.constraint === "include" && t.templateIds.includes(ref.target)) || t.idRegex?.test(ref.target)),
      )
    );
  }
  const regex = compilePattern(ref.target);
  if (!regex) {
    return false;
  }
  return (
    targets.definitions.some((d) => JOB_KINDS.includes(d.unit.kind) && regex.test(d.id)) ||
    targets.templates.some((t) => patternMatchesTemplate(regex, ref.target, t))
  );
}
