# vscode-checkbox — Agent Instructions

This repository is a VS Code extension (TypeScript) with a language server for
[Checkbox](https://github.com/canonical/checkbox) unit files. The server
provides go to definition, hover, completion and diagnostics for unit
references.

## Layout

- `src/client/extension.ts` starts the language client.
- `src/server/server.ts` connects the LSP handlers: document sync, watched
  files, diagnostics, definition, hover and completion.
- `src/server/namespace.ts` finds where each provider declares its namespace,
  which go to definition on `imports` namespaces uses.
- `WorkspaceIndex.manifestEntries` finds `manifest entry` units by resource
  key, for go to definition on `manifest.<key>` in resource expressions.
- `src/server/completion.ts` finds the test plan field at the cursor from the
  text (the line being typed may not parse yet) and lists candidate ids.
- `src/server/hover.ts` builds the hover text (id and summary of each target).
- `src/server/parsers/{pxu,yaml}.ts` parse unit records and keep the document
  offset of every field.
- `src/server/syntax.ts` holds tokenizers that mirror `plainbox.impl.xparsers`,
  `xscanners` and `resource`.
- `src/server/references.ts` extracts unit identity, generated ids and
  references. Its `FIELD_CLASSES` table classifies every plainbox field.
- `src/server/index.ts` is the workspace index, and `resolve.ts` resolves
  references and applies constraints.
- `scripts/dump_units.py` is the plainbox oracle used by the parity test.

## Commands

```bash
npm ci
npm run lint   # type-check
npm test       # compile, then run node:test suites in out/test
# Repository and parity tests use the Checkbox checkout in $CHECKBOX_REPO
# (default ../checkbox)
CHECKBOX_PYTHON=../checkbox/checkbox-ng/venv/bin/python REQUIRE_PARITY=1 npm test
```

## Rules

- plainbox is the source of truth. Each mirrored function names the plainbox
  function it mirrors. When you change semantics, also update
  `scripts/dump_units.py` if needed, and keep `test/parity.test.ts` green.
- When plainbox gains a unit field, classify it in `FIELD_CLASSES`. The
  parity test fails until you do.
- Avoid false positives. When resolution is unsure, especially for
  templates, do not report.
- Do not add runtime dependencies without need. The tests use `node:test`.
- Format `scripts/dump_units.py` with `black --line-length 79`.
