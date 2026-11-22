import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';
import type { ResolvedPersona, ResolvedSource } from '../compose/resolve.js';
import {
  AGENT_FILE_EXT,
  CLAUDE_AGENTS_DIR,
  isOpencodeTarget,
  OPENCODE_AGENTS_DIR,
  OPENCODE_COMMANDS_DIR,
  OPENCODE_CONFIG_FILE,
  OPENCODE_HOOKS_PLUGIN,
  OPENCODE_SKILLS_DIR,
  type OpencodeTarget,
  SKILL_FILE_NAME,
  type SupportedTarget,
} from '../core/constants.js';
import { declaredNotEmitted } from '../core/errors.js';
import { readUtf8File } from '../core/fs.js';
import { compareCodepoints } from '../core/json.js';
import { lstatOrUndefined } from '../core/paths.js';
import { emitsTools, personaBody, resourceBody } from '../materialise/source-tree.js';
import type { RenderResult } from '../render/port.js';

export function expectedAgentPath(target: SupportedTarget, personaId: string): string {
  const directory = isOpencodeTarget(target) ? OPENCODE_AGENTS_DIR : CLAUDE_AGENTS_DIR;
  return `${directory}/${personaId}${AGENT_FILE_EXT}`;
}

type EmittedAgent = {
  frontmatter: Record<string, unknown>;
  body: string;
};

/**
 * Split an emitted artefact. Unlike the source reader, an emitted file is not
 * trusted: it must open with the frontmatter delimiter exactly, and the block
 * must parse as one YAML mapping.
 */
function parseEmittedAgent(text: string, subject: string): EmittedAgent {
  if (!text.startsWith('---\n')) {
    throw declaredNotEmitted('emitted artefact does not start with a "---" frontmatter block', {
      subject,
      action: 'the renderer produced no usable frontmatter; nothing was written',
    });
  }
  const close = text.indexOf('\n---', 4);
  if (close === -1) {
    throw declaredNotEmitted('emitted frontmatter block is not closed', { subject });
  }
  const document = parseDocument(text.slice(4, close), {
    uniqueKeys: true,
    schema: 'core',
    logLevel: 'silent',
  });
  if (document.errors.length > 0) {
    const [first] = document.errors;
    throw declaredNotEmitted(`emitted frontmatter did not parse: ${first?.message ?? 'unknown'}`, {
      subject,
    });
  }
  const value: unknown = document.toJS();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw declaredNotEmitted('emitted frontmatter is not a mapping', { subject });
  }
  const afterClose = text.indexOf('\n', close + 4);
  const body = afterClose === -1 ? '' : text.slice(afterClose + 1);
  return { frontmatter: value as Record<string, unknown>, body };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return undefined;
  }
  return [...(value as string[])].sort(compareCodepoints);
}

