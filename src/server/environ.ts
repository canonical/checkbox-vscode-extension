/**
 * Lint: environment variables expanded in `command` must be declared in
 * `environ` (JobDefinition.get_environ_settings). plainbox does not check
 * this and passes the whole config [environment] section to every job
 * (get_execution_environment), so `environ` only documents what a job
 * expects; hence a warning.
 *
 * The shell scan is deliberately lenient: anything it cannot follow is not
 * reported, to avoid false positives.
 */

import { Field, RawUnit, ValueLine } from "./model";
import { parsePxu } from "./parsers/pxu";
import { parseYaml } from "./parsers/yaml";
import type { Problem } from "./references";

/** Variables set by the shell, sudo, or plainbox (get_execution_environment). */
const KNOWN = new Set([
  // POSIX / login
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "PWD", "OLDPWD", "TERM", "LANG", "LANGUAGE", "TMPDIR", "IFS",
  // bash
  "RANDOM", "LINENO", "SECONDS", "UID", "EUID", "HOSTNAME", "HOSTTYPE", "OSTYPE", "MACHTYPE", "PPID", "REPLY",
  "OPTARG", "OPTIND", "OPTERR", "PIPESTATUS", "FUNCNAME", "GROUPS", "EPOCHSECONDS", "EPOCHREALTIME", "SRANDOM",
  // plainbox
  "PLAINBOX_SESSION_SHARE", "PLAINBOX_PROVIDER_DATA", "PLAINBOX_PROVIDER_UNITS", "PLAINBOX_PROVIDER_GETTEXT_DOMAIN",
  "PLAINBOX_PROVIDER_LOCALE_DIR", "TEXTDOMAIN", "TEXTDOMAINDIR", "CHECKBOX_SHARE", "CHECKBOX_RUNTIME",
  "CHECKBOX_RUNNING_STRICT_SNAP", "CHECKBOX_OS_IS_UBUNTUCORE", "NORMAL_USER", "SYSTEMD_IGNORE_CHROOT",
  "PYTHONUNBUFFERED", "PYTHONPATH", "LD_LIBRARY_PATH",
]);
const KNOWN_PREFIXES = ["BASH", "LC_", "SNAP", "SUDO_"];

/** Builtins whose word arguments are variable names. */
const ASSIGNING = /\b(?:read|export|local|declare|typeset|readonly|mapfile|readarray|getopts|unset|let)\b([^;&|)\n]*)/g;

export interface VariableUse {
  name: string;
  /** Offsets of the name in the document. */
  start: number;
  end: number;
}

const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;

