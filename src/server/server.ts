/**
 * Language server: indexes Checkbox providers in the workspace and serves
 * diagnostics for unit references and go to definition.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  FileChangeType,
  Location,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
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
  const entry = index.files.get(file);
  return entry ? TextDocument.create(uri, "", 0, entry.text) : undefined;
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

connection.onDefinition(({ textDocument, position }) => {
  const doc = documents.get(textDocument.uri);
  const file = toPath(textDocument.uri);
  const entry = file ? index.files.get(file) : undefined;
  if (!doc || !entry) {
    return null;
  }
  const offset = doc.offsetAt(position);
  const unit = entry.units.find((u) => u.start <= offset && offset <= u.end);
  const ref = unit?.references.find((r) => r.start <= offset && offset <= r.end);
  if (!ref) {
    return null;
  }
  const { definitions, templates } = resolve(index, ref);
  const targets = [
    ...definitions.map((d) => ({ file: d.file, start: d.start, end: d.end })),
    ...templates.map((t) => ({ file: t.file, start: t.unit.idStart, end: t.unit.idEnd })),
  ];
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
});

documents.listen(connection);
connection.listen();