function describe(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Assert the emitted key set is exactly the declared one. A renderer that adds
 * a harness directive the persona never declared (`permissionMode`, `hooks`,
 * `maxTurns`, ...) is adding a capability, not just losing one, and must be
 * refused in the same way.
 */
function assertKeySet(
  expected: ReadonlySet<string>,
  emitted: Record<string, unknown>,
  persona: ResolvedPersona,
  subject: string,
): void {
  for (const key of Object.keys(emitted).sort(compareCodepoints)) {
    if (!expected.has(key)) {
      throw declaredNotEmitted(
        `emitted frontmatter carries undeclared key "${key}" for ${persona.id}`,
        {
          subject,
          action: 'the renderer may emit only the keys the persona declares; nothing was written',
        },
      );
    }
  }
}

/**
 * Assert one frontmatter field against the resolved persona. An absent field
 * must be absent, and a present field must equal the resolved value exactly.
 */
function assertField(
  emitted: Record<string, unknown>,
  key: string,
  expected: string | string[] | undefined,
  subject: string,
  persona: ResolvedPersona,
): void {
  const present = Object.hasOwn(emitted, key);
  if (expected === undefined) {
    if (present) {
      throw declaredNotEmitted(
        `emitted frontmatter carries "${key}", which the persona does not declare`,
        {
          subject,
          action: `the renderer must not invent a ${key} for ${persona.id}; nothing was written`,
        },
      );
    }
    return;
  }
  if (!present) {
    throw declaredNotEmitted(`emitted frontmatter is missing "${key}"`, {
      subject,
      action: `the renderer dropped the resolved ${key} for ${persona.id}; nothing was written`,
    });
  }
  const actual = emitted[key];
  if (typeof expected === 'string') {
    if (actual !== expected) {
      throw declaredNotEmitted(
        `emitted frontmatter "${key}" is ${describe(actual)} but the persona resolves to ${describe(expected)}`,
        { subject },
      );
    }
    return;
  }
  const actualArray = stringArray(actual);
  const expectedArray = [...expected].sort(compareCodepoints);
  if (
    actualArray === undefined ||
    actualArray.length !== expectedArray.length ||
    actualArray.some((entry, index) => entry !== expectedArray[index])
  ) {
    throw declaredNotEmitted(
      `emitted frontmatter "${key}" is ${describe(actual)} but the persona resolves to ${describe(expectedArray)}`,
      { subject },
    );
  }
}

/**
 * Compare bodies exactly, normalising only one trailing newline. A renderer
 * that prepends an instruction, appends one, or reorders the body differs from
 * the composed body and is refused; the presence of the right words somewhere
 * is not containment.
 */
function bodiesMatch(emitted: string, composed: string): boolean {
  const trimOne = (text: string): string => (text.endsWith('\n') ? text.slice(0, -1) : text);
  return trimOne(emitted) === trimOne(composed);
}

/**
 * The body gate, shared by both targets. Every declared rule's text must be
 * present; no other persona's composed body may appear; and the whole body must
 * equal the composed body exactly.
 */
function verifyBody(
  persona: ResolvedPersona,
  source: ResolvedSource,
  emittedBody: string,
  managedPath: string,
): void {
  for (const rule of persona.rules) {
    if (!emittedBody.includes(rule.body.trim())) {
      throw declaredNotEmitted(`declared rule "${rule.id}" is absent from the artefact`, {
        subject: `${managedPath} (persona ${persona.id})`,
        action: 'the renderer dropped declared content; nothing was written',
      });
    }
  }

  const composed = personaBody(persona);
  // Run the leak scan on the whole body, not only after a mismatch, and skip a
  // body this persona legitimately contains through composition: a base
  // persona's composed body is a prefix of the derived persona's body.
  for (const other of source.personas) {
    if (other.id === persona.id) {
      continue;
    }
    const otherBody = personaBody(other);
    if (otherBody === '' || otherBody === composed || composed.includes(otherBody)) {
      continue;
    }
    if (emittedBody.includes(otherBody)) {
      throw declaredNotEmitted(`persona ${other.id}'s content leaked into ${persona.id}`, {
        subject: managedPath,
        action: 'the renderer mixed persona content; nothing was written',
      });
    }
  }

  if (!bodiesMatch(emittedBody, composed)) {
    throw declaredNotEmitted('emitted body does not match the composed persona body', {
      subject: managedPath,
      action:
        'the renderer added or changed content the persona does not declare; nothing was written',
    });
  }
}

/** The exact Claude Code frontmatter keys this persona is allowed to emit. */
function claudeKeys(persona: ResolvedPersona): Set<string> {
  const keys = new Set(['name', 'description']);
  if (persona.model !== undefined) {
    keys.add('model');
  }
  if (emitsTools(persona)) {
    keys.add('tools');
  }
  if (persona.claude.deny.length > 0) {
    keys.add('disallowedTools');
  }
  return keys;
}

function verifyClaudeAgent(
  persona: ResolvedPersona,
  source: ResolvedSource,
  parsed: EmittedAgent,
  managedPath: string,
): void {
  assertKeySet(claudeKeys(persona), parsed.frontmatter, persona, managedPath);
  assertField(parsed.frontmatter, 'name', persona.id, managedPath, persona);
  assertField(parsed.frontmatter, 'description', persona.purpose, managedPath, persona);
  assertField(parsed.frontmatter, 'model', persona.model, managedPath, persona);
  assertField(
    parsed.frontmatter,
    'tools',
    emitsTools(persona) ? persona.claude.allow : undefined,
    managedPath,
    persona,
  );
  assertField(
    parsed.frontmatter,
    'disallowedTools',
    persona.claude.deny.length === 0 ? undefined : persona.claude.deny,
    managedPath,
    persona,
  );
  verifyBody(persona, source, parsed.body, managedPath);
}

function permissionRecords(value: unknown): Array<Record<string, string>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const records: Array<Record<string, string>> = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodepoints);
    if (
      keys.length !== 3 ||
      keys[0] !== 'action' ||
      keys[1] !== 'effect' ||
      keys[2] !== 'resource'
    ) {
      return undefined;
    }
    const { action, resource, effect } = record;
    if (typeof action !== 'string' || typeof resource !== 'string' || typeof effect !== 'string') {
      return undefined;
    }
    records.push({ action, resource, effect });
  }
  return records;
}

