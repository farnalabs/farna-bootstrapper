import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ZodError } from 'zod';
import {
  isOsMetadataName,
  PERMISSION_FILE_EXT,
  PERMISSIONS_DIR,
  PERSONA_FILE_EXT,
  PERSONAS_DIR,
  RESOURCES_DIR,
  ROOT_DIR,
  RULE_FILE_EXT,
  RULES_DIR,
} from '../core/constants.js';
import { conflict, invalidConfig, pathUnsafe } from '../core/errors.js';
import { readUtf8File } from '../core/fs.js';
import { compareCodepoints, parseJsonc } from '../core/json.js';
import { assertRealDirectory } from '../core/paths.js';
import { permissionResourceDigest } from '../permissions/permissions.js';
import { splitFrontmatter } from './frontmatter.js';
import {
  type PermissionDeclaration,
  type PersonaDeclaration,
  permissionSchema,
  personaSchema,
  type RuleFrontmatter,
  ruleFrontmatterSchema,
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

export type LoadedPersona = PersonaDeclaration & {
  /** Repository-relative path, for messages. */
  path: string;
};

export type SourceTree = {
  personas: LoadedPersona[];
  rules: RuleResource[];
  permissions: PermissionResource[];
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

/** Only the resource kinds this milestone implements may exist on disk. */
const SUPPORTED_RESOURCE_DIRS: readonly string[] = [RULES_DIR, PERMISSIONS_DIR];

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

/** Enumerate and parse the whole source tree. A file that is present but unparsed is an error. */
export async function loadSource(repoRoot: string): Promise<SourceTree> {
  // The source root itself is checked first: a symlinked `.farna` is refused
  // even though its contents would list perfectly.
  await assertRealDirectory(join(repoRoot, ROOT_DIR), ROOT_DIR);
  await assertSupportedResourceDirs(repoRoot);
  const personas = (await loadPersonas(repoRoot)).sort((a, b) => compareCodepoints(a.id, b.id));
  const rules = (await loadRules(repoRoot)).sort((a, b) => compareCodepoints(a.id, b.id));
  const permissions = await loadPermissions(repoRoot);
  return { personas, rules, permissions };
}
