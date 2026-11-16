/**
 * Small tokenizers mirroring the plainbox parsers used for unit references.
 */

import { ValueLine } from "./model";

export interface Token {
  kind: "word" | "comma" | "equals" | "invalid";
  text: string;
  offset: number;
}

/**
 * Mirrors plainbox.impl.xscanners.WordScanner (whitespace and comments are
 * skipped). Bare words end at whitespace, "#", "," or "=". Quoted words use
 * double quotes, which are not part of the word.
 */
export function scanWords(line: ValueLine): Token[] {
  const tokens: Token[] = [];
  const s = line.text;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "#") {
      break;
    } else if (c === ",") {
      tokens.push({ kind: "comma", text: c, offset: line.offset + i });
      i++;
    } else if (c === "=") {
      tokens.push({ kind: "equals", text: c, offset: line.offset + i });
      i++;
    } else if (c === '"') {
      const close = s.indexOf('"', i + 1);
      if (close === -1) {
        tokens.push({ kind: "invalid", text: s.slice(i), offset: line.offset + i });
        break;
      }
      tokens.push({
        kind: "word",
        text: s.slice(i + 1, close),
        offset: line.offset + i + 1,
      });
      i = close + 1;
    } else {
      let j = i;
      while (j < s.length && !/[\s#,=]/.test(s[j])) {
        j++;
      }
      tokens.push({ kind: "word", text: s.slice(i, j), offset: line.offset + i });
      i = j;
    }
  }
  return tokens;
}

/** Mirrors plainbox.impl.xparsers.WordList.parse on a multi-line string. */
export function parseWordList(lines: ValueLine[]): ValueLine[] {
  const words: ValueLine[] = [];
  for (const line of lines) {
    for (const token of scanWords(line)) {
      if (token.kind === "invalid") {
        return words;
      }
      if (token.kind === "word") {
        words.push({ text: token.text, offset: token.offset });
      }
    }
  }
  return words;
}

export type IncludeLine =
  | { kind: "ok"; pattern: ValueLine }
  | { kind: "error"; message: string; line: ValueLine }
  | undefined;

/**
 * Mirrors plainbox.impl.xparsers.IncludeStmt.parse:
 * PATTERN [FIELD=VALUE [, FIELD=VALUE ...]]. Blank/comment lines yield
 * undefined. A malformed line yields no pattern at all, like plainbox.
 */
export function parseIncludeLine(line: ValueLine): IncludeLine {
  const tokens = scanWords(line);
  if (tokens.length === 0) {
    return undefined;
  }
  const error = (message: string): IncludeLine => ({ kind: "error", message, line });
  if (tokens[0].kind !== "word") {
    return error("expected pattern");
  }
  let i = 1;
  while (i < tokens.length) {
    if (tokens[i].kind !== "word") {
      return error("expected override field");
    }
    if (tokens[i + 1]?.kind !== "equals") {
      return error("expected '='");
    }
    if (tokens[i + 2]?.kind !== "word") {
      return error("expected override value");
    }
    i += 3;
    if (i < tokens.length) {
      if (tokens[i].kind !== "comma") {
        return error("expected ','");
      }
      i++;
    }
  }
  return { kind: "ok", pattern: { text: tokens[0].text, offset: tokens[0].offset } };
}

/**
 * Mirrors plainbox.impl.xparsers.Re.parse: a pattern made only of literal
 * characters (according to Python's sre_parse) is a fixed id, anything
 * else is a regular expression.
 */
export function classifyPattern(text: string): "fixed" | "pattern" | "error" {
  try {
    new RegExp(toJsRegex(text));
  } catch {
    return "error";
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      // Escaped punctuation is a literal, \d \w ... are not
      if (/[A-Za-z0-9]/.test(text[i + 1] ?? "")) {
        return "pattern";
      }
      i++;
    } else if (".^$*+?|()[".includes(c)) {
      return "pattern";
    } else if (c === "{" && i > 0 && /^\{\d*,?\d*\}/.test(text.slice(i)) && text[i + 1] !== "}") {
      return "pattern";
    }
  }
  return "fixed";
}

