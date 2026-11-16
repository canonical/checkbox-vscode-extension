import * as assert from "node:assert/strict";
import { test } from "node:test";
import { stringValue } from "../src/server/model";
import { parsePxu } from "../src/server/parsers/pxu";
import { parseYaml } from "../src/server/parsers/yaml";
import { classifyPattern, parseImport, parseIncludeLine, resourceNames } from "../src/server/syntax";

const at = (text: string, needle: string) => text.indexOf(needle);

test("PXU records, continuations, comments and translatable keys", () => {
  const text = "# comment\nid: a\n_summary: first\n line\n .\n line3\n\nid: b\n";
  const { units, errors } = parsePxu(text);
  assert.deepEqual(errors, []);
  assert.equal(units.length, 2);
  assert.equal(stringValue(units[0].fields.get("summary")), "first\nline\n\nline3");
  const id = units[1].fields.get("id")!;
  assert.equal(id.value.kind === "string" && id.value.lines[0].offset, at(text, "b\n"));
});

test("PXU duplicate keys are reported", () => {
  const { errors } = parsePxu("id: a\nid: b\n");
  assert.equal(errors.length, 1);
});

test("YAML lists, maps and scalar offsets", () => {
  const text = "id: tp\nunit: test plan\ninclude:\n  - foo\n  - bar: {certification_status: blocker}\n---\nid: j\n";
  const { units, errors } = parseYaml(text);
  assert.deepEqual(errors, []);
  assert.equal(units.length, 2);
  const include = units[0].fields.get("include")!.value;
  assert.equal(include.kind, "list");
  if (include.kind === "list") {
    assert.deepEqual(include.items[0], { kind: "string", line: { text: "foo", offset: at(text, "foo") } });
    assert.equal(include.items[1].kind === "map" && include.items[1].entries[0].key.offset, at(text, "bar"));
  }
});

test("include lines, imports and patterns", () => {
  assert.deepEqual(parseIncludeLine({ text: "  foo/bar  certification_status=blocker", offset: 10 }), {
    kind: "ok",
    pattern: { text: "foo/bar", offset: 12 },
  });
  assert.equal(parseIncludeLine({ text: "foo bar", offset: 0 })?.kind, "error");
  assert.equal(parseIncludeLine({ text: "  # comment", offset: 0 }), undefined);
  assert.deepEqual(parseImport({ text: "from com.x import res as r", offset: 0 }), {
    namespace: "com.x",
    partialId: "res",
    alias: "r",
    idOffset: 18,
    namespaceOffset: 5,
  });
  assert.equal(typeof parseImport({ text: "from com.x import a::b", offset: 0 }), "string");
  assert.equal(classifyPattern("foo/bar-baz"), "fixed");
  assert.equal(classifyPattern("foo/.*"), "pattern");
  assert.equal(classifyPattern("foo/("), "error");
});

test("requires resource names mirror ResourceNodeVisitor", () => {
  const names = (text: string) => resourceNames({ text, offset: 0 }).map((n) => n.text);
  assert.deepEqual(names("package.name == 'a.b' and int(cpuinfo.count) > 1"), ["package"]);
  assert.deepEqual(names("a.x == 1 or (b.y in ['c.d'] and not c.z)"), ["a", "b", "c"]);
  assert.deepEqual(names("manifest.has_x == 'True'"), ["manifest"]);
});
