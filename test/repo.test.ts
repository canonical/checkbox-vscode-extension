/**
 * Integration test over the real repository: no errors in the fields that
 * `manage.py validate` checks (it passes in CI), so any error there is a
 * false positive of the language server.
 */

import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { WorkspaceIndex } from "../src/server/index";
import { resolve } from "../src/server/resolve";
import { CHECKBOX_REPO, skipWithoutRepo } from "./checkbox-repo";
import { indexRoots } from "../src/server/workspace";

const ROOT = CHECKBOX_REPO;
// plainbox does not validate these (missing ids are silently ignored)
const UNVALIDATED = new Set(["include", "exclude", "mandatory_include", "nested_part", "category-overrides"]);

test("no false positives on repository providers", { skip: skipWithoutRepo }, () => {
  const index = new WorkspaceIndex();
  indexRoots(index, [ROOT]);
  assert.ok(index.files.size > 500, "repository providers were not indexed");
  const problems: string[] = [];
  for (const entry of index.files.values()) {
    for (const unit of entry.units) {
      for (const ref of unit.references) {
        const problem = resolve(index, ref).problem;
        if (problem && !UNVALIDATED.has(ref.field)) {
          problems.push(`${path.relative(ROOT, entry.file)}: ${ref.field} ${ref.text}: ${problem.message}`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});
