import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ZodError } from 'zod';
import {
  COMMAND_FILE_EXT,
  COMMANDS_DIR,
  HOOKS_DIR,
  isOsMetadataName,
  MCP_DIR,
  PERMISSION_FILE_EXT,
  PERMISSIONS_DIR,
  PERSONA_FILE_EXT,
  PERSONAS_DIR,
  RESOURCES_DIR,
  ROOT_DIR,
  RULE_FILE_EXT,
  RULES_DIR,
  SKILL_FILE_NAME,
  SKILLS_DIR,
  STRUCTURED_RESOURCE_FILE_EXT,
} from '../core/constants.js';
import { conflict, invalidConfig, pathUnsafe, secretLiteral } from '../core/errors.js';
import { readUtf8File } from '../core/fs.js';
import { canonicalJson, compareCodepoints, parseJsonc, sha256Hex } from '../core/json.js';
import { assertRealDirectory } from '../core/paths.js';
import { permissionResourceDigest } from '../permissions/permissions.js';
import { splitFrontmatter } from './frontmatter.js';
import {
  type CommandFrontmatter,
  commandFrontmatterSchema,
  type HookDeclaration,
  hookSchema,
  type McpDeclaration,
  type McpServerDeclaration,
  mcpSchema,
  type PermissionDeclaration,
  type PersonaDeclaration,
  permissionSchema,
  personaSchema,
  type RuleFrontmatter,
  ruleFrontmatterSchema,
  type SkillFrontmatter,
  skillFrontmatterSchema,
} from './schema.js';
import { parseYamlStrict } from './yaml.js';

export type RuleResource = {
  kind: 'rule';
  id: string;
  displayName: string;
  body: string;
  /** Repository-relative path, for messages. */
  path: string;
};

export type PermissionResource = PermissionDeclaration & {
  /** True when the resource opts its persona into Claude Code's `tools` allow-list. */
  allowlist: boolean;
  /** Repository-relative path, for messages. */
  path: string;
};

/**
 * One extra file carried inside a skill directory. Content is strict UTF-8
 * text: the managed-output pipeline compares and writes text, and decoding then
 * re-encoding a valid UTF-8 file is byte-identical. A non-UTF-8 asset is refused
 * (F001) rather than silently corrupted.
 */
export type SkillFile = {
  /** Path relative to the skill directory, POSIX-spelled. */
  path: string;
  text: string;
};

export type CommandResource = {
  kind: 'command';
  id: string;
  description?: string;
  body: string;
  /** Repository-relative path, for messages. */
  path: string;
  /** Content digest, for duplicate-id detection. */
  sha256: string;
};

export type SkillResource = {
  kind: 'skill';
  id: string;
  description: string;
  body: string;
  /** `SKILL.md` plus every other file, sorted by path. */
  files: SkillFile[];
  /** Repository-relative path of `SKILL.md`, for messages. */
  path: string;
  /** Content digest, for duplicate-id detection. */
  sha256: string;
};

export type McpResource = {
  kind: 'mcp';
  id: string;
  server: McpServerDeclaration;
  /** Repository-relative path, for messages. */
  path: string;
  /** Content digest, for duplicate-id detection. */
  sha256: string;
};

export type HookResource = {
  kind: 'hook';
  id: string;
  phase: HookDeclaration['phase'];
  matcher?: string;
  command: string;
  /** Repository-relative path, for messages. */
  path: string;
  /** Content digest, for duplicate-id detection. */
  sha256: string;
};

export type LoadedPersona = PersonaDeclaration & {
  /** Repository-relative path, for messages. */
  path: string;
};

export type SourceTree = {
  personas: LoadedPersona[];
  rules: RuleResource[];
  permissions: PermissionResource[];
  mcp: McpResource[];
  skills: SkillResource[];
  commands: CommandResource[];
  hooks: HookResource[];
};

function relative(...segments: string[]): string {
  return join(ROOT_DIR, ...segments).replaceAll('\\', '/');
}

