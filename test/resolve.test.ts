import * as assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceIndex } from "../src/server/index";
import { resolve } from "../src/server/resolve";
import { fileDiagnostics } from "../src/server/workspace";

const OTHER = `
unit: category
id: cat

id: res
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
siblings: [{"id": "sibling", "plugin": "resource"}]
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