/** Translate the Python-only regex syntax used in practice to JS. */
export function toJsRegex(pattern: string): string {
  return pattern.replace(/\(\?P</g, "(?<").replace(/\(\?P=(\w+)\)/g, "\\k<$1>");
}

export interface ImportStmt {
  namespace: string;
  partialId: string;
  alias: string;
  /** Position of the partial id within the document. */
  idOffset: number;
  namespaceOffset: number;
}

/** Mirrors plainbox.impl.resource.parse_imports_stmt for a single line. */
export function parseImport(line: ValueLine): ImportStmt | string {
  const parts: ValueLine[] = [];
  const re = /\S+/g;
  for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
    parts.push({ text: m[0], offset: line.offset + m.index });
  }
  const stmt = line.text.trim();
  if (parts.length !== 4 && parts.length !== 6) {
    return `unable to parse imports statement '${stmt}': expected exactly four or six tokens`;
  }
  if (parts[0].text !== "from") {
    return `unable to parse imports statement '${stmt}': expected 'from' keyword`;
  }
  if (parts[1].text.includes("::")) {
    return `unable to parse imports statement '${stmt}': expected a namespace, not fully qualified job identifier`;
  }
  if (parts[2].text !== "import") {
    return `unable to parse imports statement '${stmt}': expected 'import' keyword`;
  }
  if (parts[3].text.includes("::")) {
    return `unable to parse imports statement '${stmt}': expected a partial job identifier, not a fully qualified job identifier`;
  }
  if (parts.length === 6 && parts[4].text !== "as") {
    return `unable to parse imports statement '${stmt}': expected 'as' keyword`;
  }
  return {
    namespace: parts[1].text,
    partialId: parts[3].text,
    alias: parts.length === 6 ? parts[5].text : parts[3].text,
    idOffset: parts[3].offset,
    namespaceOffset: parts[1].offset,
  };
}

const PY_KEYWORDS = new Set([
  "and", "or", "not", "in", "is", "if", "else", "lambda", "True", "False", "None",
]);

function skipString(s: string, i: number): number {
  const quote = s[i];
  const triple = s.startsWith(quote.repeat(3), i);
  const close = triple ? quote.repeat(3) : quote;
  let j = i + close.length;
  while (j < s.length) {
    if (s[j] === "\\") {
      j += 2;
    } else if (s.startsWith(close, j)) {
      return j + close.length;
    } else {
      j++;
    }
  }
  return s.length;
}

/**
 * Names referenced by a resource expression (one line of "requires" or
 * "template-filter"), mirroring plainbox.impl.resource.ResourceNodeVisitor:
 * top-level ast.Name nodes, excluding attributes, call targets and call
 * arguments (visit_Call does not recurse). Names inside "{...}" template
 * placeholders are ignored.
 */
export function resourceNames(line: ValueLine): ValueLine[] {
  const s = line.text;
  const names: ValueLine[] = [];
  let prev = "";
  let braces = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipString(s, i);
      prev = "str";
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < s.length && /[\w.]/.test(s[i])) {
        i++;
      }
      prev = "num";
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /\w/.test(s[j])) {
        j++;
      }
      const word = s.slice(i, j);
      if (/^[rRbBuUfF]{1,2}$/.test(word) && (s[j] === "'" || s[j] === '"')) {
        i = skipString(s, j);
        prev = "str";
        continue;
      }
      let k = j;
      while (k < s.length && /\s/.test(s[k])) {
        k++;
      }
      if (s[k] === "(" && prev !== "." && !PY_KEYWORDS.has(word)) {
        // Call: neither the target nor the arguments are recorded
        let depth = 0;
        for (k; k < s.length; k++) {
          if (s[k] === "'" || s[k] === '"') {
            k = skipString(s, k) - 1;
          } else if (s[k] === "(") {
            depth++;
          } else if (s[k] === ")" && --depth === 0) {
            break;
          }
        }
        i = k + 1;
        prev = "call";
        continue;
      }
      if (!PY_KEYWORDS.has(word) && prev !== "." && braces === 0) {
        names.push({ text: word, offset: line.offset + i });
      }
      prev = "name";
      i = j;
      continue;
    }
    if (c === "{") {
      braces++;
    } else if (c === "}") {
      braces = Math.max(0, braces - 1);
    }
    prev = c;
    i++;
  }
  return names;
}

/**
 * Mirrors plainbox.impl.xparsers.FieldOverride.parse for a single line:
 * "apply VALUE to PATTERN". Blank/comment lines yield undefined.
 */
export function parseOverrideLine(
  line: ValueLine,
): { value: ValueLine; pattern: ValueLine } | string | undefined {
  const tokens = scanWords(line).filter((t) => t.kind === "word");
  if (tokens.length === 0) {
    return undefined;
  }
  const [apply, value, to, pattern, extra] = tokens;
  if (apply.text !== "apply") {
    return "expected 'apply'";
  }
  if (!value) {
    return "expected override value";
  }
  if (to?.text !== "to") {
    return "expected 'to'";
  }
  if (!pattern) {
    return "expected override pattern";
  }
  if (extra) {
    return "unexpected garbage";
  }
  return { value, pattern };
}