function describeZodError(error: ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return 'did not validate';
  }
  const pointer = issue.path.join('.');
  return pointer === '' ? issue.message : `${pointer}: ${issue.message}`;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function listEntries(
  path: string,
  subject: string,
  options: { optional?: boolean } = {},
): Promise<Dirent[]> {
  // The directory itself is checked before it is listed: a symlinked
  // `.farna/personas` would otherwise compile personas from anywhere on disk.
  const stats = await assertRealDirectory(path, subject);
  if (stats === undefined && options.optional === true) {
    return [];
  }
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (options.optional === true && isMissingFileError(error)) {
      return [];
    }
    throw invalidConfig(`cannot read ${subject}`, {
      subject,
      action: 'run "farna-bootstrapper init" to create the source tree',
      cause: error,
    });
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw pathUnsafe(`symlink not allowed: ${subject}/${entry.name}`, {
        subject: `${subject}/${entry.name}`,
      });
    }
  }
  // Finder, Explorer and desktop.ini write these into any directory a checkout
  // has visited. They are not source and must not stop a valid tree compiling;
  // every other unexpected name is still a hard error.
  return entries
    .filter((entry) => !isOsMetadataName(entry.name))
    .sort((a, b) => compareCodepoints(a.name, b.name));
}

/**
 * Only the resource kinds this milestone loads may exist on disk. A `models/`
 * directory is not created by `init` and is refused when populated: a model is
 * the persona's `model` class, and accepting a model resource file the tool
 * then ignored would be the silent no-op the strict schema exists to prevent.
 */
const SUPPORTED_RESOURCE_DIRS: readonly string[] = [
  RULES_DIR,
  PERMISSIONS_DIR,
  MCP_DIR,
  SKILLS_DIR,
  COMMANDS_DIR,
  HOOKS_DIR,
];

async function assertSupportedResourceDirs(repoRoot: string): Promise<void> {
  const dirRelative = relative(RESOURCES_DIR);
  // Git does not track an empty directory, so a clone of a freshly initialised
  // tree has no `resources/` at all.
  const entries = await listEntries(join(repoRoot, ROOT_DIR, RESOURCES_DIR), dirRelative, {
    optional: true,
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !SUPPORTED_RESOURCE_DIRS.includes(entry.name)) {
      throw invalidConfig(`resource kind "${entry.name}" is not implemented in this slice`, {
        subject: `${dirRelative}/${entry.name}`,
        action: `this slice supports resource files under ${SUPPORTED_RESOURCE_DIRS.map((dir) => `resources/${dir}/`).join(' and ')}`,
      });
    }
  }
}

async function loadPersonas(repoRoot: string): Promise<LoadedPersona[]> {
  const dirRelative = relative(PERSONAS_DIR);
  // A clone has no `personas/` when nothing was committed under it yet.
  const entries = await listEntries(join(repoRoot, ROOT_DIR, PERSONAS_DIR), dirRelative, {
    optional: true,
  });
  const personas: LoadedPersona[] = [];
  for (const entry of entries) {
    const name = entry.name;
    const path = `${dirRelative}/${name}`;
    if (!entry.isFile()) {
      throw invalidConfig('unexpected entry in personas/', {
        subject: path,
        action: `a persona is one ${PERSONA_FILE_EXT} file`,
      });
    }
    if (!name.endsWith(PERSONA_FILE_EXT)) {
      throw invalidConfig('unexpected file in personas/', {
        subject: path,
        action: `persona files use the ${PERSONA_FILE_EXT} extension`,
      });
    }
    const text = await readUtf8File(join(repoRoot, ROOT_DIR, PERSONAS_DIR, name), path, {
      action: 'make the persona file readable and re-run generate',
    });
    const raw = parseYamlStrict(text, { subject: path });
    let persona: PersonaDeclaration;
    try {
      persona = personaSchema.parse(raw);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidConfig(describeZodError(error), { subject: path });
      }
      throw error;
    }
    const stem = name.slice(0, -PERSONA_FILE_EXT.length);
    if (persona.id !== stem) {
      throw invalidConfig(`id "${persona.id}" does not match the file name "${stem}"`, {
        subject: path,
        action: 'rename the file or change the id',
      });
    }
    personas.push({ ...persona, path });
  }
  return personas;
}

