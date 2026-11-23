import * as assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceIndex } from "../src/server/index";
import { completionCandidates, completionContext } from "../src/server/completion";
import { hoverMarkdown } from "../src/server/hover";
import { resolve } from "../src/server/resolve";
import { findManifestReferences, findReferences, manifestKeysAt, targetsAt } from "../src/server/usages";
import { fileDiagnostics } from "../src/server/workspace";
import { environFixes, undeclaredEnviron } from "../src/server/environ";
import { parsePxu } from "../src/server/parsers/pxu";
import { parseYaml } from "../src/server/parsers/yaml";

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

test("find all references of manifest entries", () => {
  const units = `
id: a
plugin: shell
imports: from com.canonical.plainbox import manifest
requires: manifest.has_x == 'True' and manifest.custom == 'True' and manifest.gone == 'True'

unit: template
template-resource: res
id: t/{name}
plugin: shell
imports: from com.canonical.plainbox import manifest
requires: manifest.has_{name} == 'True'

id: b
plugin: shell
imports: from com.canonical.plainbox import manifest
requires: manifest.has_x == 'True'

unit: manifest entry
id: has_x

unit: manifest entry
id: other
resource-key: custom
`;
  const { index, entry } = makeIndex(units);
  // Offset of the nth occurrence of text, labelled for readable assertions
  const at = (text: string, nth = 0) => {
    let offset = -1;
    for (let i = 0; i <= nth; i++) {
      offset = units.indexOf(text, offset + 1);
    }
    return { offset, label: `${offset}:${text}` };
  };
  const usages = (text: string, nth = 0, includeDeclaration = true) => {
    const keys = manifestKeysAt(index, entry, at(text, nth).offset + 1);
    return keys && findManifestReferences(index, keys, includeDeclaration).map((s) => `${s.start}:${units.slice(s.start, s.end)}`).sort();
  };
  const uses = [at("has_x").label, at("has_{name}").label, at("has_x", 1).label];
  const declaration = at("has_x", 2).label;
  // From a use, from the manifest entry id, and without the declaration
  assert.deepEqual(usages("has_x"), [...uses, declaration].sort());
  assert.deepEqual(usages("has_x", 2), [...uses, declaration].sort());
  assert.deepEqual(usages("has_x", 0, false), uses.sort());
  // resource-key differs from the id
  assert.deepEqual(usages("custom"), [at("custom").label, at("other").label].sort());
  // No manifest entry defines the key: other uses of the same key
  assert.deepEqual(usages("gone"), [at("gone").label]);
  // Not on a manifest key
  assert.equal(usages("plugin"), undefined);
});

test("parametric templates define one job per parameters record", () => {
  const yaml = `
unit: parametric template
template-id: param
id: param_{value}
flags: [simple, also-after-suspend]
_summary: Param {value}
depends: ["{depends}"]
before: [missing]
parameters:
  - value: A
    depends: plain
  - value: B
    depends: param_A
  - value: C
    depends: gone
---
unit: test plan
id: tp
include:
  - param_C
  - after-suspend-param_B
  - param
  - param_D
`;
  const { index, entry, messages } = makeIndex(yaml, "/p/units/a.yaml");
  assert.deepEqual(
    entry.units.map((u) => `${u.kind} ${u.id}`),
    ["parametric template ns::param_{value}", "job ns::param_A", "job ns::param_B", "job ns::param_C", "test plan ns::tp"],
  );
  // Instances point at the template's lines and render summaries
  const [def] = index.definitions("ns::param_B");
  assert.equal(yaml.slice(def.start, def.end), "param_{value}");
  assert.equal(def.summary, "Param B");
  assert.equal(index.definitions("ns::after-suspend-param_C").length, 1);
  // Rendered references resolve; shared lines are reported once
  assert.deepEqual(messages, [
    "missing: unit ns::missing is not available",
    "{depends}: unit ns::gone is not available",
    "param_D: unit ns::param_D is not available",
  ]);
  // Go to definition / find references on the shared depends line
  const offset = yaml.indexOf("{depends}") + 1;
  const targets = targetsAt(index, entry, offset)!;
  assert.deepEqual(targets.definitions.map((d) => d.id).sort(), ["ns::param_A", "ns::plain"]);

  const pxu = `
unit: parametric template
template-id: px
id: px_{n}
plugin: shell
depends: px_{m}
parameters: [{"n": 1, "m": 1}, {"n": 2}]
`;
  const { messages: pxuMessages, entry: pxuEntry } = makeIndex(pxu);
  assert.deepEqual(pxuEntry.units.map((u) => u.id), ["ns::px_{n}", "ns::px_1"]);
  assert.deepEqual(pxuMessages, ["parameters: parameter m is missing in parameters record 2"]);
});

