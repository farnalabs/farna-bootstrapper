import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import type { ResolvedPersona, ResolvedSource } from '../compose/resolve.js';
import {
  COMMANDS_DIR,
  DEFAULT_PERSONA_MODE,
  isOpencodeTarget,
  OPENCODE_V1_TARGET,
  type OpencodeTarget,
  type PersonaMode,
  RULESYNC_HOOKS_FILE,
  RULESYNC_MCP_FILE,
  SKILL_FILE_NAME,
  SKILLS_DIR,
  type SupportedTarget,
} from '../core/constants.js';
import type { RenderFeature } from '../render/port.js';
import type { EnvValueInput } from '../source/schema.js';

/**
 * Join rule bodies into the persona body, in canonical order. The rule body
 * itself is never re-wrapped or re-indented. This is the only place a persona's
 * rules are carried on either target: there is no shared root rule file.
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
 * A workspace resource body, with only its boundary newlines removed. The
 * newlines around the body are file layout; the text between them is never
 * re-wrapped or re-indented.
 */
export function resourceBody(body: string): string {
  return body.replace(/^\n+/, '').replace(/\n+$/, '');
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

export type OpencodePersonaSection = {
  mode: PersonaMode;
  model?: string;
  permission?: Record<string, Record<string, 'allow' | 'deny'>>;
};

export type PersonaFrontmatter = {
  name: string;
  targets: string[];
  description: string;
  claudecode?: ClaudeBlock;
  opencode?: OpencodePersonaSection;
  opencodev1?: OpencodePersonaSection;
};

/** The rulesync tool-scoped section and target id for one OpenCode major. */
function opencodeSectionKey(target: OpencodeTarget): 'opencode' | 'opencodev1' {
  return target === OPENCODE_V1_TARGET ? 'opencodev1' : 'opencode';
}

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
    targets: ['claudecode'],
    description: persona.purpose,
  };
  if (Object.keys(block).length > 0) {
    frontmatter.claudecode = block;
  }
  return frontmatter;
}

export function personaSourceFile(persona: ResolvedPersona): string {
  const frontmatter = stringify(personaFrontmatter(persona), { lineWidth: 0 });
  return `---\n${frontmatter}---\n\n${personaBody(persona)}`;
}

/**
 * The renderer source form for an OpenCode per-agent block. The V2 target
 * (`opencode`) emits `description`, `mode`, `model` and the ordered
 * `permissions` array; the V1 target (`opencodev1`) emits `name`,
 * `description`, `mode`, `model` and the per-tool `permission` map. Both are
 * authored from the same resolved permission map under rulesync's canonical
 * category names (`read`, `edit`, `bash`, `task`): the adapter chooses the
 * emitted shape, so the product never restates one target's shape for the
 * other.
 */
export function opencodePersonaFrontmatter(
  persona: ResolvedPersona,
  target: OpencodeTarget,
): PersonaFrontmatter {
  // The persona's own OpenCode mode, or the measured default. This is the one
  // place the value is chosen, so the emitted file and the containment gate
  // cannot drift.
  const section: OpencodePersonaSection = { mode: persona.mode ?? DEFAULT_PERSONA_MODE };
  if (persona.model !== undefined) {
    section.model = persona.model;
  }
  if (persona.opencode.permission.length > 0) {
    const permission: Record<string, Record<string, 'allow' | 'deny'>> = {};
    for (const category of persona.opencode.permission) {
      const patterns: Record<string, 'allow' | 'deny'> = {};
      for (const [resource, effect] of category.patterns) {
        patterns[resource] = effect;
      }
      permission[category.key] = patterns;
    }
    section.permission = permission;
  }
  const frontmatter: PersonaFrontmatter = {
    name: persona.id,
    targets: [target],
    description: persona.purpose,
  };
  frontmatter[opencodeSectionKey(target)] = section;
  return frontmatter;
}

export function opencodePersonaSourceFile(
  persona: ResolvedPersona,
  target: OpencodeTarget,
): string {
  const frontmatter = stringify(opencodePersonaFrontmatter(persona, target), { lineWidth: 0 });
  return `---\n${frontmatter}---\n\n${personaBody(persona)}`;
}

/** The rulesync features one render of this source needs, never a wildcard. */
export function renderFeatures(target: SupportedTarget, source: ResolvedSource): RenderFeature[] {
  if (target === 'claudecode') {
    return ['subagents'];
  }
  const features: RenderFeature[] = ['subagents'];
  if (source.mcp.length > 0) {
    features.push('mcp');
  }
  if (source.skills.length > 0) {
    features.push('skills');
  }
  if (source.commands.length > 0) {
    features.push('commands');
  }
  if (source.hooks.some((hook) => hook.carried)) {
    features.push('hooks');
  }
  return features;
}

/**
 * rulesync's canonical environment reference. The OpenCode adapter converts it
 * to `{env:NAME}`, so the emitted artefact carries a reference and this tool
 * never reads the value.
 */
