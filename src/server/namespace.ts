/**
 * Provider namespaces, mirroring plainbox.impl.secure.providers.v1.Provider1:
 * the namespace is the "namespace" argument of setup() in manage.py, or the
 * part of the provider name before ":" when it is missing.
 */

import * as fs from "fs";
import * as path from "path";

export const PLAINBOX_NAMESPACE = "com.canonical.plainbox";

/** Directories (relative to the provider root) whose files are units. */
export const UNIT_DIRS = ["units", "jobs"];

/** File extensions plainbox loads as PXU or YAML units. */
export function unitFormat(file: string): "pxu" | "yaml" | undefined {
  if (/\.(pxu|txt|in)$/.test(file)) {
    return "pxu";
  }
  if (/\.ya?ml$/.test(file)) {
    return "yaml";
  }
  return undefined;
}

/** A string value in a Python file and its document offset. */
function stringArg(text: string, pattern: string, from = 0): { value: string; offset: number } | undefined {
  const m = new RegExp(`${pattern}\\s*=\\s*(["'])([^"']+)\\1`).exec(text.slice(from));
  return m ? { value: m[2], offset: from + m.index + m[0].length - m[2].length - 1 } : undefined;
}

function setupKwarg(text: string, name: string) {
  const setup = text.search(/\bsetup\s*\(/);
  return stringArg(text, `\\b${name}`, Math.max(setup, 0));
}

/** Where a provider namespace is written. */
export interface NamespaceDeclaration {
  namespace: string;
  file: string;
  start: number;
  end: number;
}

export function namespaceDeclaration(
  managePy: string,
  text: string,
): NamespaceDeclaration | undefined {
  const root = path.dirname(managePy);
  const parts = root.split(path.sep);
  if (parts.slice(-4, -1).join("/") === "plainbox/impl/providers") {
    // Built-in plainbox providers define themselves in providers/special.py
    const special = path.join(path.dirname(root), "special.py");
    let found: { value: string; offset: number } | undefined;
    try {
      const name = `${PLAINBOX_NAMESPACE}:${path.basename(root)}`;
      const at = fs.readFileSync(special, "utf8").indexOf(`"${name}"`);
      found = at === -1 ? undefined : { value: name, offset: at + 1 };
    } catch {
      found = undefined;
    }
    return found
      ? { namespace: PLAINBOX_NAMESPACE, file: special, start: found.offset, end: found.offset + PLAINBOX_NAMESPACE.length }
      : { namespace: PLAINBOX_NAMESPACE, file: managePy, start: 0, end: 0 };
  }
  const namespace = setupKwarg(text, "namespace");
  if (namespace) {
    return { namespace: namespace.value, file: managePy, start: namespace.offset, end: namespace.offset + namespace.value.length };
  }
  const name = setupKwarg(text, "name");
  if (!name) {
    return undefined;
  }
  const value = name.value.split(":", 1)[0];
  return { namespace: value, file: managePy, start: name.offset, end: name.offset + value.length };
}


/** Mirrors Unit.qualify_id. */
export function qualify(id: string, namespace: string): string {
  return id.includes("::") ? id : `${namespace}::${id}`;
}

/** Namespace part of a qualified id. */
export function namespaceOf(id: string): string | undefined {
  const index = id.indexOf("::");
  return index === -1 ? undefined : id.slice(0, index);
}

export interface Provider {
  root: string;
  namespace: string;
  declaration: NamespaceDeclaration;
}

/**
 * The provider owning a unit file: the closest provider whose units/ or
 * jobs/ directory contains the file.
 */
export function providerFor(
  file: string,
  providers: Provider[],
): Provider | undefined {
  let best: Provider | undefined;
  for (const provider of providers) {
    const inside = UNIT_DIRS.some((dir) =>
      file.startsWith(path.join(provider.root, dir) + path.sep),
    );
    if (inside && (!best || provider.root.length > best.root.length)) {
      best = provider;
    }
  }
  return best;
}
