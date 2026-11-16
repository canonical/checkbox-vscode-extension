/**
 * Position-aware parser for PXU (RFC822-like) unit files.
 *
 * Mirrors plainbox.impl.secure.rfc822.gen_rfc822_records: records are
 * separated by blank lines, lines starting with "#" are comments, lines
 * starting with a space continue the previous value (the space is dropped)
 * and other lines must contain a colon. Unlike plainbox, parsing continues
 * after errors so that the rest of the file can still be indexed.
 */

import { Field, ParseError, ParseResult, RawUnit, ValueLine } from "../model";

const LINE_RE = /\r\n|\r|\n/g;

/** Split text into lines, keeping the offset of each line start. */
export function splitLines(text: string): { text: string; offset: number }[] {
  const lines: { text: string; offset: number }[] = [];
  let start = 0;
  LINE_RE.lastIndex = 0;
  for (let m = LINE_RE.exec(text); m; m = LINE_RE.exec(text)) {
    lines.push({ text: text.slice(start, m.index), offset: start });
    start = m.index + m[0].length;
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), offset: start });
  }
  return lines;
}

export function parsePxu(text: string): ParseResult {
  const units: RawUnit[] = [];
  const errors: ParseError[] = [];
  let fields = new Map<string, Field>();
  let start = -1;
  let end = -1;
  let current: { field: Field; lines: ValueLine[] } | undefined;

  const commit = () => {
    if (current) {
      current.field.value = { kind: "string", lines: current.lines };
      current = undefined;
    }
  };
  const finishRecord = () => {
    commit();
    if (fields.size > 0) {
      units.push({ fields, start, end });
    }
    fields = new Map();
    start = -1;
  };

  for (const line of splitLines(text)) {
    const lineEnd = line.offset + line.text.length;
    if (line.text.startsWith("#")) {
      continue;
    }
    if (line.text.trim() === "") {
      finishRecord();
      continue;
    }
    if (line.text.startsWith(" ")) {
      if (!current) {
        errors.push({
          message: "Unexpected multi-line value",
          start: line.offset,
          end: lineEnd,
        });
        continue;
      }
      let value = line.text.slice(1);
      // plainbox drops the " ." empty-line marker of multi-line values
      if (/^\s*\.$/.test(value)) {
        value = "";
      }
      current.lines.push({ text: value, offset: line.offset + 1 });
      end = lineEnd;
      continue;
    }
    const colon = line.text.indexOf(":");
    if (colon === -1) {
      errors.push({
        message: `Unexpected non-empty line: ${JSON.stringify(line.text)}`,
        start: line.offset,
        end: lineEnd,
      });
      continue;
    }
    commit();
    if (start === -1) {
      start = line.offset;
    }
    end = lineEnd;
    const rawKey = line.text.slice(0, colon);
    const keyLead = rawKey.length - rawKey.trimStart().length;
    const keyText = rawKey.trim();
    const keyStart = line.offset + keyLead;
    const rest = line.text.slice(colon + 1);
    const valueLead = rest.length - rest.trimStart().length;
    // Translatable fields are prefixed with "_" (e.g. _summary)
    const key = keyText.replace(/^_/, "");
    if (fields.has(key)) {
      errors.push({
        message: `Job has a duplicate key '${keyText}'`,
        start: keyStart,
        end: keyStart + keyText.length,
      });
    }
    const field: Field = {
      key,
      keyStart,
      keyEnd: keyStart + keyText.length,
      value: { kind: "string", lines: [] },
    };
    fields.set(key, field);
    const valueText = rest.trimStart();
    current = {
      field,
      lines:
        valueText.trim() === ""
          ? []
          : [{ text: valueText, offset: line.offset + colon + 1 + valueLead }],
    };
  }
  finishRecord();
  return { units, errors };
}
