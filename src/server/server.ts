/**
 * Language server: indexes Checkbox providers in the workspace and serves
 * diagnostics for unit references and go to definition.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  CodeAction,
  CodeActionKind,
  CompletionItem,
  CompletionItemKind,
  createConnection,
  Hover,
  Diagnostic,
  DiagnosticSeverity,
  FileChangeType,
  Location,
  MarkupKind,
  Position,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { completionCandidates, completionContext, keyCandidates, keyCompletionContext } from "./completion";
import { environFixes, undeclaredMessage } from "./environ";
import { hoverMarkdown, resourceKeyMarkdown } from "./hover";
import { findManifestReferences, findReferences, manifestKeysAt, targetsAt } from "./usages";
import { WorkspaceIndex } from "./index";
import { unitFormat } from "./namespace";
import { resolve } from "./resolve";
import { RawScriptAnalysis, resourceKeys, resourcePythonScripts, scriptAnalysis } from "./resourceKeys";
import { fileDiagnostics, indexRoots, isManagePy } from "./workspace";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let index = new WorkspaceIndex();
let roots: string[] = [];
let ready = false;
let pythonPath = "python3";

const HELPER = path.join(__dirname, "..", "..", "..", "scripts", "resource_keys.py");
const HELPER_TIMEOUT_MS = 120_000;
/** Scripts given to the helper (not retried until they change). */
let attempted = new Set<string>();

function toPath(uri: string): string | undefined {
  return uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
}

/** Text of a file, preferring the open editor buffer. */
function textDocumentFor(file: string): TextDocument | undefined {
  const uri = pathToFileURL(file).href;
  const open = documents.all().find((doc) => toPath(doc.uri) === file);
  if (open) {
    return open;
  }
  const text = index.files.get(file)?.text ?? readFile(file);
  return text === undefined ? undefined : TextDocument.create(uri, "", 0, text);
}

function readFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Runs scripts/resource_keys.py on the given Python scripts. */
function runHelper(files: string[]): Promise<Record<string, RawScriptAnalysis>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonPath, [HELPER], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), HELPER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`exit code ${code}: ${Buffer.concat(err).toString().trim()}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(out).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(files));
  });
}

/** Analyses the Python scripts of resource jobs not analysed yet. */
async function analyseScripts() {
  const target = index;
  const files = [...resourcePythonScripts(target)].filter((f) => !target.scriptKeys.has(f) && !attempted.has(f));
  if (files.length === 0) {
    return;
  }
  files.forEach((f) => attempted.add(f));
  let results: Record<string, RawScriptAnalysis>;
  try {
    results = await runHelper(files);
  } catch (error) {
    connection.console.warn(`Resource key analysis failed (${pythonPath} ${HELPER}): ${error}`);
    return;
  }
  for (const [file, raw] of Object.entries(results)) {
    const text = readFile(file);
    if (text !== undefined) {
      target.setScript(file, scriptAnalysis(text, raw));
    }
  }
  if (target === index) {
    schedulePublish();
  }
}

async function reindex() {
  let config: { additionalProviderPaths?: string[]; pythonPath?: string } | undefined;
  try {
    config = await connection.workspace.getConfiguration("checkbox");
  } catch {
    config = undefined;
  }
  const extra = (config?.additionalProviderPaths ?? []).map((p) =>
    path.resolve(roots[0] ?? process.cwd(), p),
  );
  const previous = index;
  index = new WorkspaceIndex();
  indexRoots(index, [...roots, ...extra]);
  for (const [file, analysis] of previous.scriptKeys) {
    index.setScript(file, analysis);
  }
  for (const doc of documents.all()) {
    const file = toPath(doc.uri);
    if (file && index.isUnitFile(file)) {
      index.updateFile(file, doc.getText());
    }
  }
  const python = config?.pythonPath || "python3";
  if (python !== pythonPath) {
    pythonPath = python;
    attempted = new Set();
  }
  ready = true;
  schedulePublish();
}

let publishTimer: NodeJS.Timeout | undefined;

function schedulePublish() {
  if (publishTimer) {
    clearTimeout(publishTimer);
  }
  publishTimer = setTimeout(publishAll, 200);
}

const SEVERITY = { error: DiagnosticSeverity.Error, warning: DiagnosticSeverity.Warning };

function publishAll() {
  if (!ready) {
    return;
  }
  // New resource jobs may run scripts not analysed yet
  void analyseScripts();
  for (const doc of documents.all()) {
    const file = toPath(doc.uri);
    const entry = file ? index.files.get(file) : undefined;
    const diagnostics: Diagnostic[] = entry
      ? fileDiagnostics(index, entry).map((d) => ({
          range: { start: doc.positionAt(d.start), end: doc.positionAt(d.end) },
          message: d.message,
          severity: SEVERITY[d.severity],
          source: "checkbox",
        }))
      : [];
    connection.sendDiagnostics({ uri: doc.uri, diagnostics });
  }
}

connection.onInitialize((params) => {
  roots = (params.workspaceFolders ?? [])
    .map((folder) => toPath(folder.uri))
    .filter((root): root is string => root !== undefined);
  if (roots.length === 0 && params.rootUri) {
    const root = toPath(params.rootUri);
    if (root) {
      roots.push(root);
    }
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
      hoverProvider: true,
      referencesProvider: true,
      completionProvider: { triggerCharacters: [".", "{"] },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
    },
  };
});

connection.onInitialized(() => {
  void reindex();
});

connection.onDidChangeConfiguration(() => {
  void reindex();
});

documents.onDidChangeContent(({ document }) => {
  const file = toPath(document.uri);
  if (ready && file && index.isUnitFile(file)) {
    index.updateFile(file, document.getText());
  }
  schedulePublish();
});

documents.onDidClose(({ document }) => {
  const file = toPath(document.uri);
  if (file && index.isUnitFile(file)) {
    // Drop unsaved changes
    if (fs.existsSync(file)) {
      index.updateFile(file, fs.readFileSync(file, "utf8"));
    } else {
      index.removeFile(file);
    }
  }
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  schedulePublish();
});

connection.onDidChangeWatchedFiles(({ changes }) => {
  if (!ready) {
    return;
  }
  for (const change of changes) {
    const file = toPath(change.uri);
    if (!file) {
      continue;
    }
    const deleted = change.type === FileChangeType.Deleted || !fs.existsSync(file);
    if (isManagePy(file)) {
      if (deleted) {
        index.removeProvider(file);
      } else {
        index.setProvider(file, fs.readFileSync(file, "utf8"));
      }
    } else if (index.binDirs(file).some((dir) => file.startsWith(dir + path.sep))) {
      index.setScript(file, undefined);
      attempted.delete(file);
    } else if (unitFormat(file) && !documents.get(change.uri)) {
      if (deleted) {
        index.removeFile(file);
      } else if (index.isUnitFile(file)) {
        index.updateFile(file, fs.readFileSync(file, "utf8"));
      }
    }
  }
  schedulePublish();
});

/** The unit reference under the cursor, if any. */
function referenceAt(uri: string, position: Position) {
  const doc = documents.get(uri);
  const file = toPath(uri);
  const entry = file ? index.files.get(file) : undefined;
  if (!doc || !entry) {
    return undefined;
  }
  const offset = doc.offsetAt(position);
  const at = (r: { start: number; end: number }) => r.start <= offset && offset <= r.end;
  // Several units when a parametric template's jobs share its text
  const units = entry.units.filter(at);
  const refs = units.flatMap((u) => u.references.filter(at));
  const namespace = units.flatMap((u) => u.namespaceRefs.filter(at))[0];
  const manifest = units.flatMap((u) => u.manifestRefs.filter(at))[0];
  const attr = units.flatMap((u) => u.resourceAttrs.filter(at))[0];
  return refs.length > 0 || namespace || manifest || attr ? { doc, refs, namespace, manifest, attr } : undefined;
}

function toLocations(targets: { file: string; start: number; end: number }[]): Location[] {
  const seen = new Set<string>();
  const locations: Location[] = [];
  for (const target of targets) {
    const key = `${target.file}:${target.start}`;
    const targetDoc = textDocumentFor(target.file);
    if (seen.has(key) || !targetDoc) {
      continue;
    }
    seen.add(key);
    locations.push({
      uri: pathToFileURL(target.file).href,
      range: { start: targetDoc.positionAt(target.start), end: targetDoc.positionAt(target.end) },
    });
  }
  return locations;
}

connection.onHover(({ textDocument, position }): Hover | null => {
  const found = referenceAt(textDocument.uri, position);
  if (found?.attr) {
    const { doc, attr } = found;
    return {
      contents: { kind: MarkupKind.Markdown, value: resourceKeyMarkdown(index, attr) },
      range: { start: doc.positionAt(attr.start), end: doc.positionAt(attr.end) },
    };
  }
  const ref = found?.refs[0];
  const blocks = new Set((found?.refs ?? []).map((r) => hoverMarkdown(index, r)).filter((m) => m !== undefined));
  const markdown = [...blocks].join("\n\n---\n\n");
  if (!found || !ref || !markdown) {
    return null;
  }
  const { doc } = found;
  return {
    contents: { kind: MarkupKind.Markdown, value: markdown },
    range: { start: doc.positionAt(ref.start), end: doc.positionAt(ref.end) },
  };
});

const COMPLETION_KIND = {
  job: CompletionItemKind.Function,
  template: CompletionItemKind.Class,
  "test plan": CompletionItemKind.Module,
  import: CompletionItemKind.Reference,
};

connection.onCompletion(({ textDocument, position }): CompletionItem[] => {
  const doc = documents.get(textDocument.uri);
  const file = toPath(textDocument.uri);
  const entry = file ? index.files.get(file) : undefined;
  if (!doc || !entry) {
    return [];
  }
  const offset = doc.offsetAt(position);
  // The line being typed may fall just outside the parsed unit
  const unit = [...entry.units].reverse().find((u) => u.start <= offset);
  const keyContext = keyCompletionContext(doc.getText(), offset, unit);
  if (keyContext) {
    const range = { start: doc.positionAt(keyContext.start), end: position };
    return keyCandidates(index, keyContext).map((candidate) => ({
      label: candidate.label,
      kind: CompletionItemKind.Field,
      detail: candidate.printed ? `printed by ${keyContext.resource}` : "used by other units",
      sortText: `${candidate.printed ? 0 : 1}${candidate.label}`,
      textEdit: { range, newText: candidate.label },
    }));
  }
  const context = completionContext(doc.getText(), offset, unit);
  if (!context) {
    return [];
  }
  const range = { start: doc.positionAt(context.start), end: position };
  return completionCandidates(index, context, entry.namespace, unit).map((candidate) => ({
    label: candidate.label,
    kind: COMPLETION_KIND[candidate.kind],
    detail: candidate.summary,
    textEdit: { range, newText: candidate.label },
  }));
});

connection.onReferences(({ textDocument, position, context }) => {
  const doc = documents.get(textDocument.uri);
  const file = toPath(textDocument.uri);
  const entry = file ? index.files.get(file) : undefined;
  if (!doc || !entry) {
    return null;
  }
  const keys = manifestKeysAt(index, entry, doc.offsetAt(position));
  if (keys) {
    return toLocations(findManifestReferences(index, keys, context.includeDeclaration));
  }
  const targets = targetsAt(index, entry, doc.offsetAt(position));
  return targets ? toLocations(findReferences(index, targets, context.includeDeclaration)) : null;
});

connection.onCodeAction(({ textDocument, range, context }): CodeAction[] => {
  const doc = documents.get(textDocument.uri);
  const file = toPath(textDocument.uri);
  const format = file ? unitFormat(file) : undefined;
  if (!doc || !format) {
    return [];
  }
  const fixes = environFixes(doc.getText(), format, doc.offsetAt(range.start), doc.offsetAt(range.end));
  return fixes.map((fix) => ({
    title: fix.title,
    kind: CodeActionKind.QuickFix,
    isPreferred: fix.names.length === 1,
    diagnostics: context.diagnostics.filter((d) =>
      fix.names.some((name) => d.message === undeclaredMessage(name)),
    ),
    edit: {
      changes: {
        [textDocument.uri]: [
          {
            range: { start: doc.positionAt(fix.edit.start), end: doc.positionAt(fix.edit.end) },
            newText: fix.edit.newText,
          },
        ],
      },
    },
  }));
});

connection.onDefinition(({ textDocument, position }) => {
  const found = referenceAt(textDocument.uri, position);
  if (found?.namespace) {
    return toLocations(index.namespaceDeclarations(found.namespace.namespace));
  }
  if (found?.manifest) {
    return toLocations(index.manifestEntries(found.manifest.key));
  }
  if (found?.attr) {
    const sources = resourceKeys(index, found.attr.target).keys.get(found.attr.key) ?? [];
    return toLocations(sources.filter((s) => s.kind !== "usage"));
  }
  if (!found?.refs.length) {
    return null;
  }
  return toLocations(
    found.refs.flatMap((ref) => {
      const { definitions, templates } = resolve(index, ref);
      return [
        ...definitions.map((d) => ({ file: d.file, start: d.start, end: d.end })),
        ...templates.map((t) => ({ file: t.file, start: t.unit.idStart, end: t.unit.idEnd })),
      ];
    }),
  );
});

documents.listen(connection);
connection.listen();