/**
 * The V2 (`opencode`) per-agent file. Measured at rulesync 43.11.0: the
 * frontmatter is `description`, `mode`, `model` (when declared) and
 * `permissions` (when the persona declares one), with no `name` key — OpenCode
 * 2.x names the agent from the file, and a stray V1 field would make the file
 * be read as a V1 agent.
 */
function verifyOpencodeV2Agent(
  persona: ResolvedPersona,
  source: ResolvedSource,
  parsed: EmittedAgent,
  managedPath: string,
): void {
  const keys = new Set(['description', 'mode']);
  if (persona.model !== undefined) {
    keys.add('model');
  }
  if (persona.opencode.records.length > 0) {
    keys.add('permissions');
  }
  assertKeySet(keys, parsed.frontmatter, persona, managedPath);
  assertField(parsed.frontmatter, 'description', persona.purpose, managedPath, persona);
  assertField(parsed.frontmatter, 'mode', 'subagent', managedPath, persona);
  assertField(parsed.frontmatter, 'model', persona.model, managedPath, persona);

  const expectedPermissions = persona.opencode.records;
  if (expectedPermissions.length === 0) {
    assertField(parsed.frontmatter, 'permissions', undefined, managedPath, persona);
  } else {
    const actual = permissionRecords(parsed.frontmatter['permissions']);
    if (actual === undefined || !isDeepStrictEqual(actual, expectedPermissions)) {
      throw declaredNotEmitted(
        `emitted permissions are ${describe(parsed.frontmatter['permissions'])} but the persona resolves to ${describe(expectedPermissions)}`,
        {
          subject: managedPath,
          action:
            'the renderer dropped, invented or reordered a permission record; nothing was written',
        },
      );
    }
  }
  verifyBody(persona, source, parsed.body, managedPath);
}

/**
 * The V1 (`opencodev1`) per-agent file. Measured at rulesync 43.11.0: the
 * frontmatter is `name`, `description`, `mode`, `model` (when declared) and the
 * per-tool `permission` map (when the persona declares one). `temperature` and
 * `tools` are V1 keys this product does not author, so they must never appear;
 * a renderer that invents one is adding a capability the persona did not
 * declare. The V1 map is compared value for value, key order included by
 * `isDeepStrictEqual` (order is not semantic in V1, but a reordered pattern set
 * is still a different map and is refused rather than nodded through).
 */
function verifyOpencodeV1Agent(
  persona: ResolvedPersona,
  source: ResolvedSource,
  parsed: EmittedAgent,
  managedPath: string,
): void {
  const keys = new Set(['name', 'description', 'mode']);
  if (persona.model !== undefined) {
    keys.add('model');
  }
  if (persona.opencode.permission.length > 0) {
    keys.add('permission');
  }
  assertKeySet(keys, parsed.frontmatter, persona, managedPath);
  assertField(parsed.frontmatter, 'name', persona.id, managedPath, persona);
  assertField(parsed.frontmatter, 'description', persona.purpose, managedPath, persona);
  assertField(parsed.frontmatter, 'mode', 'subagent', managedPath, persona);
  assertField(parsed.frontmatter, 'model', persona.model, managedPath, persona);

  const expected: Record<string, Record<string, string>> = {};
  for (const category of persona.opencode.permission) {
    const patterns: Record<string, string> = {};
    for (const [resource, effect] of category.patterns) {
      patterns[resource] = effect;
    }
    expected[category.key] = patterns;
  }
  if (persona.opencode.permission.length === 0) {
    assertField(parsed.frontmatter, 'permission', undefined, managedPath, persona);
  } else if (!isDeepStrictEqual(parsed.frontmatter['permission'], expected)) {
    throw declaredNotEmitted(
      `emitted permission map is ${describe(parsed.frontmatter['permission'])} but the persona resolves to ${describe(expected)}`,
      {
        subject: managedPath,
        action:
          'the renderer dropped, invented or rewrote a permission category; nothing was written',
      },
    );
  }
  verifyBody(persona, source, parsed.body, managedPath);
}

