/**
 * Language server: indexes Checkbox providers in the workspace and serves
 * diagnostics for unit references and go to definition.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
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
import { completionCandidates, completionContext } from "./completion";
import { hoverMarkdown } from "./hover";
import { findManifestReferences, findReferences, manifestKeysAt, targetsAt } from "./usages";
import { WorkspaceIndex } from "./index";
import { unitFormat } from "./namespace";
import { resolve } from "./resolve";
import { fileDiagnostics, indexRoots, isManagePy } from "./workspace";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let index = new WorkspaceIndex();
let roots: string[] = [];
let ready = false;

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

async function reindex() {
  let config: { additionalProviderPaths?: string[] } | undefined;
  try {
    config = await connection.workspace.getConfiguration("checkbox");
  } catch {
    config = undefined;
  }
  const extra = (config?.additionalProviderPaths ?? []).map((p) =>
    path.resolve(roots[0] ?? process.cwd(), p),
  );
  index = new WorkspaceIndex();
  indexRoots(index, [...roots, ...extra]);
  for (const doc of documents.all()) {
    const file = toPath(doc.uri);
    if (file && index.isUnitFile(file)) {
      index.updateFile(file, doc.getText());
    }
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
      completionProvider: {},
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
  return refs.length > 0 || namespace || manifest ? { doc, refs, namespace, manifest } : undefined;
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

connection.onDefinition(({ textDocument, position }) => {
  const found = referenceAt(textDocument.uri, position);
  if (found?.namespace) {
    return toLocations(index.namespaceDeclarations(found.namespace.namespace));
  }
  if (found?.manifest) {
    return toLocations(index.manifestEntries(found.manifest.key));
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
