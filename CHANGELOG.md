# Changelog

## 0.1.0

First release.

- Go to definition, hover and find all references for unit ids,
  `imports` namespaces and manifest entries.
- Diagnostics for invalid unit references.
- Completion in test plan `include`, `exclude`, `bootstrap_include` and
  `nested_part`, and in template `template-resource`.
- Warning and quick fix for environment variables missing from `environ`.
- Resource keys (`res.key`, template placeholders): completion, hover, go to
  definition and a warning for keys the resource never prints.