/** Dispatch the per-agent gate to the shape the configured target emits. */
function verifyOpencodeAgent(
  target: OpencodeTarget,
  persona: ResolvedPersona,
  source: ResolvedSource,
  parsed: EmittedAgent,
  managedPath: string,
): void {
  if (target === 'opencodev1') {
    verifyOpencodeV1Agent(persona, source, parsed, managedPath);
    return;
  }
  verifyOpencodeV2Agent(persona, source, parsed, managedPath);
}

type ExpectedMcpServer = Record<string, unknown>;

function expectedEnvReference(
  values: Record<string, string | { fromEnv: string }>,
): Record<string, string> {
  const converted: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      // Unreachable from a validated source: the loader refuses a literal
      // (F002). Failing loudly is safer than treating it as a reference.
      throw declaredNotEmitted('an MCP credential value is not a reference', { subject: key });
    }
    converted[key] = `{env:${value.fromEnv}}`;
  }
  return converted;
}

/**
 * The MCP server map rulesync emits from the materialised source. Both OpenCode
 * targets use `type: local|remote`, a `command` array and the same
 * `environment` / `headers` maps; OpenCode 1.x additionally writes an explicit
 * `enabled: true` on every server, where 2.x omits an enabled server's toggle
 * and writes only `disabled: true`. V2 nests the map under `mcp.servers`; V1
 * keys it directly under `mcp`, so the same expected map is wrapped differently
 * by the caller.
 */
function expectedMcpServers(
  source: ResolvedSource,
  target: OpencodeTarget,
): Record<string, ExpectedMcpServer> {
  const servers: Record<string, ExpectedMcpServer> = {};
  for (const resource of source.mcp) {
    if (resource.server.type === 'stdio') {
      const env =
        resource.server.env === undefined ? undefined : expectedEnvReference(resource.server.env);
      servers[resource.id] = {
        type: 'local',
        command: [resource.server.command, ...(resource.server.args ?? [])],
        ...(target === 'opencodev1' ? { enabled: true } : {}),
        ...(env === undefined ? {} : { environment: env }),
      };
      continue;
    }
    const headers =
      resource.server.headers === undefined
        ? undefined
        : expectedEnvReference(resource.server.headers);
    servers[resource.id] = {
      type: 'remote',
      url: resource.server.url,
      ...(target === 'opencodev1' ? { enabled: true } : {}),
      ...(headers === undefined ? {} : { headers }),
    };
  }
  return servers;
}

async function readManagedFile(absolute: string, subject: string): Promise<string> {
  const stats = await lstatOrUndefined(absolute, subject);
  if (stats === undefined) {
    throw declaredNotEmitted('declared resource produced no artefact', {
      subject,
      action: 'the renderer did not emit this file; nothing was written',
    });
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw declaredNotEmitted('rendered path is not a regular file', { subject });
  }
  return await readUtf8File(absolute, subject, {
    action: 'the renderer must emit UTF-8; nothing was written',
  });
}

async function verifySkill(
  skill: ResolvedSource['skills'][number],
  outputRoot: string,
): Promise<Map<string, string>> {
  const verified = new Map<string, string>();
  const dir = `${OPENCODE_SKILLS_DIR}/${skill.id}`;
  const skillPath = `${dir}/${SKILL_FILE_NAME}`;
  const text = await readManagedFile(join(outputRoot, dir, SKILL_FILE_NAME), skillPath);
  verified.set(skillPath, text);
  const parsed = parseEmittedAgent(text, skillPath);
  const keys = new Set(Object.keys(parsed.frontmatter).sort(compareCodepoints));
  if (keys.size !== 2 || !keys.has('description') || !keys.has('name')) {
    throw declaredNotEmitted(
      `skill "${skill.id}" frontmatter must carry exactly name and description`,
      { subject: skillPath },
    );
  }
  if (parsed.frontmatter['name'] !== skill.id) {
    throw declaredNotEmitted(
      `skill "${skill.id}" was emitted under name ${describe(parsed.frontmatter['name'])}`,
      { subject: skillPath },
    );
  }
  if (parsed.frontmatter['description'] !== skill.description) {
    throw declaredNotEmitted(
      `skill "${skill.id}" description differs from the declared description`,
      { subject: skillPath },
    );
  }
  if (!bodiesMatch(parsed.body, `${resourceBody(skill.body)}\n`)) {
    throw declaredNotEmitted(`skill "${skill.id}" body differs from the declared body`, {
      subject: skillPath,
    });
  }
  for (const file of skill.files) {
    const path = `${dir}/${file.path}`;
    const actual = await readManagedFile(join(outputRoot, dir, ...file.path.split('/')), path);
    if (actual !== file.text) {
      throw declaredNotEmitted(`skill file "${path}" differs from the declared bytes`, {
        subject: path,
      });
    }
    verified.set(path, actual);
  }
  return verified;
}