async function loadRules(repoRoot: string): Promise<RuleResource[]> {
  const dirRelative = relative(RESOURCES_DIR, RULES_DIR);
  // Git does not track an empty `resources/rules/`, so a clone may not have it.
  const entries = await listEntries(
    join(repoRoot, ROOT_DIR, RESOURCES_DIR, RULES_DIR),
    dirRelative,
    { optional: true },
  );
  const rules: RuleResource[] = [];
  for (const entry of entries) {
    const name = entry.name;
    const path = `${dirRelative}/${name}`;
    if (!entry.isFile()) {
      throw invalidConfig('unexpected entry in resources/rules/', {
        subject: path,
        action: `a rule is one ${RULE_FILE_EXT} file`,
      });
    }
    if (!name.endsWith(RULE_FILE_EXT)) {
      throw invalidConfig('unexpected file in resources/rules/', {
        subject: path,
        action: `rule files use the ${RULE_FILE_EXT} extension`,
      });
    }
    const text = await readUtf8File(
      join(repoRoot, ROOT_DIR, RESOURCES_DIR, RULES_DIR, name),
      path,
      { action: 'make the rule file readable and re-run generate' },
    );
    const frontmatter = splitFrontmatter(text, path);
    const raw = parseYamlStrict(frontmatter.text, { subject: `${path}:frontmatter` });
    let parsed: RuleFrontmatter;
    try {
      parsed = ruleFrontmatterSchema.parse(raw);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidConfig(describeZodError(error), { subject: `${path}:frontmatter` });
      }
      throw error;
    }
    const stem = name.slice(0, -RULE_FILE_EXT.length);
    if (parsed.id !== stem) {
      throw invalidConfig(`id "${parsed.id}" does not match the file name "${stem}"`, {
        subject: path,
      });
    }
    if (frontmatter.body.trim() === '') {
      throw invalidConfig('rule body is empty', {
        subject: path,
        action: 'add the rule text after the closing frontmatter delimiter',
      });
    }
    rules.push({
      kind: 'rule',
      id: parsed.id,
      displayName: parsed.displayName ?? parsed.id,
      body: frontmatter.body,
      path,
    });
  }
  return rules;
}

async function loadPermissions(repoRoot: string): Promise<PermissionResource[]> {
  const dirRelative = relative(RESOURCES_DIR, PERMISSIONS_DIR);
  // A source tree with no permissions is valid: the directory is optional.
  const entries = await listEntries(
    join(repoRoot, ROOT_DIR, RESOURCES_DIR, PERMISSIONS_DIR),
    dirRelative,
    { optional: true },
  );
  const byId = new Map<string, PermissionResource & { contentDigest: string }>();
  for (const entry of entries) {
    const name = entry.name;
    const path = `${dirRelative}/${name}`;
    if (!entry.isFile()) {
      throw invalidConfig('unexpected entry in resources/permissions/', {
        subject: path,
        action: `a permission is one ${PERMISSION_FILE_EXT} file`,
      });
    }
    if (!name.endsWith(PERMISSION_FILE_EXT)) {
      throw invalidConfig('unexpected file in resources/permissions/', {
        subject: path,
        action: `permission files use the ${PERMISSION_FILE_EXT} extension`,
      });
    }
    const text = await readUtf8File(
      join(repoRoot, ROOT_DIR, RESOURCES_DIR, PERMISSIONS_DIR, name),
      path,
      { action: 'make the permission file readable and re-run generate' },
    );
    const raw = parseJsonc(text, { subject: path });
    let parsed: PermissionDeclaration;
    try {
      parsed = permissionSchema.parse(raw);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidConfig(describeZodError(error), { subject: path });
      }
      throw error;
    }
    const resource: PermissionResource = {
      kind: 'permission',
      id: parsed.id,
      tools: parsed.tools,
      ...(parsed.patterns === undefined ? {} : { patterns: parsed.patterns }),
      allowlist: parsed.allowlist === true,
      path,
    };
    const contentDigest = permissionResourceDigest(
      resource.tools,
      resource.patterns,
      resource.allowlist,
    );
    const existing = byId.get(resource.id);
    if (existing === undefined) {
      byId.set(resource.id, { ...resource, contentDigest });
      continue;
    }
    if (existing.contentDigest !== contentDigest) {
      throw conflict(
        `two permission resources share the id "${resource.id}" with different content`,
        {
          subject: path,
          action: `the same (kind, id) also appears in ${existing.path}; give one of them a different id`,
        },
      );
    }
  }
  return [...byId.values()]
    .map(({ contentDigest: _contentDigest, ...resource }) => resource)
    .sort((a, b) => compareCodepoints(a.id, b.id));
}

