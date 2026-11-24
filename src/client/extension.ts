import * as path from "path";
import { ExtensionContext, workspace } from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext) {
  const module = context.asAbsolutePath(path.join("out", "src", "server", "server.js"));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6009"] } },
  };
  const unitDirs = "**/{units,jobs}/**";
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "checkbox-pxu" },
      { scheme: "file", language: "yaml", pattern: `${unitDirs}/*.{yaml,yml}` },
    ],
    synchronize: {
      configurationSection: "checkbox",
      fileEvents: [
        workspace.createFileSystemWatcher("**/{manage.py,*.pxu,*.yaml,*.yml,*.txt,*.in}"),
        // Scripts run by resource jobs
        workspace.createFileSystemWatcher("**/bin/**"),
      ],
    },
  };
  client = new LanguageClient("checkbox", "Checkbox Units", serverOptions, clientOptions);
  await client.start();
}

export async function deactivate() {
  await client?.stop();
}