async function verifyCommand(
  command: ResolvedSource['commands'][number],
  outputRoot: string,
): Promise<Map<string, string>> {
  const path = `${OPENCODE_COMMANDS_DIR}/${command.id}.md`;
  const text = await readManagedFile(join(outputRoot, path), path);
  const parsed = parseEmittedAgent(text, path);
  const actualKeys = new Set(Object.keys(parsed.frontmatter));
  if (actualKeys.size !== 1 || !actualKeys.has('description')) {
    throw declaredNotEmitted(
      `command "${command.id}" frontmatter carries ${describe(Object.keys(parsed.frontmatter))}, but a command declares exactly description`,
      { subject: path },
    );
  }
  if (parsed.frontmatter['description'] !== command.description) {
    throw declaredNotEmitted(
      `command "${command.id}" description differs from the declared description`,
      {
        subject: path,
      },
    );
  }
  if (!bodiesMatch(parsed.body, `${resourceBody(command.body)}\n`)) {
    throw declaredNotEmitted(`command "${command.id}" body differs from the declared body`, {
      subject: path,
    });
  }
  return new Map([[path, text]]);
}

/**
 * Undo rulesync's template-literal escaping, in the exact inverse of the order
 * it applied (`escapeForTemplateLiteral`: double each backslash, prefix each
 * backtick, then prefix each `${`):
 *
 * 1. `\${` -> `${`
 * 2. `` \` `` -> `` ` ``
 * 3. `\\` -> `\`
 *
 * The order is load-bearing. Undoing the backslash doubling first would turn a
 * literal `\${` into `${` and make a command that only *looks* like a
 * substitution compare equal to one that is.
 */
function unescapeTemplateLiteral(value: string): string {
  return value.replaceAll('\\${', '${').replaceAll('\\`', '`').replaceAll('\\\\', '\\');
}

const HOOK_EVENT_BY_PHASE: Record<string, string> = {
  'before-tool': 'preToolUse',
  'after-tool': 'postToolUse',
  'session-start': 'sessionStart',
  stop: 'stop',
};

type HookAnchor = { index: number; event: string; registration: boolean };

/** One registration anchor pattern: where a hook's registration begins. */
type HookAnchorPattern = {
  pattern: RegExp;
  event: (match: RegExpExecArray) => string;
  /**
   * True for the block a hook is registered in, false for a label that names
   * the event inside a run call. A non-registration anchor can identify a
   * command's event but never start its matcher window.
   */
  registration: boolean;
};

/**
 * The V2 (`opencode`) plugin's registration anchors, measured at rulesync
 * 43.11.0: a tool hook (`ctx.tool.hook("execute.before"|"execute.after", ...)`)
 * and an event hook whose `label: "<event>"` has no tool anchor.
 */
