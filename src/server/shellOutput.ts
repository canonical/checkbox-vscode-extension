/**
 * Keys printed by a resource job's shell command.
 *
 * Resource output is parsed by plainbox gen_rfc822_records: records of
 * "key: value" lines, the key being the text before the first colon. This
 * is a lenient, approximate shell reader: it finds the keys written by
 * echo/printf/cat heredocs, and the external commands whose output is not
 * discarded (resolved to provider scripts by the caller).
 */

import { ValueLine } from "./model";

export interface PrintedKey {
  name: string;
  start: number;
  end: number;
}

export interface ExternalCommand {
  name: string;
  start: number;
  end: number;
  /** "key: " literals found in its arguments (awk, jq, python3 -c ...). */
  keys: PrintedKey[];
}

export interface ShellOutput {
  keys: PrintedKey[];
  commands: ExternalCommand[];
  /** False when a printed key could not be determined statically. */
  complete: boolean;
}

/** Literal text at source index `at`, or a value only known at runtime. */
type Seg = { text: string; at: number } | { dyn: true };

interface Word {
  segs: Seg[];
  start: number;
  end: number;
  quoted: boolean;
}

interface Redirect {
  op: string;
  fd?: string;
  target?: string;
}

interface Command {
  words: Word[];
  redirects: Redirect[];
  bodies: Seg[][];
  piped: boolean;
}

const DYN: Seg = { dyn: true };

/** Reserved words that may precede a command. */
const PREFIX_WORDS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "time"]);
/** Commands that print nothing a resource could parse. */
const SILENT = new Set([
  ":", "true", "false", "exit", "return", "set", "unset", "shift", "read",
  "export", "local", "declare", "typeset", "readonly", "break", "continue",
  "cd", "test", "[", "[[", "]]", "wait", "trap", "umask", "sleep", "mkdir",
  "rm", "touch", "cp", "mv", "chmod", "chown", "ln", "kill", "sync",
  "for", "select", "case", "esac", "fi", "done", "}", "function",
]);
/** Commands that run their arguments as a command. */
const WRAPPERS = new Set(["resource_wrapper.sh", "exec", "command"]);

function literal(word: Word): string | undefined {
  let text = "";
  for (const seg of word.segs) {
    if ("dyn" in seg) {
      return undefined;
    }
    text += seg.text;
  }
  return text;
}

class Lexer {
  private i = 0;
  readonly commands: Command[] = [];
  private cur: Command = this.newCommand();
  private word?: Word;
  private redirect?: Redirect;
  private heredocs: { delim: string; quoted: boolean; strip: boolean; command: Command }[] = [];
  private caseDepth = 0;
  private casePattern = false;

  constructor(private readonly src: string) {}

  private newCommand(): Command {
    return { words: [], redirects: [], bodies: [], piped: false };
  }

  private lit(text: string, at: number) {
    const word = (this.word ??= { segs: [], start: at, end: at, quoted: false });
    const last = word.segs[word.segs.length - 1];
    if (last && "text" in last && last.at + last.text.length === at) {
      last.text += text;
    } else {
      word.segs.push({ text, at });
    }
    word.end = at + text.length;
  }

  private dyn(start: number, end: number) {
    const word = (this.word ??= { segs: [], start, end, quoted: false });
    word.segs.push(DYN);
    word.end = end;
  }

  private endWord() {
    const word = this.word;
    this.word = undefined;
    if (!word) {
      return;
    }
    const redirect = this.redirect;
    if (redirect) {
      this.redirect = undefined;
      const text = literal(word) ?? "";
      if (redirect.op === "<<" || redirect.op === "<<-") {
        this.heredocs.push({
          delim: text,
          quoted: word.quoted,
          strip: redirect.op === "<<-",
          command: this.cur,
        });
      } else {
        this.cur.redirects.push({ ...redirect, target: text });
      }
      return;
    }
    this.cur.words.push(word);
    const words = this.cur.words.map(literal);
    if (words.length === 3 && words[0] === "case" && words[2] === "in") {
      this.endCommand();
    }
  }

  private endCommand() {
    this.endWord();
    const first = this.cur.words.map(literal).find((w) => !PREFIX_WORDS.has(w ?? ""));
    if (first === "case") {
      this.caseDepth++;
      this.casePattern = true;
    } else if (first === "esac") {
      this.caseDepth = Math.max(0, this.caseDepth - 1);
    }
    if (this.cur.words.length || this.cur.redirects.length || this.cur.bodies.length) {
      this.commands.push(this.cur);
    }
    this.cur = this.newCommand();
  }