test("environment variables used in command must be declared in environ", () => {
  const { entry, messages } = makeIndex(`
id: env
plugin: shell
environ: OTG, DECLARED
command:
 echo "$OTG $DECLARED \${MISSING:-x} it's $IN_DQ" $(cat "$IN_SUB")
 awk '{ print $1, $SINGLE }' \\$ESCAPED $PLAINBOX_SESSION_SHARE $SNAP_NAME $1 $? \${#ARR[@]}
 # $COMMENT
 IFS= read -r line; for f in *; do echo "$line $f"; done; X=1; echo $X
 cat <<'EOF'
 $QUOTED_DOC
 EOF
 python3 <<EOF
 print('$UNQUOTED_DOC')
 EOF
`);
  assert.deepEqual(messages, [
    "MISSING: Environment variable MISSING is not declared in environ",
    "IN_DQ: Environment variable IN_DQ is not declared in environ",
    "IN_SUB: Environment variable IN_SUB is not declared in environ",
    "ARR: Environment variable ARR is not declared in environ",
    "UNQUOTED_DOC: Environment variable UNQUOTED_DOC is not declared in environ",
  ]);
  assert.ok(entry.units[0].problems.every((p) => p.severity === "warning"));

  const yaml = makeIndex(
    `
unit: parametric template
template-id: p
id: p_{num}
plugin: shell
environ: [A]
command: |
  echo "$A $B {num}"
parameters:
  - num: 1
  - num: 2
`,
    "/p/units/a.yaml",
  );
  assert.deepEqual(yaml.messages, ["B: Environment variable B is not declared in environ"]);
});

test("quick fix declares environment variables in environ", () => {
  const apply = (text: string, format: "pxu" | "yaml", name: string, title = `Declare ${name} in environ`) => {
    const at = text.indexOf(`$${name}`) + 1;
    const fix = environFixes(text, format, at, at).find((f) => f.title === title);
    assert.ok(fix, `no fix "${title}"`);
    const result = text.slice(0, fix.edit.start) + fix.edit.newText + text.slice(fix.edit.end);
    const unit = (format === "pxu" ? parsePxu(result) : parseYaml(result)).units[0];
    assert.deepEqual(undeclaredEnviron(unit), [], result);
    return result;
  };
  // No environ: new field before command, in the command's indentation
  assert.equal(apply("id: a\ncommand: echo $X\n", "pxu", "X"), "id: a\nenviron: X\ncommand: echo $X\n");
  assert.equal(
    apply("id: a\ncommand: |\n  echo $X\n", "yaml", "X"),
    "id: a\nenviron:\n  - X\ncommand: |\n  echo $X\n",
  );
  // Existing values keep their style
  assert.equal(apply("id: a\nenviron: A B\ncommand: echo $X\n", "pxu", "X"), "id: a\nenviron: A B X\ncommand: echo $X\n");
  assert.equal(apply("environ: A, B\ncommand: echo $X\n", "pxu", "X"), "environ: A, B, X\ncommand: echo $X\n");
  assert.equal(apply("environ:\n A\n B\ncommand: echo $X\n", "pxu", "X"), "environ:\n A\n B X\ncommand: echo $X\n");
  assert.equal(apply("environ: [A]\ncommand: echo $X\n", "yaml", "X"), "environ: [A, X]\ncommand: echo $X\n");
  assert.equal(apply("environ: []\ncommand: echo $X\n", "yaml", "X"), "environ: [X]\ncommand: echo $X\n");
  assert.equal(
    apply("environ:\n  - A\ncommand: echo $X\n", "yaml", "X"),
    "environ:\n  - A\n  - X\ncommand: echo $X\n",
  );
  // All at once
  assert.equal(
    apply("id: a\ncommand: echo $X $Y $X\n", "pxu", "Y", "Declare all undeclared variables in environ (X, Y)"),
    "id: a\nenviron: X Y\ncommand: echo $X $Y $X\n",
  );
  // No fix away from a warning
  assert.deepEqual(environFixes("id: a\ncommand: echo $X\n", "pxu", 0, 0), []);
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

test("template-resource completion offers resource jobs and imports", () => {
  const text = `
unit: template
template-imports: from ns import res as alias
template-resource: |
id: t/{x}
plugin: shell

unit: parametric template
template-id: pt
id: pt_{x}
plugin: shell
template-resource: |
parameters: [{"x": 1}]
`;
  const source = text.replaceAll("|", "");
  const { index, entry } = makeIndex(source);
  const contextAt = (offset: number) => {
    const unit = [...entry.units].reverse().find((u) => u.start <= offset);
    return { unit, context: completionContext(source, offset, unit) };
  };
  const first = contextAt(text.indexOf("|"));
  assert.deepEqual(first.context, { field: "template-resource", prefix: "", start: text.indexOf("|") });
  const labels = completionCandidates(index, first.context!, "ns", first.unit).map((c) => `${c.kind}:${c.label}`);
  assert.equal(labels[0], "import:alias");
  assert.ok(labels.includes("job:res") && labels.includes("job:sibling"));
  assert.ok(!labels.includes("job:plain"));
  // Parametric templates cannot have a template-resource
  assert.equal(contextAt(text.lastIndexOf("|") - 1).context, undefined);
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
