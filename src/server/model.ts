/**
 * Format-neutral representation of unit records, shared by the PXU and YAML
 * parsers. Positions are document offsets so that both formats can be
 * handled by the same reference extraction code.
 */

/** A line (or scalar) of a field value and the document offset of text[0]. */
export interface ValueLine {
  text: string;
  offset: number;
}

export interface MapEntry {
  key: ValueLine;
  /** Plain JS value of the entry (as YAML would construct it). */
  value: unknown;
  /** Position of the value when it is a string scalar. */
  valueLine?: ValueLine;
}

export type ListItem =
  | { kind: "string"; line: ValueLine }
  | { kind: "map"; entries: MapEntry[] }
  | { kind: "other" };

/**
 * A field value. Mirrors the two shapes plainbox handles: a string (legacy
 * PXU syntax, also allowed in YAML) or a list (YAML).
 */
export type FieldValue =
  | { kind: "string"; lines: ValueLine[] }
  | { kind: "list"; items: ListItem[] }
  | { kind: "other" };

export interface Field {
  key: string;
  keyStart: number;
  keyEnd: number;
  value: FieldValue;
}

export interface RawUnit {
  fields: Map<string, Field>;
  start: number;
  end: number;
}

export interface ParseError {
  message: string;
  start: number;
  end: number;
}

export interface ParseResult {
  units: RawUnit[];
  errors: ParseError[];
}

/** Text of a string field, normalized like plainbox (stripped). */
export function stringValue(field: Field | undefined): string | undefined {
  if (!field || field.value.kind !== "string") {
    return undefined;
  }
  return field.value.lines
    .map((line) => line.text)
    .join("\n")
    .trim();
}

/** First non-blank line of a string field, with leading blanks skipped. */
export function trimmedLine(field: Field | undefined): ValueLine | undefined {
  if (!field || field.value.kind !== "string") {
    return undefined;
  }
  for (const line of field.value.lines) {
    const lead = line.text.length - line.text.trimStart().length;
    const text = line.text.trim();
    if (text) {
      return { text, offset: line.offset + lead };
    }
  }
  return undefined;
}
