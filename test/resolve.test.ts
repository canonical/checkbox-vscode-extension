import * as assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceIndex } from "../src/server/index";
import { completionCandidates, completionContext } from "../src/server/completion";
import { hoverMarkdown } from "../src/server/hover";
import { resolve } from "../src/server/resolve";
import { findReferences, targetsAt } from "../src/server/usages";
import { fileDiagnostics } from "../src/server/workspace";

const OTHER = `
unit: category
id: cat

id: res
_summary: Collect *resources*
plugin: resource

id: plain
plugin: shell

unit: template
template-resource: res
id: tpl/{name}
template-id: tpl/name
plugin: shell
flags: also-after-suspend

id: job-with-sibling
plugin: shell
_summary: Parent
siblings: [{"id": "sibling", "plugin": "resource", "_summary": "Sibling"}]
`;

function makeIndex(units: string, file = "/p/units/a.pxu") {
  const index = new WorkspaceIndex();
  index.setProvider("/p/manage.py", 'setup(name="ns:p")');
  index.setProvider("/q/manage.py", 'setup(name="other:q", namespace="ns")');
  index.updateFile("/q/units/other.pxu", OTHER);
  const entry = index.updateFile(file, units);
  const messages = fileDiagnostics(index, entry).map((d) => `${units.slice(d.start, d.end)}: ${d.message}`);
  return { index, entry, messages };
}

test("valid references produce no diagnostics", () => {
  const { messages } = makeIndex(`
id: j
plugin: shell
category_id: cat
depends: plain tpl/foo
after: ns::job-with-sibling
imports: from ns import res as r
requires:
 r.x == 1 and sibling.y == 2

unit: test plan
id: tp
include:
 j
 tpl/name
 after-suspend-tpl/name
 after-suspend-tpl/.*
 pl.*
bootstrap_include: res
`);
  assert.deepEqual(messages, []);
});

test("invalid references are flagged", () => {
  const { messages } = makeIndex(`
id: j
plugin: shell
category_id: plain
depends: missing
requires: plain.x == 1
imports: from nowhere import x

unit: test plan
id: tp
include:
 nope/.*
 bad(
bootstrap_include: cat
nested_part: j
`);
  assert.deepEqual(messages.sort(), [
    "missing: unit ns::missing is not available",
    "plain: the referenced job is not a resource job",
    "x: unknown namespace nowhere",
    "plain: the referenced unit is not a category",
    "bad(: Invalid regular expression: bad(",
    "nope/.*: pattern nope/.* does not match any unit",
    "cat: the referenced unit is not a job",
    "j: the referenced unit is not a test plan",
  ].sort());
});

test("YAML units and go to definition targets", () => {
  const units = "id: y\nplugin: shell\ndepends:\n  - plain\n  - tpl/x\n";
  const { index, entry, messages } = makeIndex(units, "/p/units/y.yaml");
  assert.deepEqual(messages, []);
  const [plain, tpl] = entry.units[0].references;
  const target = resolve(index, plain).definitions[0];
  assert.equal(target.file, "/q/units/other.pxu");
  assert.equal(OTHER.slice(target.start, target.end), "plain");
  assert.equal(resolve(index, tpl).templates[0].unit.id, "ns::tpl/{name}");
});

test("Jinja placeholders in templates are not checked", () => {
  const { messages } = makeIndex(`
unit: template
template-resource: res
template-engine: jinja2
id: t/{{ name }}
plugin: shell
depends: {% if x %}nothing{% endif %}
`);
  assert.deepEqual(messages, []);
});

test("hover shows the summary of referenced units", () => {
  const { index, entry } = makeIndex(`
id: hovered
plugin: shell
requires: res.x == "1" and sibling.y == "2"
depends: plain job-with-sibling
`);
  const hover = (text: string) =>
    hoverMarkdown(index, entry.units[0].references.find((r) => r.text === text)!);
  assert.equal(hover("res"), "`ns::res`\n\nCollect \\*resources\\*");
  assert.equal(hover("sibling"), "`ns::sibling`\n\nSibling");
  assert.equal(hover("job-with-sibling"), "`ns::job-with-sibling`\n\nParent");
  assert.equal(hover("plain"), "`ns::plain`\n\n*No summary*");
});

test("imports namespaces resolve to provider declarations", () => {
  const p = 'setup(name="ns:p")';
  const q = 'setup(name="other:q", namespace="ns")';
  const { index, entry } = makeIndex("id: j\nplugin: shell\nimports: from ns import res as r\n");
  const [ref] = entry.units[0].namespaceRefs;
  assert.equal(ref.namespace, "ns");
  assert.equal(entry.text.slice(ref.start, ref.end), "ns");
  const declarations = index.namespaceDeclarations("ns").map((d) => {
    const text = d.file === "/p/manage.py" ? p : q;
    return `${d.file}:${text.slice(d.start - 6, d.end)}`;
  });
  assert.deepEqual(declarations.sort(), ['/p/manage.py:name="ns', '/q/manage.py:pace="ns']);
});

