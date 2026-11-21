import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { ResolvedPersona, ResolvedSource } from '../compose/resolve.js';
import { CLAUDE_AGENTS_DIR } from '../core/constants.js';
import { declaredNotEmitted } from '../core/errors.js';
import { compareCodepoints } from '../core/json.js';
import { lstatOrUndefined } from '../core/paths.js';
import { personaBody } from '../materialise/source-tree.js';
import type { RenderResult } from '../render/port.js';

export function expectedAgentPath(personaId: string): string {
  return `${CLAUDE_AGENTS_DIR}/${personaId}.md`;
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

function assertFrontmatter(persona: ResolvedPersona, emitted: EmittedAgent, subject: string): void {
  assertField(emitted.frontmatter, 'name', persona.id, subject, persona);
  assertField(emitted.frontmatter, 'description', persona.purpose, subject, persona);
  assertField(emitted.frontmatter, 'model', persona.model, subject, persona);
  assertField(
    emitted.frontmatter,
    'tools',
    persona.claude.allow.length === 0 ? undefined : persona.claude.allow,
    subject,
    persona,
  );
  assertField(
    emitted.frontmatter,
    'disallowedTools',
    persona.claude.deny.length === 0 ? undefined : persona.claude.deny,
    subject,
    persona,
  );
}

/**
 * The containment gate. Containment means equality, not substring presence:
 * every expected artefact is a non-empty file whose frontmatter equals the
 * resolved persona and whose body ends with the persona's whole composed body.
 * File existence alone is not containment, and neither is "the right words
 * appear somewhere".
 */
export async function verifyRender(
  source: ResolvedSource,
  render: RenderResult,
  outputRoot: string,
): Promise<void> {
  const expected = source.personas.map((persona) => expectedAgentPath(persona.id)).sort();
  const emitted = [...render.files].sort(compareCodepoints);

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

  const contents = new Map<string, EmittedAgent>();
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
    const text = await readFile(absolute, 'utf8');
    if (text.length === 0) {
      throw declaredNotEmitted('rendered artefact is empty', {
        subject: managedPath,
        action: 'an empty agent file declares no persona; nothing was written',
      });
    }
    const parsed = parseEmittedAgent(text, managedPath);
    assertFrontmatter(persona, parsed, managedPath);
    for (const rule of persona.rules) {
      if (!parsed.body.includes(rule.body.trim())) {
        throw declaredNotEmitted(`declared rule "${rule.id}" is absent from the artefact`, {
          subject: `${managedPath} (persona ${persona.id})`,
          action: 'the renderer dropped declared content; nothing was written',
        });
      }
    }
    contents.set(managedPath, parsed);
  }

  for (const persona of source.personas) {
    const managedPath = expectedAgentPath(persona.id);
    const parsed = contents.get(managedPath);
    if (parsed === undefined) {
      throw declaredNotEmitted('missing artefact', { subject: managedPath });
    }
    const composed = personaBody(persona);
    if (!parsed.body.endsWith(composed)) {
      // A whole-body suffix failure is usually a foreign body appended to this
      // one. Name the owner rather than only saying "the body is wrong". The
      // check compares composed bodies, never individual rule substrings, so a
      // legitimate rule that quotes another rule's words is not a leak.
      for (const other of source.personas) {
        if (other.id === persona.id) {
          continue;
        }
        const otherBody = personaBody(other);
        if (otherBody.trim() !== '' && parsed.body.endsWith(otherBody)) {
          throw declaredNotEmitted(`persona ${other.id}'s content leaked into ${persona.id}`, {
            subject: managedPath,
            action: 'the renderer mixed persona content; nothing was written',
          });
        }
      }
      throw declaredNotEmitted('emitted body does not end with the composed persona body', {
        subject: managedPath,
        action:
          'the renderer added or changed content the persona does not declare; nothing was written',
      });
    }
  }
}
