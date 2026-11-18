/**
 * Differential test: the TypeScript extraction must agree with plainbox
 * itself (scripts/dump_units.py) on every unit of every provider in the
 * repository. Skipped when plainbox cannot be imported, unless
 * REQUIRE_PARITY=1 (as in CI).
 */

import * as assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import { WorkspaceIndex } from "../src/server/index";
import { FIELD_CLASSES, UnitInfo } from "../src/server/references";
import { CHECKBOX_REPO, skipWithoutRepo } from "./checkbox-repo";
import { indexRoots, isManagePy, listFiles } from "../src/server/workspace";

const ROOT = CHECKBOX_REPO;
const PYTHON = process.env.CHECKBOX_PYTHON ?? "python3";
const ORACLE = path.join(__dirname, "..", "..", "scripts", "dump_units.py");

interface OracleInclude {
  kind: "fixed" | "pattern" | "error";
  text: string;
  target: string;
}

interface OracleUnit {
  file: string;
  line: number;
  unit: string;
  id: string | null;
  plugin: string | null;
  template_id?: string;
  refs: Record<string, string[] | OracleInclude[] | { error: string }>;
  generated_ids: string[] | { error: string };
}

interface Oracle {
  providers: { manage_py: string; namespace: string; units: OracleUnit[] }[];
  fields: Record<string, string[]>;
}

function hasPlainbox(): boolean {
  return spawnSync(PYTHON, ["-c", "import plainbox"], { stdio: "ignore" }).status === 0;
}

function managePyFiles(): string[] {
  return listFiles(ROOT)
    .filter(isManagePy)
    .map((file) => path.relative(ROOT, file))
    .filter((file) => /^(providers|contrib|checkbox-ng\/plainbox\/impl\/providers|metabox\/metabox\/metabox-provider)\//.test(file));
}

function runOracle(): Oracle {
  const output = execFileSync(PYTHON, [ORACLE, ...managePyFiles()], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    // stderr is attached to the error if the oracle fails
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output) as Oracle;
}

const sorted = (values: Iterable<string>) => [...values].sort();
const unique = (values: Iterable<string>) => sorted(new Set(values));

/** Reference targets the TypeScript side extracted, per field. */
function tsRefs(unit: UnitInfo): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const ref of unit.references) {
    refs.set(ref.field, [...(refs.get(ref.field) ?? []), ref.target]);
  }
  return refs;
}

/** Fields whose plainbox value is a set rather than a list. */
const SET_FIELDS = new Set(["requires", "template-filter", "imports", "template-imports"]);

function compareUnit(where: string, oracle: OracleUnit, unit: UnitInfo): string[] {
  const problems: string[] = [];
  const check = (what: string, expected: unknown, actual: unknown) => {
    try {
      assert.deepStrictEqual(actual, expected);
    } catch {
      problems.push(`${where}: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  check("unit", oracle.unit, unit.kind);
  check("id", oracle.id, unit.id ?? null);
  if (oracle.unit === "job" || oracle.unit === "setup_job") {
    check("plugin", oracle.plugin, unit.plugin ?? null);
  }
  if (oracle.template_id !== undefined) {
    check("template_id", oracle.template_id, unit.templateId);
  }
  const refs = tsRefs(unit);
  for (const [field, value] of Object.entries(oracle.refs)) {
    if (!Array.isArray(value)) {
      continue; // plainbox itself fails on this value
    }
    const actual = refs.get(field) ?? [];
    if (field === "include" || field === "exclude" || field === "mandatory_include") {
      const expected = (value as OracleInclude[]).filter((i) => i.kind !== "error").map((i) => i.target);
      check(field, sorted(expected), sorted(actual));
    } else if (SET_FIELDS.has(field)) {
      check(field, unique(value as string[]), unique(actual));
    } else {
      check(field, sorted(value as string[]), sorted(actual));
    }
  }
  for (const field of refs.keys()) {
    if (!(field in oracle.refs)) {
      problems.push(`${where}: ${field}: unexpected references ${JSON.stringify(refs.get(field))}`);
    }
  }
  if (Array.isArray(oracle.generated_ids) && oracle.unit === "job") {
    check("generated ids", sorted(oracle.generated_ids), sorted(unit.generated.map((g) => g.id)));
  }
  return problems;
}

const skip =
  skipWithoutRepo || (!hasPlainbox() && process.env.REQUIRE_PARITY !== "1" ? "plainbox is not importable" : false);

test("TypeScript extraction matches plainbox", { skip }, () => {
  const oracle = runOracle();
  const index = new WorkspaceIndex(true);
  indexRoots(index, [ROOT]);
  const problems: string[] = [];
  let compared = 0;
  for (const provider of oracle.providers) {
    const byFile = new Map<string, OracleUnit[]>();
    for (const unit of provider.units) {
      byFile.set(unit.file, [...(byFile.get(unit.file) ?? []), unit]);
    }
    for (const [file, units] of byFile) {
      const entry = index.files.get(path.join(ROOT, file));
      if (!entry) {
        problems.push(`${file}: not indexed`);
        continue;
      }
      if (entry.namespace !== provider.namespace) {
        problems.push(`${file}: namespace ${entry.namespace}, expected ${provider.namespace}`);
      }
      if (entry.units.length !== units.length) {
        problems.push(`${file}: ${entry.units.length} units, expected ${units.length}`);
        continue;
      }
      compared += units.length;
      units.forEach((unit, i) => {
        problems.push(...compareUnit(`${file}:${unit.line}`, unit, entry.units[i]));
      });
    }
  }
  assert.ok(compared > 1000, `only ${compared} units compared`);
  assert.deepEqual(problems.slice(0, 50), [], `${problems.length} parity problems`);
});

test("every plainbox unit field is classified", { skip }, () => {
  const oracle = runOracle();
  const unclassified = sorted(
    new Set(Object.values(oracle.fields).flat().filter((field) => !(field in FIELD_CLASSES))),
  );
  assert.deepEqual(unclassified, [], "classify new fields in FIELD_CLASSES (src/server/references.ts)");
});