  /**
   * Index after a construct: from just after an opening quote or backtick
   * (open === close), or from an opening "(" / "{" (counted).
   */
  private skipBalanced(i: number, open: string, close: string): number {
    const src = this.src;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "\\") {
        i++;
      } else if (open === close) {
        if (c === close) {
          return i + 1;
        }
        if (c === "$" && src[i + 1] === "(") {
          i = this.skipBalanced(i + 1, "(", ")") - 1;
        }
      } else if (c === "'") {
        const end = src.indexOf("'", i + 1);
        i = end === -1 ? src.length : end;
      } else if (c === '"' || c === "`") {
        i = this.skipBalanced(i + 1, c, c) - 1;
      } else if (c === open) {
        depth++;
      } else if (c === close && --depth === 0) {
        return i + 1;
      }
    }
    return src.length;
  }

  /** Expansion at src[i] === "$"; returns the index after it. */
  private dollar(i: number): number {
    const src = this.src;
    const next = src[i + 1];
    let end: number;
    if (next === "(") {
      end = this.skipBalanced(i + 1, "(", ")");
    } else if (next === "{") {
      end = this.skipBalanced(i + 1, "{", "}");
    } else if (next === "'") {
      end = i + 2;
      while (end < src.length && src[end] !== "'") {
        end += src[end] === "\\" ? 2 : 1;
      }
      end++;
    } else if (next !== undefined && /[A-Za-z_]/.test(next)) {
      end = i + 1;
      while (end < src.length && /\w/.test(src[end])) {
        end++;
      }
    } else if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      end = i + 2;
    } else {
      this.lit("$", i);
      return i + 1;
    }
    this.dyn(i, end);
    return end;
  }

  private doubleQuoted(i: number): number {
    const src = this.src;
    this.word ??= { segs: [], start: i - 1, end: i, quoted: true };
    this.word.quoted = true;
    while (i < src.length && src[i] !== '"') {
      const c = src[i];
      if (c === "\\" && /[$`"\\\n]/.test(src[i + 1] ?? "")) {
        if (src[i + 1] !== "\n") {
          this.lit(src[i + 1], i + 1);
        }
        i += 2;
      } else if (c === "$") {
        i = this.dollar(i);
      } else if (c === "`") {
        const end = this.skipBalanced(i + 1, "`", "`");
        this.dyn(i, end);
        i = end;
      } else {
        this.lit(c, i);
        i++;
      }
    }
    return i + 1;
  }

  private readHeredocs() {
    const src = this.src;
    for (const doc of this.heredocs.splice(0)) {
      const body: Seg[] = [];
      while (this.i < src.length) {
        const eol = src.indexOf("\n", this.i);
        const end = eol === -1 ? src.length : eol;
        let start = this.i;
        if (doc.strip) {
          while (src[start] === "\t") {
            start++;
          }
        }
        this.i = end + 1;
        if (src.slice(start, end) === doc.delim) {
          break;
        }
        const line = src.slice(start, end + 1);
        if (doc.quoted) {
          body.push({ text: line, at: start });
          continue;
        }
        let k = 0;
        let from = 0;
        while (k < line.length) {
          if (line[k] === "\\") {
            k += 2;
          } else if (line[k] === "$" || line[k] === "`") {
            body.push({ text: line.slice(from, k), at: start + from });
            const saved = this.word;
            this.word = { segs: [], start: 0, end: 0, quoted: false };
            k =
              (line[k] === "$" ? this.dollar(start + k) : this.skipBalanced(start + k + 1, "`", "`")) - start;
            this.word = saved;
            body.push(DYN);
            from = k;
          } else {
            k++;
          }
        }
        body.push({ text: line.slice(from), at: start + from });
      }
      doc.command.bodies.push(body);
    }
  }

  /** Skips a case pattern list up to its ")". */
  private skipPattern(): boolean {
    const src = this.src;
    while (this.i < src.length && /\s/.test(src[this.i])) {
      this.i++;
    }
    if (/^esac\b/.test(src.slice(this.i, this.i + 5))) {
      this.casePattern = false;
      return false;
    }
    for (; this.i < src.length; this.i++) {
      const c = src[this.i];
      if (c === "\\") {
        this.i++;
      } else if (c === "'") {
        const end = src.indexOf("'", this.i + 1);
        this.i = end === -1 ? src.length : end;
      } else if (c === '"') {
        this.i = this.skipBalanced(this.i + 1, c, c) - 1;
      } else if (c === ")") {
        this.i++;
        break;
      }
    }
    this.casePattern = false;
    return true;
  }

  run(): Command[] {
    const src = this.src;
    while (this.i < src.length) {
      if (this.casePattern && !this.word && this.cur.words.length === 0) {
        if (this.skipPattern()) {
          continue;
        }
      }
      const i = this.i;
      const c = src[i];
      if (c === " " || c === "\t" || c === "\r") {
        this.endWord();
        this.i++;
      } else if (c === "\n") {
        this.endCommand();
        this.i++;
        this.readHeredocs();
      } else if (c === "#" && !this.word) {
        const eol = src.indexOf("\n", i);
        this.i = eol === -1 ? src.length : eol;
      } else if (c === "\\") {
        if (src[i + 1] !== "\n" && i + 1 < src.length) {
          this.lit(src[i + 1], i + 1);
          this.word!.quoted = true;
        }
        this.i += 2;
      } else if (c === "'") {
        const end = src.indexOf("'", i + 1);
        const close = end === -1 ? src.length : end;
        this.word ??= { segs: [], start: i, end: i, quoted: true };
        this.word.quoted = true;
        if (close > i + 1) {
          this.lit(src.slice(i + 1, close), i + 1);
        }
        this.i = close + 1;
      } else if (c === '"') {
        this.i = this.doubleQuoted(i + 1);
      } else if (c === "$") {
        this.i = this.dollar(i);
      } else if (c === "`") {
        const end = this.skipBalanced(i + 1, "`", "`");
        this.dyn(i, end);
        this.i = end;
      } else if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
        const op = /^(&>>|&>|>>|>&|>\||<<<|<<-|<<|<&|<>|>|<)/.exec(src.slice(i, i + 3))![0];
        const fdText = this.word && literal(this.word);
        const fd = fdText !== undefined && /^\d+$/.test(fdText) ? fdText : undefined;
        if (fd !== undefined) {
          this.word = undefined;
        } else {
          this.endWord();
        }
        this.redirect = { op, fd };
        this.i += op.length;
      } else if (";&|()".includes(c)) {
        this.endWord();
        const two = src.slice(i, i + 2);
        if (two === ";;" || two === ";&") {
          this.endCommand();
          this.i += src.slice(i, i + 3) === ";;&" ? 3 : 2;
          this.casePattern = this.caseDepth > 0;
        } else if (two === "&&" || two === "||") {
          this.endCommand();
          this.i += 2;
        } else if (c === "|") {
          this.cur.piped = true;
          this.endCommand();
          this.i += two === "|&" ? 2 : 1;
        } else {
          this.endCommand();
          this.i++;
        }
      } else {
        this.lit(c, i);
        this.i++;
      }
    }
    this.endCommand();
    this.readHeredocs();
    return this.commands;
  }
}