type ContentAddressed = { kind: string; id: string; sha256: string; path: string };

/**
 * Deduplicate by `(kind, id)`. Identical content is one resource; two different
 * bodies with the same id are F005 naming both paths, never a silent winner.
 */
function dedupeById<T extends ContentAddressed>(kind: string, entries: T[]): T[] {
  const byId = new Map<string, T>();
  for (const entry of entries) {
    const existing = byId.get(entry.id);
    if (existing === undefined) {
      byId.set(entry.id, entry);
      continue;
    }
    if (existing.sha256 !== entry.sha256) {
      throw conflict(`two ${kind} resources share the id "${entry.id}" with different content`, {
        subject: entry.path,
        action: `the same (kind, id) also appears in ${existing.path}; give one of them a different id`,
      });
    }
  }
  return [...byId.values()].sort((a, b) => compareCodepoints(a.id, b.id));
}

function parseResourceJsonc(text: string, path: string): unknown {
  return parseJsonc(text, { subject: path });
}

async function loadCommands(repoRoot: string): Promise<CommandResource[]> {
  const dirRelative = relative(RESOURCES_DIR, COMMANDS_DIR);
  const entries = await listEntries(
    join(repoRoot, ROOT_DIR, RESOURCES_DIR, COMMANDS_DIR),
    dirRelative,
    { optional: true },
  );
  const commands: CommandResource[] = [];
  for (const entry of entries) {
    const name = entry.name;
    const path = `${dirRelative}/${name}`;
    if (!entry.isFile()) {
      throw invalidConfig('unexpected entry in resources/commands/', {
        subject: path,
        action: `a command is one ${COMMAND_FILE_EXT} file`,
      });
    }
    if (!name.endsWith(COMMAND_FILE_EXT)) {
      throw invalidConfig('unexpected file in resources/commands/', {
        subject: path,
        action: `command files use the ${COMMAND_FILE_EXT} extension`,
      });
    }
    const text = await readUtf8File(
      join(repoRoot, ROOT_DIR, RESOURCES_DIR, COMMANDS_DIR, name),
      path,
      { action: 'make the command file readable and re-run generate' },
    );
    const frontmatter = splitFrontmatter(text, path);
    const raw = parseYamlStrict(frontmatter.text, { subject: `${path}:frontmatter` });
    let parsed: CommandFrontmatter;
    try {
      parsed = commandFrontmatterSchema.parse(raw);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidConfig(describeZodError(error), { subject: `${path}:frontmatter` });
      }
      throw error;
    }
    if (frontmatter.body.trim() === '') {
      throw invalidConfig('command body is empty', {
        subject: path,
        action: 'add the command prompt after the closing frontmatter delimiter',
      });
    }
    commands.push({
      kind: 'command',
      id: parsed.id,
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      body: frontmatter.body,
      path,
      sha256: sha256Hex(
        canonicalJson({ description: parsed.description ?? null, body: frontmatter.body }),
      ),
    });
  }
  return dedupeById('command', commands);
}

async function listSkillExtraFiles(skillRoot: string, skillRelative: string): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (isOsMetadataName(entry.name)) {
        continue;
      }
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      // `SKILL.md` is the one file rewritten by the renderer; it is verified
      // structurally, not carried byte for byte.
      if (relativePath === SKILL_FILE_NAME) {
        continue;
      }
      const subject = `${skillRelative}/${relativePath}`;
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw pathUnsafe(`symlink not allowed: ${subject}`, { subject });
      }
      if (entry.isDirectory()) {
        await walk(absolute, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw invalidConfig('unexpected entry in a skill directory', {
          subject,
          action: 'a skill directory holds regular files and directories only',
        });
      }
      files.push({
        path: relativePath,
        text: await readUtf8File(absolute, subject, {
          action: 'a skill file must be UTF-8 text; re-save it as UTF-8',
        }),
      });
    }
  };
  await walk(skillRoot, '');
  return files.sort((a, b) => compareCodepoints(a.path, b.path));
}

