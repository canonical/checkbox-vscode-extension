import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { keyCandidates, keyCompletionContext } from "../src/server/completion";
import { resourceKeyMarkdown } from "../src/server/hover";
import { WorkspaceIndex } from "../src/server/index";
import { resourceKeys, resourcePythonScripts, scriptAnalysis } from "../src/server/resourceKeys";
import { shellOutput } from "../src/server/shellOutput";
import { fileDiagnostics } from "../src/server/workspace";

const HELPER = path.join(__dirname, "..", "..", "scripts", "resource_keys.py");

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const skipWithoutPython = !hasPython() && process.env.REQUIRE_PARITY !== "1" ? "python3 not found" : false;

function output(command: string) {
  const result = shellOutput([{ text: command, offset: 0 }]);
  return {
    keys: result.keys.map((k) => command.slice(k.start, k.end)),
    commands: result.commands.map((c) => `${c.name}[${c.keys.map((k) => k.name).join(",")}]`),
    complete: result.complete,
  };
}

test("keys printed by shell commands", () => {
  assert.deepEqual(output(`echo "name: x"; printf 'size: %s\\nmodel: %s\\n' 1 2`), {
    keys: ["name", "size", "model"],
    commands: [],
    complete: true,
  });
  assert.deepEqual(output("cat <<EOF\nstate: $s\n\nstate: other\nEOF"), {
    keys: ["state", "state"],
    commands: [],
    complete: true,
  });
  // Output that is discarded or piped prints nothing
  assert.deepEqual(output(`if grep -q x /f && probe > /dev/null; then echo "ok: yes"; fi`), {
    keys: ["ok"],
    commands: [],
    complete: true,
  });
  assert.deepEqual(output(`lsblk | awk '{print "disk: " $1}'`), {
    keys: [],
    commands: ["awk[disk]"],
    complete: true,
  });
  assert.deepEqual(output("resource_wrapper.sh -- FOO=1 my_resource.py --all"), {
    keys: [],
    commands: ["my_resource.py[]"],
    complete: true,
  });
  // A key only known at runtime
  assert.equal(output(`echo "$name: 1"`).complete, false);
  assert.equal(output(`echo "path: $p"`).complete, true);
});

test("the Python helper finds printed keys without running scripts", { skip: skipWithoutPython }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-"));
  after(() => fs.rmSync(dir, { recursive: true }));
  const script = path.join(dir, "res.py");
  fs.writeFileSync(
    script,
    [
      "import sys",
      "FIELDS = ('vendor', 'product')",
      "def main():",
      "    print('name: {}'.format(sys.argv[0]))",
      "    for field in FIELDS:",
      "        print(f'{field}: x')",
      "    sys.stdout.write('é_size: %d\\n' % 1)",
      "main()",
      "",
    ].join("\n"),
  );
  const dynamic = path.join(dir, "dyn.py");
  fs.writeFileSync(dynamic, "import os\nfor k, v in os.environ.items():\n    print(f'{k}: {v}')\n");
  const result = JSON.parse(
    execFileSync("python3", [HELPER], { input: JSON.stringify([script, dynamic]) }).toString(),
  );
  const text = fs.readFileSync(script, "utf8");
  const analysis = scriptAnalysis(text, result[script]);
  assert.deepEqual(
    analysis.keys.map((k) => text.slice(k.start, k.end)),
    ["name", "vendor", "product", "é_size"],
  );
  assert.equal(analysis.complete, true);
  assert.equal(result[dynamic].complete, false);
});

function provider(units: string, bin: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-provider-"));
  fs.mkdirSync(path.join(root, "units"));
  fs.mkdirSync(path.join(root, "bin"));
  for (const [name, text] of Object.entries(bin)) {
    fs.writeFileSync(path.join(root, "bin", name), text);
  }
  const index = new WorkspaceIndex();
  index.setProvider(path.join(root, "manage.py"), 'setup(name="ns:p")');
  const file = path.join(root, "units", "a.pxu");
  const entry = index.updateFile(file, units);
  after(() => fs.rmSync(root, { recursive: true }));
  return { root, index, entry, file };
}

const UNITS = `
id: inline
plugin: resource
command: echo "state: ok"

id: scripted
plugin: resource
command: resource_wrapper.sh scripted.sh

id: python
plugin: resource
command: python_res.py

id: unknown
plugin: resource
command: udevadm info --export-db

id: j
plugin: shell
command: true
requires:
 inline.state == "ok" and inline.stat == "ok"
 scripted.vendor == "x" and scripted.typo == "y"
 python.name == "x" and python.missing == "y"
 unknown.anything == "z"

unit: template
template-resource: scripted
id: t/{vendor}
plugin: shell
command: run {model} {{literal}} \${{VAR}}
`;

const BIN = {
  "scripted.sh": '#!/bin/bash\nfor d in /sys/x/*; do\n  echo "vendor: $d"\n  echo "model: 1"\ndone\n',
  "python_res.py": "#!/usr/bin/env python3\nprint('name: x')\n",
};

test("unknown keys of resources with a known output are flagged", () => {
  const { index, entry, file } = provider(UNITS, BIN);
  const messages = () =>
    fileDiagnostics(index, entry)
      .filter((d) => d.message.includes("never prints"))
      .map((d) => `${entry.text.slice(d.start, d.end)}: ${d.message}`);
  // Python script not analysed yet: its keys are unknown
  assert.deepEqual(messages(), [
    "stat: Resource ns::inline never prints key 'stat'",
    "typo: Resource ns::scripted never prints key 'typo'",
  ]);
  const script = path.join(path.dirname(path.dirname(file)), "bin", "python_res.py");
  assert.deepEqual([...resourcePythonScripts(index)], [script]);
  index.setScript(script, { keys: [{ name: "name", start: 0, end: 0 }], complete: true });
  assert.deepEqual(messages().slice(-1), ["missing: Resource ns::python never prints key 'missing'"]);
});

test("resource key completion, hover and definition", () => {
  const { index, entry, root } = provider(UNITS, BIN);
  const text = entry.text;
  const unit = (offset: number) => [...entry.units].reverse().find((u) => u.start <= offset);
  const complete = (marker: string) => {
    const offset = text.indexOf(marker) + marker.length;
    const context = keyCompletionContext(text, offset, unit(offset));
    return context && keyCandidates(index, context).map((c) => `${c.label}${c.printed ? "" : "?"}`);
  };
  // Usage-only keys are typos when the output is fully known
  assert.deepEqual(complete(" and scripted."), ["vendor", "model"]);
  assert.deepEqual(complete("run {"), ["vendor", "model"]);
  assert.deepEqual(complete(" unknown."), ["anything?"]);
  assert.equal(complete("{{"), undefined);
  assert.equal(complete("${"), undefined);

  const keys = resourceKeys(index, "ns::scripted");
  assert.equal(keys.complete, true);
  const [source] = keys.keys.get("model")!;
  assert.deepEqual(
    [source.kind, source.file, fs.readFileSync(source.file, "utf8").slice(source.start, source.end)],
    ["script", path.join(root, "bin", "scripted.sh"), "model"],
  );
  assert.equal(resourceKeys(index, "ns::unknown").complete, false);

  const job = entry.units.find((u) => u.id === "ns::j")!;
  const attr = (key: string) => job.resourceAttrs.find((a) => a.key === key)!;
  assert.match(resourceKeyMarkdown(index, attr("vendor")), /Printed by `scripted\.sh`/);
  assert.match(resourceKeyMarkdown(index, attr("typo")), /Never printed/);
  assert.match(resourceKeyMarkdown(index, attr("anything")), /only partly known/);
});
