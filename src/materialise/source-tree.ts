import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { ResolvedPersona, ResolvedSource } from '../compose/resolve.js';
import { DEFAULT_TARGET } from '../core/constants.js';
import type { RenderTargetName } from '../render/port.js';

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
  // A persona with no rules has an empty body, not a lone newline: `resources`
  // may be empty, and the honest renderer emits no body for it.
  if (sections.length === 0) {
    return '';
  }
  return `${sections.join('\n\n')}\n`;
}

/**
 * Whether this persona's source form carries `tools`. The target reads it as an
 * allow-list, so it is emitted only when a permission resource opted in AND at
 * least one entry survived. `claude.allowlist` is that effective decision (see
 * `mapPermissions`), so it is the one place the question is answered; a bare
 * `read: allow` must not silently remove Glob, Grep, WebFetch and every other
 * tool the product does not model.
 */
export function emitsTools(persona: ResolvedPersona): boolean {
  return persona.claude.allowlist;
}

export type ClaudeBlock = {
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
};

export type PersonaFrontmatter = {
  name: string;
  targets: string[];
  description: string;
} & Partial<Record<RenderTargetName, ClaudeBlock>>;

/**
 * The renderer source form for the Claude Code per-agent block. `tools` and
 * `disallowedTools` already hold the harness's own tool names (`Agent`, `Bash`,
 * `Edit`, `Read`, `Write`, and `Bash(P)` for a pattern), never a product category.
 */
export function personaFrontmatter(persona: ResolvedPersona): PersonaFrontmatter {
  const block: ClaudeBlock = {};
  if (persona.model !== undefined) {
    block.model = persona.model;
  }
  if (emitsTools(persona)) {
    block.tools = persona.claude.allow;
  }
  if (persona.claude.deny.length > 0) {
    block.disallowedTools = persona.claude.deny;
  }
  const frontmatter: PersonaFrontmatter = {
    name: persona.id,
    targets: [DEFAULT_TARGET],
    description: persona.purpose,
  };
  if (Object.keys(block).length > 0) {
    frontmatter[DEFAULT_TARGET] = block;
  }
  return frontmatter;
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
