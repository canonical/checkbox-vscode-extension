import * as assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceIndex } from "../src/server/index";
import { hoverMarkdown } from "../src/server/hover";
import { resolve } from "../src/server/resolve";
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