function stdoutDiscarded(command: Command): boolean {
  return (
    command.piped ||
    command.redirects.some((r) => {
      const stdout = r.fd === undefined || r.fd === "1";
      if (r.op === "&>" || r.op === "&>>") {
        return true;
      }
      if (r.op === ">&") {
        return stdout && r.target !== "1";
      }
      return stdout && (r.op === ">" || r.op === ">>" || r.op === ">|");
    })
  );
}

/** Interprets backslash escapes and printf conversions of literal text. */
function printfSegs(segs: Seg[], conversions: boolean): Seg[] {
  const out: Seg[] = [];
  for (const seg of segs) {
    if ("dyn" in seg) {
      out.push(seg);
      continue;
    }
    let from = 0;
    const text = seg.text;
    const flush = (to: number) => {
      if (to > from) {
        out.push({ text: text.slice(from, to), at: seg.at + from });
      }
    };
    for (let k = 0; k < text.length; k++) {
      if (text[k] === "\\" && text[k + 1] === "n") {
        flush(k);
        out.push({ text: "\n", at: seg.at + k });
        from = ++k + 1;
      } else if (conversions && text[k] === "%") {
        flush(k);
        if (text[k + 1] === "%") {
          out.push({ text: "%", at: seg.at + k });
          k++;
        } else {
          const m = /^%[-+ 0#]*\d*(?:\.\d+)?[a-zA-Z]/.exec(text.slice(k));
          out.push(DYN);
          k += (m?.[0].length ?? 1) - 1;
        }
        from = k + 1;
      }
    }
    flush(text.length);
  }
  return out;
}

/**
 * Keys at the start of each printed line. A key is dynamic when it may
 * hold an identifier not known statically (requires can't name the others).
 */
function lineKeys(segs: Seg[], keys: PrintedKey[]): boolean {
  let complete = true;
  let chars: { ch: string; at: number }[] = [];
  let dyn = false;
  let atStart = true;
  const endKey = () => {
    if (chars[0] && /[ \t]/.test(chars[0].ch) && !dyn) {
      return; // Continuation line
    }
    const text = chars.map((c) => c.ch).join("");
    if (dyn) {
      if (!/[^\w\s]/.test(text)) {
        complete = false;
      }
      return;
    }
    const first = chars.findIndex((c) => !/\s/.test(c.ch));
    if (first === -1) {
      return;
    }
    let last = chars.length - 1;
    while (/\s/.test(chars[last].ch)) {
      last--;
    }
    keys.push({ name: text.trim(), start: chars[first].at, end: chars[last].at + 1 });
  };
  const reset = () => {
    chars = [];
    dyn = false;
    atStart = true;
  };
  for (const seg of [...segs, { text: "\n", at: -1 }]) {
    if ("dyn" in seg) {
      dyn ||= atStart;
      continue;
    }
    for (let k = 0; k < seg.text.length; k++) {
      const ch = seg.text[k];
      if (ch === "\n") {
        // A dynamic line without a literal colon may be "key: value"
        if (atStart && dyn && !/[^\w\s]/.test(chars.map((c) => c.ch).join(""))) {
          complete = false;
        }
        reset();
      } else if (atStart && ch === ":") {
        endKey();
        atStart = false;
      } else if (atStart) {
        chars.push({ ch, at: seg.at + k });
      }
    }
  }
  return complete;
}

const HARVEST = /(?:^|\\n|\n|["'=({,]\s*)([A-Za-z_][\w-]*): /g;

function harvest(words: Word[]): PrintedKey[] {
  const keys: PrintedKey[] = [];
  for (const word of words) {
    for (const seg of word.segs) {
      if ("dyn" in seg) {
        continue;
      }
      for (const m of seg.text.matchAll(HARVEST)) {
        const start = seg.at + m.index! + m[0].length - m[1].length - 2;
        keys.push({ name: m[1], start, end: start + m[1].length });
      }
    }
  }
  return keys;
}

/** Keys printed by a shell script given as lines with document offsets. */
export function shellOutput(lines: ValueLine[]): ShellOutput {
  const src = lines.map((line) => line.text).join("\n");
  const offsets: number[] = [];
  for (const line of lines) {
    for (let i = 0; i <= line.text.length; i++) {
      offsets.push(line.offset + i);
    }
  }
  const toDoc = (at: number) => offsets[at] ?? at;
  const result: ShellOutput = { keys: [], commands: [], complete: true };
  const keys: PrintedKey[] = [];
  for (const command of new Lexer(src).run()) {
    let k = 0;
    const words = command.words;
    const assignment = (w: Word) => {
      const first = w.segs[0];
      return first !== undefined && "text" in first && /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(first.text);
    };
    for (;;) {
      while (k < words.length && (PREFIX_WORDS.has(literal(words[k]) ?? "") || assignment(words[k]))) {
        k++;
      }
      const name = words[k] && literal(words[k]);
      if (name === "--" || (name !== undefined && WRAPPERS.has(name) && k + 1 < words.length)) {
        if (name === "command" && literal(words[k + 1]) === "-v") {
          break;
        }
        k++;
        continue;
      }
      break;
    }
    if (k >= words.length && command.bodies.length === 0) {
      continue;
    }
    if (stdoutDiscarded(command)) {
      continue;
    }
    const word = words[k];
    const name = word && literal(word);
    if (word && name === undefined) {
      result.complete = false;
      continue;
    }
    const args = words.slice(k + 1);
    // "command" is only left here as "command -v", which prints a path
    if (name === undefined || SILENT.has(name) || name === "command") {
      continue;
    }
    if (name === "grep" && args.some((a) => /^(-\w*q\w*|--quiet|--silent)$/.test(literal(a) ?? ""))) {
      continue;
    }
    if (name === "echo" || name === "printf") {
      let segs: Seg[];
      if (name === "echo") {
        let escapes = false;
        let i = 0;
        for (; i < args.length && /^-[neE]+$/.test(literal(args[i]) ?? ""); i++) {
          escapes ||= literal(args[i])!.includes("e");
        }
        segs = args.slice(i).flatMap((a, n) => [...(n ? [{ text: " ", at: -1 }] : []), ...a.segs]);
        segs = escapes ? printfSegs(segs, false) : segs;
      } else {
        segs = args[0] ? printfSegs(args[0].segs, true) : [];
      }
      result.complete = lineKeys(segs, keys) && result.complete;
      continue;
    }
    if (name === "cat" && command.bodies.length > 0) {
      for (const body of command.bodies) {
        result.complete = lineKeys(body, keys) && result.complete;
      }
      continue;
    }
    result.commands.push({
      name,
      start: toDoc(word.start),
      end: toDoc(word.end - 1) + 1,
      keys: harvest(args).map((key) => ({ ...key, start: toDoc(key.start), end: toDoc(key.end - 1) + 1 })),
    });
  }
  result.keys = keys.map((key) => ({ ...key, start: toDoc(key.start), end: toDoc(key.end - 1) + 1 }));
  for (const command of result.commands) {
    command.keys = command.keys.filter((key) => key.start >= 0);
  }
  return result;
}