/** The `$NAME` / `${NAME...}` expansions and the assigned names of a script. */
export function scanShell(lines: ValueLine[]): { uses: VariableUse[]; assigned: Set<string> } {
  const src = lines.map((line) => line.text).join("\n");
  const offsets: number[] = [];
  for (const line of lines) {
    for (let i = 0; i <= line.text.length; i++) {
      offsets.push(line.offset + i);
    }
  }
  const uses: VariableUse[] = [];
  const name = (at: number) => {
    NAME.lastIndex = at;
    return NAME.exec(src)?.[0];
  };
  const use = (at: number) => {
    const found = name(at);
    if (found) {
      uses.push({ name: found, start: offsets[at], end: offsets[at + found.length - 1] + 1 });
    }
    return found;
  };
  /** Handles the expansion at src[i] === "$"; returns the next index. */
  const expansion = (i: number): number => {
    let j = i + 1;
    if (src[j] === "{") {
      // ${{NAME}} renders as ${NAME} in Python-format templates
      j += src[j + 1] === "{" ? 2 : 1;
      if (src[j] === "#" || src[j] === "!") {
        j++;
      }
    }
    return j + (use(j)?.length ?? 0);
  };

  // Contexts: "dq" inside double quotes, "cmd" inside $( ... ) or ( ... )
  const stack: ("dq" | "cmd")[] = [];
  const heredocs: { delim: string; quoted: boolean }[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "$") {
      if (src[i + 1] === "(") {
        stack.push("cmd");
        i += 2;
        continue;
      }
      i = expansion(i);
      continue;
    }
    if (c === '"') {
      if (top === "dq") {
        stack.pop();
      } else {
        stack.push("dq");
      }
      i++;
      continue;
    }
    if (top === "dq") {
      i++;
      continue;
    }
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      i = close === -1 ? src.length : close + 1;
      continue;
    }
    if (c === "(") {
      stack.push("cmd");
      i++;
      continue;
    }
    if (c === ")" && top === "cmd") {
      stack.pop();
      i++;
      continue;
    }
    if (c === "#" && (i === 0 || /[\s;&|(]/.test(src[i - 1]))) {
      const eol = src.indexOf("\n", i);
      i = eol === -1 ? src.length : eol;
      continue;
    }
    if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      const m = /<<-?\s*(\\)?(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+))/y;
      m.lastIndex = i;
      const found = m.exec(src);
      if (found) {
        const delim = found[2] ?? found[3] ?? found[4];
        heredocs.push({ delim, quoted: found[4] === undefined || found[1] !== undefined });
        i += found[0].length;
        continue;
      }
    }
    if (c === "\n" && heredocs.length) {
      i++;
      for (const doc of heredocs.splice(0)) {
        while (i < src.length) {
          const eol = src.indexOf("\n", i);
          const end = eol === -1 ? src.length : eol;
          const line = src.slice(i, end);
          if (line.trim() === doc.delim) {
            i = end;
            break;
          }
          if (!doc.quoted) {
            // Unquoted heredocs expand $ even inside quotes
            for (let k = i; k < end; k++) {
              if (src[k] === "\\") {
                k++;
              } else if (src[k] === "$" && src[k + 1] !== "(") {
                k = expansion(k) - 1;
              }
            }
          }
          i = end + 1;
        }
      }
      continue;
    }
    i++;
  }
  return { uses, assigned: assignedNames(src) };
}

