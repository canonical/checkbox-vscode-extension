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

/** Problems for variables used in `command` but missing from `environ`. */
export function undeclaredEnviron(unit: RawUnit): Problem[] {
  const command = unit.fields.get("command");
  if (command?.value.kind !== "string") {
    return [];
  }
  const { uses, assigned } = scanShell(command.value.lines);
  const environ = declared(unit.fields.get("environ"));
  return uses
    .filter((u) => !assigned.has(u.name) && !environ.has(u.name) && !isKnown(u.name))
    .map((u) => ({
      message: `Environment variable ${u.name} is not declared in environ`,
      start: u.start,
      end: u.end,
      severity: "warning" as const,
    }));
}