const OPENCODE_V2_HOOK_ANCHORS: readonly HookAnchorPattern[] = [
  { pattern: /ctx\.tool\.hook\("execute\.before"/g, event: () => 'preToolUse', registration: true },
  { pattern: /ctx\.tool\.hook\("execute\.after"/g, event: () => 'postToolUse', registration: true },
  {
    pattern: /label: "(preToolUse|postToolUse|sessionStart|stop)"/g,
    event: (match) => match[1] ?? '',
    registration: false,
  },
];

/**
 * The V1 (`opencodev1`) `RulesyncHooksPlugin` registration anchors, measured at
 * rulesync 43.11.0: the returned object keys `"tool.execute.before"` and
 * `"tool.execute.after"`, and the event-loop branches
 * `event.type === "session.created"` / `event.type === "session.idle"`. The
 * V1 plugin also carries `label: "sessionStart"|"stop"|"postToolUse"` inside
 * each run call; those are labels, not anchors, so they are deliberately absent
 * from this list.
 */
const OPENCODE_V1_HOOK_ANCHORS: readonly HookAnchorPattern[] = [
  { pattern: /"tool\.execute\.before":/g, event: () => 'preToolUse', registration: true },
  { pattern: /"tool\.execute\.after":/g, event: () => 'postToolUse', registration: true },
  {
    pattern: /event\.type === "session\.created"/g,
    event: () => 'sessionStart',
    registration: true,
  },
  { pattern: /event\.type === "session\.idle"/g, event: () => 'stop', registration: true },
];

/**
 * The hooks plugin is generated JavaScript, so it is verified at the level that
 * matters: exactly the declared commands, each bound to its declared event and
 * matcher. A byte pin lives in the golden test; this gate is what fails when an
 * undeclared command is injected, a declared one is dropped, or one is moved to
 * another event.
 *
 * A command's event is the nearest preceding registration anchor; its matcher
 * is the `new RegExp(...)` between the previous command and this one within that
 * registration. The anchor set is the only thing that differs between the two
 * OpenCode majors: V2 registers through `ctx.tool.hook(...)` and a label-only
 * event loop, V1 through the returned `"tool.execute.*"` keys and
 * `event.type === ...` branches.
 *
 * An `after-tool` command in V2 is emitted inside `ctx.tool.hook("execute.after",
 * ...)` *and* carries `label: "postToolUse"` in the same `__rulesyncRunHook(...)`
 * call. That label sits AFTER the matcher guard, so it must never start the
 * matcher window: only the registration anchor may. The window runs from the
 * previous command's end, so a matcher-less hook cannot inherit its neighbour's
 * guard.
 */
function verifyHookPlugin(
  source: ResolvedSource,
  text: string,
  subject: string,
  anchorPatterns: readonly HookAnchorPattern[],
): void {
  const anchors: HookAnchor[] = [];
  for (const { pattern, event, registration } of anchorPatterns) {
    for (const match of text.matchAll(pattern)) {
      anchors.push({ index: match.index ?? 0, event: event(match), registration });
    }
  }

  const nearestAnchor = (index: number): HookAnchor | undefined => {
    let found: HookAnchor | undefined;
    for (const anchor of anchors) {
      if (anchor.index < index && (found === undefined || anchor.index > found.index)) {
        found = anchor;
      }
    }
    return found;
  };
  /** The start of the block that holds the command, never a label inside its run call. */
  const registrationStartAt = (index: number): number | undefined => {
    let found: HookAnchor | undefined;
    for (const anchor of anchors) {
      if (anchor.index >= index || !anchor.registration) {
        continue;
      }
      if (found === undefined || anchor.index > found.index) {
        found = anchor;
      }
    }
    // An event-loop hook has no tool anchor; its `label:` is the block start.
    return (found ?? nearestAnchor(index))?.index;
  };

  const registrations: Array<{ event: string; command: string; matcher?: string }> = [];
  const commandPattern = /command: ("(?:[^"\\]|\\.)*")/g;
  // rulesync lays a registration out as `matcher? command matcher? command ...`
  // inside one callback, so a command's matcher is the `new RegExp(...)` between
  // the PREVIOUS command and this one. Slicing from the event anchor instead
  // let a second command inherit an earlier command's matcher (a matcher-less
  // hook was refused, and a dropped matcher was accepted when both hooks named
  // the same one).
  let previousCommandEnd = -1;
  for (const match of text.matchAll(commandPattern)) {
    const index = match.index ?? 0;
    const raw = match[1] ?? '""';
    let command: string;
    try {
      // rulesync escapes the command for a template literal before embedding
      // it, so the parsed string is the escaped form, not the source command.
      // Undo that escaping before comparing: it is the renderer's
      // representation of the same command, not an added or dropped instruction.
      command = unescapeTemplateLiteral(JSON.parse(raw) as string);
    } catch {
      throw declaredNotEmitted('hooks plugin contains an unreadable command', { subject });
    }
    const registration = nearestAnchor(index);
    if (registration === undefined) {
      throw declaredNotEmitted(
        `hooks plugin declares command ${describe(command)} with no registration event`,
        { subject },
      );
    }
    // The window starts after the previous command, never at the anchor: a hook
    // without a matcher must not inherit its neighbour's guard, and a dropped
    // matcher must not be replaced by an earlier identical one. With no previous
    // command it starts at the enclosing registration, never at a `label:` that
    // is an argument of this same call.
    const windowStart =
      previousCommandEnd >= 0 ? previousCommandEnd : (registrationStartAt(index) ?? 0);
    const block = text.slice(windowStart, index);
    previousCommandEnd = index + match[0].length;
    const matcherMatch = /new RegExp\("((?:[^"\\]|\\.)*)"\)/g;
    let matcher: string | undefined;
    for (const candidate of block.matchAll(matcherMatch)) {
      try {
        // A matcher is embedded directly in a quoted JS string with backslashes
        // and quotes escaped, so JSON.parse is its whole inverse: applying the
        // template-literal unescape here too would strip one level too many
        // from a matcher that contains a literal backslash.
        matcher = JSON.parse(`"${candidate[1] ?? ''}"`) as string;
      } catch {
        matcher = undefined;
      }
    }
    registrations.push({
      event: registration.event,
      command,
      ...(matcher === undefined ? {} : { matcher }),
    });
  }

  const expected = source.hooks
    .filter((hook) => hook.carried)
    .map((hook) => ({
      event: HOOK_EVENT_BY_PHASE[hook.phase] ?? '',
      command: hook.command,
      ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
    }))
    .sort((a, b) => compareCodepoints(`${a.event}\0${a.command}`, `${b.event}\0${b.command}`));
  registrations.sort((a, b) =>
    compareCodepoints(`${a.event}\0${a.command}`, `${b.event}\0${b.command}`),
  );
  if (!isDeepStrictEqual(registrations, expected)) {
    throw declaredNotEmitted(
      `hooks plugin registers ${describe(registrations)} but the source declares ${describe(expected)}`,
      {
        subject,
        action: 'the renderer dropped, invented or moved a hook; nothing was written',
      },
    );
  }
}

