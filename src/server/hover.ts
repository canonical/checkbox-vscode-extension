/**
 * Hover text for unit references: the id and summary of each target.
 */

import { WorkspaceIndex } from "./index";
import { Reference } from "./references";
import { resolve } from "./resolve";

/** Regex include patterns can match many units; list at most this many. */
const MAX_TARGETS = 10;

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, "\\$&");
}

/** Markdown describing the units a reference points to, if any. */
export function hoverMarkdown(index: WorkspaceIndex, ref: Reference): string | undefined {
  const { definitions, templates } = resolve(index, ref);
  const entries = new Map<string, string | undefined>();
  for (const def of definitions) {
    if (!entries.has(def.id)) {
      entries.set(def.id, def.summary);
    }
  }
  for (const tpl of templates) {
    const id = tpl.unit.templateId ?? tpl.unit.id;
    if (id && !entries.has(id)) {
      entries.set(id, tpl.unit.summary);
    }
  }
  if (entries.size === 0) {
    return undefined;
  }
  const blocks = [...entries].slice(0, MAX_TARGETS).map(([id, summary]) => {
    const text = summary ? escapeMarkdown(summary) : "*No summary*";
    return `\`${id}\`\n\n${text}`;
  });
  if (entries.size > MAX_TARGETS) {
    blocks.push(`*…and ${entries.size - MAX_TARGETS} more*`);
  }
  return blocks.join("\n\n---\n\n");
}