test("manifest attributes resolve to manifest entries by resource key", () => {
  const units = `
id: j
plugin: shell
imports: from com.canonical.plainbox import manifest
requires: manifest.has_x == 'True' and manifest.custom == 'True' and manifest.has_{name} == 'True'

unit: manifest entry
id: has_x

unit: manifest entry
id: other
resource-key: custom
`;
  const { index, entry } = makeIndex(units);
  const targets = entry.units[0].manifestRefs.map((ref) => {
    const [target] = index.manifestEntries(ref.key);
    return `${units.slice(ref.start, ref.end)} -> ${units.slice(target.start, target.end)}`;
  });
  assert.deepEqual(targets, ["has_x -> has_x", "custom -> other", "has_{name} -> has_x"]);
});

test("completion context in test plan include and nested_part", () => {
  const context = (text: string, file = "/p/units/tp.pxu") => {
    const offset = text.indexOf("|");
    const source = text.replace("|", "");
    const { entry } = makeIndex(source, file);
    const unit = [...entry.units].reverse().find((u) => u.start <= offset);
    const found = completionContext(source, offset, unit);
    return found && `${found.field}:${found.prefix}`;
  };
  const plan = "unit: test plan\nid: tp\n";
  assert.equal(context(`${plan}include: pl|`), "include:pl");
  assert.equal(context(`${plan}include:\n  plain\n  ns::pl|\n`), "include:ns::pl");
  assert.equal(context(`${plan}include:\n  plain certification_status=bl|`), undefined);
  assert.equal(context(`${plan}nested_part: a b|`), "nested_part:b");
  assert.equal(context(`${plan}bootstrap_include:\n  res pl|`), "bootstrap_include:pl");
  assert.equal(context(`${plan}exclude: pl|`), "exclude:pl");
  assert.equal(context(`${plan}mandatory_include: pl|`), undefined);
  assert.equal(context("id: j\ninclude: pl|"), undefined);
  assert.equal(context(`${plan}include:\n  - pl|\n`, "/p/units/tp.yaml"), "include:pl");
});

test("completion candidates by field", () => {
  const { index } = makeIndex("unit: test plan\nid: tp\n\nid: manual-job\nplugin: manual\n");
  const labels = (field: "include" | "bootstrap_include" | "nested_part", prefix = "") =>
    completionCandidates(index, { field, prefix, start: 0 }, "ns")
      .map((c) => `${c.kind}:${c.label}`)
      .sort();
  assert.deepEqual(labels("nested_part"), ["test plan:tp"]);
  const include = labels("include");
  for (const expected of ["job:plain", "job:res", "job:sibling", "template:tpl/name", "template:after-suspend-tpl/name"]) {
    assert.ok(include.includes(expected), expected);
  }
  assert.ok(!include.some((label) => label.endsWith(":cat") || label.endsWith(":tp")));
  assert.ok(labels("include", "ns::").includes("job:ns::plain"));
  const bootstrap = labels("bootstrap_include");
  assert.ok(bootstrap.includes("job:res") && bootstrap.includes("job:plain"));
  assert.ok(include.includes("job:manual-job") && !bootstrap.includes("job:manual-job"));
  assert.ok(!bootstrap.some((label) => label.startsWith("template:") || label.endsWith(":tp")));
});

test("find all references from a definition or a reference", () => {
  const units = `
unit: test plan
id: tp
include:
  plain
  pl.*
  tpl/name
nested_part: tp

id: j
plugin: shell
depends: plain
`;
  const { index, entry } = makeIndex(units);
  const other = index.files.get("/q/units/other.pxu")!;
  const found = (from: typeof entry, text: string, offset: number, declaration = false) => {
    const targets = targetsAt(index, from, offset)!;
    return findReferences(index, targets, declaration)
      .map((s) => `${s.file === entry.file ? "a" : "other"}:${index.files.get(s.file)!.text.slice(s.start, s.end)}`)
      .sort();
  };
  // On the id of the definition
  const plainAt = OTHER.indexOf("id: plain") + 4;
  assert.deepEqual(found(other, OTHER, plainAt), ["a:pl.*", "a:plain", "a:plain"]);
  assert.deepEqual(found(other, OTHER, plainAt, true), ["a:pl.*", "a:plain", "a:plain", "other:plain"]);
  // On a reference: same targets
  assert.deepEqual(found(entry, units, units.indexOf("depends: plain") + 10), ["a:pl.*", "a:plain", "a:plain"]);
  // Templates: by template-id and by matching pattern
  assert.deepEqual(found(other, OTHER, OTHER.indexOf("id: tpl/") + 4), ["a:tpl/name"]);
  assert.deepEqual(found(entry, units, units.indexOf("id: tp\n") + 4), ["a:tp"]);
  assert.equal(targetsAt(index, entry, units.indexOf("include:")), undefined);
});

test("exclude completion lists units included by the plan and its nested parts", () => {
  const units = `
unit: test plan
id: tp
include:
  plain
  tpl/name
  job-with.*
nested_part: tp2
exclude: |

unit: test plan
id: tp2
include: res
nested_part: tp
`;
  const { index, entry } = makeIndex(units);
  const plan = entry.units[0];
  const labels = completionCandidates(index, { field: "exclude", prefix: "", start: 0 }, "ns", plan)
    .map((c) => `${c.kind}:${c.label}`)
    .sort();
  assert.deepEqual(labels, ["job:job-with-sibling", "job:plain", "job:res", "template:tpl/name"]);
});
