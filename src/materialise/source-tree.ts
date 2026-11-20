import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { ResolvedPersona, ResolvedSource } from '../compose/resolve.js';
import { DEFAULT_TARGET } from '../core/constants.js';

/**
 * Join rule bodies into the persona body, in canonical order. The rule body
 * itself is never re-wrapped or re-indented.
 */
export function personaBody(persona: ResolvedPersona): string {
  const sections = persona.rules.map((rule) => {
    // Boundary newlines belong to the file layout, not the rule text; the
    // text between them is never re-wrapped or re-indented.
    const body = rule.body.replace(/^\n+/, '').replace(/\n+$/, '');
    return `## ${rule.displayName}\n\n${body}`;
  });
  return `${sections.join('\n\n')}\n`;
}

export type PersonaFrontmatter = {
  name: string;
  targets: string[];
  description: string;
  claudecode?: { model: string };
};

export function personaFrontmatter(persona: ResolvedPersona): PersonaFrontmatter {
  return {
    name: persona.id,
    targets: [DEFAULT_TARGET],
    description: persona.purpose,
    ...(persona.model === undefined ? {} : { claudecode: { model: persona.model } }),
  };
}

export function personaSourceFile(persona: ResolvedPersona): string {
  const frontmatter = stringify(personaFrontmatter(persona), { lineWidth: 0 });
  return `---\n${frontmatter}---\n\n${personaBody(persona)}`;
}

/**
 * Write the rulesync-shaped source tree into the stage. One directory per
 * target is not needed here: the stage is already target-scoped.
 */
export async function materialiseSourceTree(
  sourceRoot: string,
  source: ResolvedSource,
): Promise<void> {
  const subagents = join(sourceRoot, 'subagents');
  await mkdir(subagents, { recursive: true });
  for (const persona of source.personas) {
    await writeFile(join(subagents, `${persona.id}.md`), personaSourceFile(persona), 'utf8');
  }
}