function assignedNames(src: string): Set<string> {
  const assigned = new Set<string>();
  for (const m of src.matchAll(/(?:^|[\s;&|({!`])([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/g)) {
    assigned.add(m[1]);
  }
  for (const m of src.matchAll(/\b(?:for|select)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    assigned.add(m[1]);
  }
  for (const m of src.matchAll(/\bprintf\s+-v\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    assigned.add(m[1]);
  }
  // Every word after an assigning builtin, up to the end of the command
  for (const m of src.matchAll(ASSIGNING)) {
    for (const word of m[1].matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)/g)) {
      assigned.add(word[1]);
    }
  }
  return assigned;
}

function declared(field: Field | undefined): Set<string> {
  const names = new Set<string>();
  if (field?.value.kind === "string") {
    for (const line of field.value.lines) {
      line.text.split(/[\s,]+/).forEach((name) => name && names.add(name));
    }
  } else if (field?.value.kind === "list") {
    for (const item of field.value.items) {
      if (item.kind === "string") {
        names.add(item.line.text.trim());
      }
    }
  }
  return names;
}

function isKnown(name: string): boolean {
  return KNOWN.has(name) || KNOWN_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Uses in `command` of variables missing from `environ`. */
export function undeclaredUses(unit: RawUnit): VariableUse[] {
  const command = unit.fields.get("command");
  if (command?.value.kind !== "string") {
    return [];
  }
  const { uses, assigned } = scanShell(command.value.lines);
  const environ = declared(unit.fields.get("environ"));
  return uses.filter((u) => !assigned.has(u.name) && !environ.has(u.name) && !isKnown(u.name));
}

export function undeclaredMessage(name: string): string {
  return `Environment variable ${name} is not declared in environ`;
}

/** Problems for variables used in `command` but missing from `environ`. */
export function undeclaredEnviron(unit: RawUnit): Problem[] {
  return undeclaredUses(unit).map((u) => ({
    message: undeclaredMessage(u.name),
    start: u.start,
    end: u.end,
    severity: "warning" as const,
  }));
}

export interface TextEdit {
  start: number;
  end: number;
  newText: string;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineEndAt(text: string, offset: number): number {
  const eol = text.indexOf("\n", offset);
  return eol === -1 ? text.length : eol;
}

/**
 * Edit that adds names to the unit's `environ`, keeping its style: appended
 * to a PXU/string value (comma separated if it already uses commas), to a
 * YAML flow or block list, or as a new field before `command`.
 */
export function declareEnvironEdit(
  text: string,
  unit: RawUnit,
  names: string[],
  format: "pxu" | "yaml",
): TextEdit | undefined {
  const environ = unit.fields.get("environ");
  const command = unit.fields.get("command");
  if (!environ) {
    if (!command) {
      return undefined;
    }
    const start = lineStart(text, command.keyStart);
    const indent = text.slice(start, command.keyStart);
    const newText =
      format === "pxu"
        ? `${indent}environ: ${names.join(" ")}\n`
        : `${indent}environ:\n${names.map((name) => `${indent}  - ${name}\n`).join("")}`;
    return { start, end: start, newText };
  }
  const colon = text.indexOf(":", environ.keyEnd);
  if (environ.value.kind === "string") {
    const last = [...environ.value.lines].reverse().find((line) => line.text.trim());
    if (!last) {
      return { start: colon + 1, end: colon + 1, newText: ` ${names.join(" ")}` };
    }
    const quote = text[last.offset - 1];
    if (format === "yaml" && (quote === "'" || quote === '"')) {
      return undefined;
    }
    const separator = environ.value.lines.some((line) => line.text.includes(",")) ? ", " : " ";
    const at = last.offset + last.text.trimEnd().length;
    return { start: at, end: at, newText: `${separator}${names.join(separator)}` };
  }
  if (environ.value.kind !== "list") {
    return undefined;
  }
  const items = environ.value.items.flatMap((item) => (item.kind === "string" ? [item.line] : []));
  if (items.length !== environ.value.items.length) {
    return undefined;
  }
  const valueStart = colon + 1 + (text.slice(colon + 1).length - text.slice(colon + 1).trimStart().length);
  if (text[valueStart] === "[") {
    const last = items[items.length - 1];
    const close = text.indexOf("]", last ? last.offset + last.text.length : valueStart);
    if (close === -1) {
      return undefined;
    }
    return { start: close, end: close, newText: `${last ? ", " : ""}${names.join(", ")}` };
  }
  const last = items[items.length - 1];
  if (!last) {
    return undefined;
  }
  const dash = text.lastIndexOf("-", last.offset);
  const indent = text.slice(lineStart(text, dash), dash);
  const at = lineEndAt(text, last.offset);
  return { start: at, end: at, newText: names.map((name) => `\n${indent}- ${name}`).join("") };
}

export interface EnvironFix {
  title: string;
  edit: TextEdit;
  /** Names declared by the fix. */
  names: string[];
}

/** Quick fixes for the undeclared variables in [start, end] of a document. */
export function environFixes(text: string, format: "pxu" | "yaml", start: number, end: number): EnvironFix[] {
  const parsed = format === "pxu" ? parsePxu(text) : parseYaml(text);
  const unit = parsed.units.find((u) => u.start <= start && start <= u.end);
  if (!unit) {
    return [];
  }
  const uses = undeclaredUses(unit);
  const all = [...new Set(uses.map((u) => u.name))];
  const here = [...new Set(uses.filter((u) => u.start <= end && start <= u.end).map((u) => u.name))];
  const fixes: EnvironFix[] = [];
  for (const name of here) {
    const edit = declareEnvironEdit(text, unit, [name], format);
    if (edit) {
      fixes.push({ title: `Declare ${name} in environ`, edit, names: [name] });
    }
  }
  if (here.length && all.length > 1) {
    const edit = declareEnvironEdit(text, unit, all, format);
    if (edit) {
      fixes.push({ title: `Declare all undeclared variables in environ (${all.join(", ")})`, edit, names: all });
    }
  }
  return fixes;
}