async function verifyOpencodeWorkspace(
  source: ResolvedSource,
  outputRoot: string,
  target: OpencodeTarget,
): Promise<Map<string, string>> {
  const verified = new Map<string, string>();
  if (source.mcp.length > 0) {
    const path = OPENCODE_CONFIG_FILE;
    const text = await readManagedFile(join(outputRoot, path), path);
    verified.set(path, text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw declaredNotEmitted('opencode config is not valid JSON', { subject: path });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw declaredNotEmitted('opencode config is not a JSON object', { subject: path });
    }
    const keys = Object.keys(parsed as Record<string, unknown>).sort(compareCodepoints);
    if (keys.length !== 1 || keys[0] !== 'mcp') {
      throw declaredNotEmitted(
        `opencode config carries top-level keys ${describe(keys)}, but this render declares only mcp`,
        {
          subject: path,
          action:
            'the renderer must not add a shared permission or instruction block; nothing was written',
        },
      );
    }
    const mcp = (parsed as Record<string, unknown>)['mcp'];
    if (mcp === null || typeof mcp !== 'object' || Array.isArray(mcp)) {
      throw declaredNotEmitted('opencode config mcp is not an object', { subject: path });
    }
    const expected = expectedMcpServers(source, target);
    let emitted: unknown;
    if (source.target === 'opencodev1') {
      // V1 is the flat map directly under `mcp`. An envelope here would be the
      // V2 shape, which OpenCode 1.x does not read as servers.
      emitted = mcp;
    } else {
      const mcpKeys = Object.keys(mcp as Record<string, unknown>).sort(compareCodepoints);
      if (mcpKeys.length !== 1 || mcpKeys[0] !== 'servers') {
        throw declaredNotEmitted(`opencode config mcp carries keys ${describe(mcpKeys)}`, {
          subject: path,
        });
      }
      emitted = (mcp as Record<string, unknown>)['servers'];
    }
    if (!isDeepStrictEqual(emitted, expected)) {
      throw declaredNotEmitted(
        `opencode mcp servers are ${describe(emitted)} but the source declares ${describe(expected)}`,
        {
          subject: path,
          action: 'the renderer dropped, invented or rewrote an MCP server; nothing was written',
        },
      );
    }
  }

  for (const skill of source.skills) {
    for (const [path, text] of await verifySkill(skill, outputRoot)) {
      verified.set(path, text);
    }
  }
  for (const command of source.commands) {
    for (const [path, text] of await verifyCommand(command, outputRoot)) {
      verified.set(path, text);
    }
  }

  const carriedHooks = source.hooks.filter((hook) => hook.carried);
  if (carriedHooks.length > 0) {
    const text = await readManagedFile(
      join(outputRoot, OPENCODE_HOOKS_PLUGIN),
      OPENCODE_HOOKS_PLUGIN,
    );
    if (text.length === 0) {
      throw declaredNotEmitted('hooks plugin is empty', { subject: OPENCODE_HOOKS_PLUGIN });
    }
    verifyHookPlugin(
      source,
      text,
      OPENCODE_HOOKS_PLUGIN,
      target === 'opencodev1' ? OPENCODE_V1_HOOK_ANCHORS : OPENCODE_V2_HOOK_ANCHORS,
    );
    verified.set(OPENCODE_HOOKS_PLUGIN, text);
  }
  return verified;
}

