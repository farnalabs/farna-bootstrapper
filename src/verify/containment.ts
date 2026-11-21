import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { ResolvedPersona, ResolvedSource } from '../compose/resolve.js';
import { AGENT_FILE_EXT, CLAUDE_AGENTS_DIR } from '../core/constants.js';
import { declaredNotEmitted } from '../core/errors.js';
import { readUtf8File } from '../core/fs.js';
import { compareCodepoints } from '../core/json.js';
import { lstatOrUndefined } from '../core/paths.js';
import { emitsTools, personaBody } from '../materialise/source-tree.js';
import type { RenderResult } from '../render/port.js';

export function expectedAgentPath(personaId: string): string {
  return `${CLAUDE_AGENTS_DIR}/${personaId}${AGENT_FILE_EXT}`;
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

/** The exact set of frontmatter keys this persona is allowed to emit. */
function expectedFrontmatterKeys(persona: ResolvedPersona): Set<string> {
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

/**
 * Assert the emitted key set is exactly the declared one. A renderer that adds
 * a harness directive the persona never declared (`permissionMode`, `hooks`,
 * `maxTurns`, ...) is adding a capability, not just losing one, and must be
 * refused in the same way.
 */
function assertKeySet(
  persona: ResolvedPersona,
  emitted: Record<string, unknown>,
  subject: string,
): void {
  const expected = expectedFrontmatterKeys(persona);
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
 * The containment gate. Every expected artefact is a non-empty file whose
 * frontmatter key set and values equal the resolved persona, and whose body is
 * exactly the persona's composed body (one trailing newline normalised).
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
  const expected = source.personas.map((persona) => expectedAgentPath(persona.id)).sort();
  const emitted = [...render.files].sort(compareCodepoints);

  const verified = new Map<string, string>();
  for (const path of expected) {
    if (!emitted.includes(path)) {
      throw declaredNotEmitted('declared persona produced no artefact', {
        subject: path,
        action: 'the renderer did not emit this file; nothing was written',
      });
    }
  }
  for (const path of emitted) {
    if (!expected.includes(path)) {
      throw declaredNotEmitted('renderer emitted an unexpected path', {
        subject: path,
        action: 'the expected path set is one agent file per persona',
      });
    }
  }

  for (const persona of source.personas) {
    const managedPath = expectedAgentPath(persona.id);
    const absolute = join(outputRoot, managedPath);
    // The renderer's own path list is not evidence that it wrote anything.
    const stats = await lstatOrUndefined(absolute);
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
    assertKeySet(persona, parsed.frontmatter, managedPath);
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
    for (const rule of persona.rules) {
      if (!parsed.body.includes(rule.body.trim())) {
        throw declaredNotEmitted(`declared rule "${rule.id}" is absent from the artefact`, {
          subject: `${managedPath} (persona ${persona.id})`,
          action: 'the renderer dropped declared content; nothing was written',
        });
      }
    }

    const composed = personaBody(persona);
    // Run the leak scan on the whole body, not only after a mismatch, and skip
    // a body this persona legitimately contains through composition: a base
    // persona's composed body is a prefix of the derived persona's body.
    for (const other of source.personas) {
      if (other.id === persona.id) {
        continue;
      }
      const otherBody = personaBody(other);
      if (otherBody === '' || otherBody === composed || composed.includes(otherBody)) {
        continue;
      }
      if (parsed.body.includes(otherBody)) {
        throw declaredNotEmitted(`persona ${other.id}'s content leaked into ${persona.id}`, {
          subject: managedPath,
          action: 'the renderer mixed persona content; nothing was written',
        });
      }
    }

    if (!bodiesMatch(parsed.body, composed)) {
      throw declaredNotEmitted('emitted body does not match the composed persona body', {
        subject: managedPath,
        action:
          'the renderer added or changed content the persona does not declare; nothing was written',
      });
    }
    verified.set(managedPath, text);
  }
  return verified;
}
