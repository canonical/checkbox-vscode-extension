/**
 * Provider namespaces, mirroring plainbox.impl.secure.providers.v1.Provider1:
 * the namespace is the "namespace" argument of setup() in manage.py, or the
 * part of the provider name before ":" when it is missing.
 */

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

function setupKwarg(text: string, name: string): string | undefined {
  const setup = text.search(/\bsetup\s*\(/);
  const body = setup === -1 ? text : text.slice(setup);
  const m = new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']+)\\1`).exec(body);
  return m?.[2];
}

export function namespaceFromManagePy(
  managePy: string,
  text: string,
): string | undefined {
  // Built-in plainbox providers define themselves in providers/special.py
  const parts = path.dirname(managePy).split(path.sep);
  if (parts.slice(-4, -1).join("/") === "plainbox/impl/providers") {
    return PLAINBOX_NAMESPACE;
  }
  const namespace = setupKwarg(text, "namespace");
  if (namespace) {
    return namespace;
  }
  return setupKwarg(text, "name")?.split(":", 1)[0];
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