/**
 * The exact set of managed paths a target renders. The set is derived from the
 * plan, never from `RenderResult`: the renderer's own path list is what the
 * gate is checking, so it cannot also define the expectation.
 */
export function expectedPaths(source: ResolvedSource): string[] {
  const paths: string[] = source.personas.map((persona) =>
    expectedAgentPath(source.target, persona.id),
  );
  if (isOpencodeTarget(source.target)) {
    if (source.mcp.length > 0) {
      paths.push(OPENCODE_CONFIG_FILE);
    }
    for (const skill of source.skills) {
      paths.push(`${OPENCODE_SKILLS_DIR}/${skill.id}/${SKILL_FILE_NAME}`);
      for (const file of skill.files) {
        paths.push(`${OPENCODE_SKILLS_DIR}/${skill.id}/${file.path}`);
      }
    }
    for (const command of source.commands) {
      paths.push(`${OPENCODE_COMMANDS_DIR}/${command.id}.md`);
    }
    if (source.hooks.some((hook) => hook.carried)) {
      paths.push(OPENCODE_HOOKS_PLUGIN);
    }
  }
  return paths.sort(compareCodepoints);
}

/**
 * The containment gate. Every expected artefact is a non-empty file whose
 * frontmatter key set and values equal the resolved persona, and whose body is
 * exactly the persona's composed body (one trailing newline normalised). On
 * OpenCode the workspace files are verified against the resolved resources too.
 *
 * Returns the exact bytes it verified, keyed by managed path. The caller writes
 * THESE bytes: re-reading the stage after verification would let a renderer (or
 * a concurrent writer) change the file between the gate and the write, so the
 * bytes that were checked would not be the bytes that landed.
 */
export async function verifyRender(
  source: ResolvedSource,
  render: RenderResult,
  outputRoot: string,
): Promise<Map<string, string>> {
  const expected = expectedPaths(source);
  const emitted = [...render.files].sort(compareCodepoints);

  const agentPaths = new Set(
    source.personas.map((persona) => expectedAgentPath(source.target, persona.id)),
  );
  for (const path of expected) {
    if (!emitted.includes(path)) {
      throw declaredNotEmitted(
        agentPaths.has(path)
          ? 'declared persona produced no artefact'
          : 'declared resource produced no artefact',
        {
          subject: path,
          action: 'the renderer did not emit this file; nothing was written',
        },
      );
    }
  }
  for (const path of emitted) {
    if (!expected.includes(path)) {
      throw declaredNotEmitted('renderer emitted an unexpected path', {
        subject: path,
        action: 'the expected path set is one artefact per declaration',
      });
    }
  }

  const verified = new Map<string, string>();
  for (const persona of source.personas) {
    const managedPath = expectedAgentPath(source.target, persona.id);
    const absolute = join(outputRoot, managedPath);
    // The renderer's own path list is not evidence that it wrote anything.
    const stats = await lstatOrUndefined(absolute, managedPath);
    if (stats === undefined) {
      throw declaredNotEmitted('renderer listed a path it did not write', {
        subject: managedPath,
        action: 'the renderer reported a file that does not exist; nothing was written',
      });
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw declaredNotEmitted('rendered path is not a regular file', { subject: managedPath });
    }
    const text = await readUtf8File(absolute, managedPath, {
      action: 'the renderer must emit UTF-8; nothing was written',
    });
    if (text.length === 0) {
      throw declaredNotEmitted('rendered artefact is empty', {
        subject: managedPath,
        action: 'an empty agent file declares no persona; nothing was written',
      });
    }
    const parsed = parseEmittedAgent(text, managedPath);
    if (isOpencodeTarget(source.target)) {
      verifyOpencodeAgent(source.target, persona, source, parsed, managedPath);
    } else {
      verifyClaudeAgent(persona, source, parsed, managedPath);
    }
    verified.set(managedPath, text);
  }

  if (isOpencodeTarget(source.target)) {
    for (const [path, text] of await verifyOpencodeWorkspace(source, outputRoot, source.target)) {
      verified.set(path, text);
    }
  }
  return verified;
}