async function loadSkills(repoRoot: string): Promise<SkillResource[]> {
  const dirRelative = relative(RESOURCES_DIR, SKILLS_DIR);
  const entries = await listEntries(
    join(repoRoot, ROOT_DIR, RESOURCES_DIR, SKILLS_DIR),
    dirRelative,
    { optional: true },
  );
  const skills: SkillResource[] = [];
  for (const entry of entries) {
    const dirName = entry.name;
    const skillRelative = `${dirRelative}/${dirName}`;
    if (!entry.isDirectory()) {
      throw invalidConfig('unexpected entry in resources/skills/', {
        subject: skillRelative,
        action: `a skill is a directory named after its id, holding ${SKILL_FILE_NAME}`,
      });
    }
    const skillRoot = join(repoRoot, ROOT_DIR, RESOURCES_DIR, SKILLS_DIR, dirName);
    // The directory itself is checked before it is listed: a symlinked skill
    // directory would otherwise compile bytes from anywhere on disk.
    await assertRealDirectory(skillRoot, skillRelative);
    const skillPath = `${skillRelative}/${SKILL_FILE_NAME}`;
    const text = await readUtf8File(join(skillRoot, SKILL_FILE_NAME), skillPath, {
      action: `a skill directory must hold ${SKILL_FILE_NAME}`,
    });
    const frontmatter = splitFrontmatter(text, skillPath);
    const raw = parseYamlStrict(frontmatter.text, { subject: `${skillPath}:frontmatter` });
    let parsed: SkillFrontmatter;
    try {
      parsed = skillFrontmatterSchema.parse(raw);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidConfig(describeZodError(error), { subject: `${skillPath}:frontmatter` });
      }
      throw error;
    }
    if (parsed.id !== dirName) {
      throw invalidConfig(`id "${parsed.id}" does not match the skill directory "${dirName}"`, {
        subject: skillPath,
        action: 'rename the directory or change the id',
      });
    }
    if (frontmatter.body.trim() === '') {
      throw invalidConfig('skill body is empty', {
        subject: skillPath,
        action: 'add the skill text after the closing frontmatter delimiter',
      });
    }
    const files = await listSkillExtraFiles(skillRoot, skillRelative);
    skills.push({
      kind: 'skill',
      id: parsed.id,
      description: parsed.description,
      body: frontmatter.body,
      files,
      path: skillPath,
      sha256: sha256Hex(
        canonicalJson({
          description: parsed.description,
          body: frontmatter.body,
          files: files.map((file) => ({ path: file.path, sha256: sha256Hex(file.text) })),
        }),
      ),
    });
  }
  return dedupeById('skill', skills);
}

/**
 * A literal in a credential position is F002. The message names the field and
 * never echoes the value; the plan never sees a secret.
 */
function assertReferencesOnly(server: McpServerDeclaration, subject: string): void {
  const fields: Record<string, unknown> | undefined =
    server.type === 'stdio' ? server.env : server.headers;
  for (const [field, value] of Object.entries(fields ?? {})) {
    if (typeof value === 'string') {
      throw secretLiteral(`a literal value is not allowed in "${field}"`, {
        subject,
        action: 'use { "fromEnv": "NAME" } so only the variable name is written, never the value',
      });
    }
  }
}

