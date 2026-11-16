import * as fs from "node:fs";
import * as path from "node:path";

/** Checkbox checkout to test against: $CHECKBOX_REPO or ../checkbox. */
export const CHECKBOX_REPO = path.resolve(
  process.env.CHECKBOX_REPO ?? path.join(__dirname, "..", "..", "..", "checkbox"),
);

const available = fs.existsSync(path.join(CHECKBOX_REPO, "providers", "base", "manage.py"));

/** node:test skip value; missing checkout fails when REQUIRE_PARITY=1. */
export const skipWithoutRepo =
  !available && process.env.REQUIRE_PARITY !== "1"
    ? `no Checkbox checkout at ${CHECKBOX_REPO} (set CHECKBOX_REPO)`
    : false;
