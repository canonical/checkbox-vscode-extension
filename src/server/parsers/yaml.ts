/**
 * Position-aware parser for YAML unit files.
 *
 * Mirrors plainbox.impl.secure.providers.v1.YAMLUnitPlugIn: every YAML
 * document is one unit. PyYAML implements YAML 1.1 and allows duplicate
 * keys, so the parser is configured the same way.
 */

import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  Scalar,
} from "yaml";
import {
  Field,
  FieldValue,
  ListItem,
  MapEntry,
  ParseError,
  ParseResult,
  RawUnit,
  ValueLine,
} from "../model";
import { splitLines } from "./pxu";

function scalarLines(node: Scalar, text: string): ValueLine[] {
  const [start, end] = node.range ?? [0, 0];
  const source = text.slice(start, end);
  switch (node.type) {
    case Scalar.BLOCK_LITERAL:
    case Scalar.BLOCK_FOLDED:
      // Skip the block header line ("|", ">-", ...), keep raw lines
      return splitLines(source)
        .slice(1)
        .map((line) => ({ text: line.text, offset: start + line.offset }));
    case Scalar.PLAIN:
      if (/[\r\n]/.test(source)) {
        return splitLines(source).map((line) => ({
          text: line.text,
          offset: start + line.offset,
        }));
      }
      return [{ text: String(node.value), offset: start }];
    default:
      // Quoted scalars: content starts after the opening quote
      return [{ text: String(node.value), offset: start + 1 }];
  }
}

function scalarItem(node: Scalar, text: string): ValueLine {
  const lines = scalarLines(node, text);
  const first = lines.find((line) => line.text.trim() !== "") ?? lines[0];
  if (lines.length <= 1 || typeof node.value !== "string") {
    return first ?? { text: String(node.value), offset: node.range?.[0] ?? 0 };
  }
  const lead = first.text.length - first.text.trimStart().length;
  return { text: node.value, offset: first.offset + lead };
}

function isStringScalar(node: unknown): node is Scalar<string> {
  return isScalar(node) && typeof node.value === "string";
}

function toValue(node: unknown, text: string): FieldValue {
  if (isStringScalar(node)) {
    return { kind: "string", lines: scalarLines(node, text) };
  }
  if (isSeq(node)) {
    const items: ListItem[] = node.items.map((item): ListItem => {
      if (isStringScalar(item)) {
        return { kind: "string", line: scalarItem(item, text) };
      }
      if (isMap(item)) {
        const entries: MapEntry[] = [];
        for (const pair of item.items) {
          if (!isScalar(pair.key)) {
            continue;
          }
          const entry: MapEntry = {
            key: scalarItem(pair.key, text),
            value: isScalar(pair.value)
              ? pair.value.value
              : (pair.value as { toJSON?: () => unknown } | null)?.toJSON?.(),
          };
          if (isStringScalar(pair.value)) {
            entry.valueLine = scalarItem(pair.value, text);
          }
          entries.push(entry);
        }
        return { kind: "map", entries };
      }
      return { kind: "other" };
    });
    return { kind: "list", items };
  }
  return { kind: "other" };
}

function toUnit(doc: Document.Parsed, text: string): RawUnit | undefined {
  const contents = doc.contents;
  if (!isMap(contents)) {
    return undefined;
  }
  const fields = new Map<string, Field>();
  for (const pair of contents.items) {
    if (!isScalar(pair.key) || !pair.key.range) {
      continue;
    }
    const key = String(pair.key.value);
    fields.set(key, {
      key,
      keyStart: pair.key.range[0],
      keyEnd: pair.key.range[1],
      value: toValue(pair.value, text),
    });
  }
  const [start, , end] = contents.range ?? [0, 0, 0];
  return { fields, start, end };
}

export function parseYaml(text: string): ParseResult {
  const units: RawUnit[] = [];
  const errors: ParseError[] = [];
  const docs = parseAllDocuments(text, { version: "1.1", uniqueKeys: false });
  if (!Array.isArray(docs)) {
    return { units, errors };
  }
  for (const doc of docs) {
    for (const error of doc.errors) {
      errors.push({
        message: error.message.split("\n")[0],
        start: error.pos[0],
        end: error.pos[1],
      });
    }
    const unit = toUnit(doc, text);
    if (unit) {
      units.push(unit);
    }
  }
  return { units, errors };
}
