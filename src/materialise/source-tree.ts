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
  claudecode?: { model?: string; tools?: string[]; disallowedTools?: string[] };
};

/**
 * The renderer source form for the Claude Code per-agent block. `tools` and
 * `disallowedTools` already hold the harness's own tool names (`Agent`, `Bash`,
 * `Edit`, `Read`, `Write`, and `Bash(P)` for a pattern), never a product category.
 */
export function personaFrontmatter(persona: ResolvedPersona): PersonaFrontmatter {
  const claudecode: NonNullable<PersonaFrontmatter['claudecode']> = {};
  if (persona.model !== undefined) {
    claudecode.model = persona.model;
  }
  if (persona.claude.allow.length > 0) {
    claudecode.tools = persona.claude.allow;
  }
  if (persona.claude.deny.length > 0) {
    claudecode.disallowedTools = persona.claude.deny;
  }
  return {
    name: persona.id,
    targets: [DEFAULT_TARGET],
    description: persona.purpose,
    ...(Object.keys(claudecode).length === 0 ? {} : { claudecode }),
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