function envReference(value: EnvValueInput): string {
  if (typeof value === 'string') {
    // The loader already refused a literal (F002); this branch cannot be
    // reached from a validated source, and failing loudly is safer than
    // writing a secret value.
    throw new Error('internal invariant violated: a literal reached materialise');
  }
  return `\${${value.fromEnv}}`;
}

function referenceRecord(
  values: Record<string, EnvValueInput> | undefined,
): Record<string, string> | undefined {
  if (values === undefined) {
    return undefined;
  }
  const converted: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    converted[key] = envReference(value);
  }
  return converted;
}

async function writeOpencodeMcp(sourceRoot: string, source: ResolvedSource): Promise<void> {
  if (source.mcp.length === 0) {
    return;
  }
  const mcpServers: Record<string, unknown> = {};
  for (const server of source.mcp) {
    if (server.server.type === 'stdio') {
      const env = referenceRecord(server.server.env);
      mcpServers[server.id] = {
        type: 'stdio',
        command: server.server.command,
        ...(server.server.args === undefined ? {} : { args: server.server.args }),
        ...(env === undefined ? {} : { env }),
      };
      continue;
    }
    const headers = referenceRecord(server.server.headers);
    mcpServers[server.id] = {
      type: 'http',
      url: server.server.url,
      ...(headers === undefined ? {} : { headers }),
    };
  }
  await writeFile(
    join(sourceRoot, RULESYNC_MCP_FILE),
    `${JSON.stringify({ mcpServers }, null, 2)}\n`,
    'utf8',
  );
}

async function writeOpencodeSkills(sourceRoot: string, source: ResolvedSource): Promise<void> {
  for (const skill of source.skills) {
    const skillRoot = join(sourceRoot, SKILLS_DIR, skill.id);
    await mkdir(skillRoot, { recursive: true });
    const frontmatter = stringify(
      { name: skill.id, description: skill.description, targets: [source.target] },
      { lineWidth: 0 },
    );
    await writeFile(
      join(skillRoot, SKILL_FILE_NAME),
      `---\n${frontmatter}---\n\n${resourceBody(skill.body)}\n`,
      'utf8',
    );
    for (const file of skill.files) {
      const absolute = join(skillRoot, ...file.path.split('/'));
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.text, 'utf8');
    }
  }
}

async function writeOpencodeCommands(sourceRoot: string, source: ResolvedSource): Promise<void> {
  for (const command of source.commands) {
    await mkdir(join(sourceRoot, COMMANDS_DIR), { recursive: true });
    const frontmatter = stringify(
      {
        description: command.description,
        targets: [source.target],
      },
      { lineWidth: 0 },
    );
    await writeFile(
      join(sourceRoot, COMMANDS_DIR, `${command.id}.md`),
      `---\n${frontmatter}---\n\n${resourceBody(command.body)}\n`,
      'utf8',
    );
  }
}

const HOOK_EVENT_BY_PHASE: Record<string, string> = {
  'before-tool': 'preToolUse',
  'after-tool': 'postToolUse',
  'session-start': 'sessionStart',
  stop: 'stop',
};

async function writeOpencodeHooks(sourceRoot: string, source: ResolvedSource): Promise<void> {
  const hooks: Record<string, Array<{ matcher?: string; command: string }>> = {};
  for (const hook of source.hooks) {
    if (!hook.carried) {
      continue;
    }
    const event = HOOK_EVENT_BY_PHASE[hook.phase];
    if (event === undefined) {
      throw new Error(`internal invariant violated: carried hook phase ${hook.phase} has no event`);
    }
    const bucket = hooks[event] ?? [];
    bucket.push({
      ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
      command: hook.command,
    });
    hooks[event] = bucket;
  }
  if (Object.keys(hooks).length === 0) {
    return;
  }
  await writeFile(
    join(sourceRoot, RULESYNC_HOOKS_FILE),
    `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Write the rulesync-shaped source tree into the stage. One target is rendered
 * per run, so the stage is already target-scoped.
 *
 * On Claude Code a persona is one subagent and nothing else is authored: a
 * shared permission, MCP or hook block would leak one persona's restriction
 * onto every other persona.
 *
 * On OpenCode the MCP server, skill, command and hook declarations are
 * workspace-level, so they are authored once from the union of the live
 * personas rather than per persona. Rules are never authored as a root file:
 * the per-agent body is the only rule carrier.
 */
export async function materialiseSourceTree(
  sourceRoot: string,
  source: ResolvedSource,
): Promise<void> {
  const subagents = join(sourceRoot, 'subagents');
  await mkdir(subagents, { recursive: true });
  for (const persona of source.personas) {
    const contents = isOpencodeTarget(source.target)
      ? opencodePersonaSourceFile(persona, source.target)
      : personaSourceFile(persona);
    await writeFile(join(subagents, `${persona.id}.md`), contents, 'utf8');
  }
  if (!isOpencodeTarget(source.target)) {
    return;
  }
  await writeOpencodeMcp(sourceRoot, source);
  await writeOpencodeSkills(sourceRoot, source);
  await writeOpencodeCommands(sourceRoot, source);
  await writeOpencodeHooks(sourceRoot, source);
}