async function loadMcpResources(repoRoot: string): Promise<McpResource[]> {
  const dirRelative = relative(RESOURCES_DIR, MCP_DIR);
  const entries = await listEntries(join(repoRoot, ROOT_DIR, RESOURCES_DIR, MCP_DIR), dirRelative, {
    optional: true,
  });
  const servers: McpResource[] = [];
  for (const entry of entries) {
    const name = entry.name;
    const path = `${dirRelative}/${name}`;
    if (!entry.isFile()) {
      throw invalidConfig('unexpected entry in resources/mcp/', {
        subject: path,
        action: `an MCP server is one ${STRUCTURED_RESOURCE_FILE_EXT} file`,
      });
    }
    if (!name.endsWith(STRUCTURED_RESOURCE_FILE_EXT)) {
      throw invalidConfig('unexpected file in resources/mcp/', {
        subject: path,
        action: `MCP files use the ${STRUCTURED_RESOURCE_FILE_EXT} extension`,
      });
    }
    const text = await readUtf8File(join(repoRoot, ROOT_DIR, RESOURCES_DIR, MCP_DIR, name), path, {
      action: 'make the MCP file readable and re-run generate',
    });
    let parsed: McpDeclaration;
    try {
      parsed = mcpSchema.parse(parseResourceJsonc(text, path));
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidConfig(describeZodError(error), { subject: path });
      }
      throw error;
    }
    assertReferencesOnly(parsed.server, path);
    servers.push({
      kind: 'mcp',
      id: parsed.id,
      server: parsed.server,
      path,
      sha256: sha256Hex(canonicalJson({ server: parsed.server })),
    });
  }
  return dedupeById('mcp', servers);
}

async function loadHooks(repoRoot: string): Promise<HookResource[]> {
  const dirRelative = relative(RESOURCES_DIR, HOOKS_DIR);
  const entries = await listEntries(
    join(repoRoot, ROOT_DIR, RESOURCES_DIR, HOOKS_DIR),
    dirRelative,
    { optional: true },
  );
  const hooks: HookResource[] = [];
  for (const entry of entries) {
    const name = entry.name;
    const path = `${dirRelative}/${name}`;
    if (!entry.isFile()) {
      throw invalidConfig('unexpected entry in resources/hooks/', {
        subject: path,
        action: `a hook is one ${STRUCTURED_RESOURCE_FILE_EXT} file`,
      });
    }
    if (!name.endsWith(STRUCTURED_RESOURCE_FILE_EXT)) {
      throw invalidConfig('unexpected file in resources/hooks/', {
        subject: path,
        action: `hook files use the ${STRUCTURED_RESOURCE_FILE_EXT} extension`,
      });
    }
    const text = await readUtf8File(
      join(repoRoot, ROOT_DIR, RESOURCES_DIR, HOOKS_DIR, name),
      path,
      { action: 'make the hook file readable and re-run generate' },
    );
    let parsed: HookDeclaration;
    try {
      parsed = hookSchema.parse(parseResourceJsonc(text, path));
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidConfig(describeZodError(error), { subject: path });
      }
      throw error;
    }
    hooks.push({
      kind: 'hook',
      id: parsed.id,
      phase: parsed.phase,
      ...(parsed.matcher === undefined ? {} : { matcher: parsed.matcher }),
      command: parsed.command,
      path,
      sha256: sha256Hex(
        canonicalJson({
          phase: parsed.phase,
          matcher: parsed.matcher ?? null,
          command: parsed.command,
        }),
      ),
    });
  }
  return dedupeById('hook', hooks);
}

/** Enumerate and parse the whole source tree. A file that is present but unparsed is an error. */
export async function loadSource(repoRoot: string): Promise<SourceTree> {
  // The source root itself is checked first: a symlinked `.farna` is refused
  // even though its contents would list perfectly.
  await assertRealDirectory(join(repoRoot, ROOT_DIR), ROOT_DIR);
  await assertSupportedResourceDirs(repoRoot);
  const personas = (await loadPersonas(repoRoot)).sort((a, b) => compareCodepoints(a.id, b.id));
  const rules = (await loadRules(repoRoot)).sort((a, b) => compareCodepoints(a.id, b.id));
  const permissions = await loadPermissions(repoRoot);
  const mcp = await loadMcpResources(repoRoot);
  const skills = await loadSkills(repoRoot);
  const commands = await loadCommands(repoRoot);
  const hooks = await loadHooks(repoRoot);
  return { personas, rules, permissions, mcp, skills, commands, hooks };
}
