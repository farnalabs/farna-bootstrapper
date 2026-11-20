import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedSource } from '../compose/resolve.js';
import { CLAUDE_AGENTS_DIR } from '../core/constants.js';
import { declaredNotEmitted } from '../core/errors.js';
import { compareCodepoints } from '../core/json.js';
import type { RenderResult } from '../render/port.js';

export function expectedAgentPath(personaId: string): string {
  return `${CLAUDE_AGENTS_DIR}/${personaId}.md`;
}

function ruleOwners(source: ResolvedSource): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const persona of source.personas) {
    for (const rule of persona.rules) {
      const set = owners.get(rule.id) ?? new Set<string>();
      set.add(persona.id);
      owners.set(rule.id, set);
    }
  }
  return owners;
}

/**
 * The containment gate. Every persona must carry all of its own rule text,
 * and a rule used by exactly one persona must be absent from every other
 * persona's artefact. File existence alone is not containment.
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

  const contents = new Map<string, string>();
  for (const path of expected) {
    contents.set(path, await readFile(join(outputRoot, path), 'utf8'));
  }

  for (const persona of source.personas) {
    const content = contents.get(expectedAgentPath(persona.id));
    if (content === undefined) {
      throw declaredNotEmitted('missing artefact', { subject: expectedAgentPath(persona.id) });
    }
    for (const rule of persona.rules) {
      if (!content.includes(rule.body.trim())) {
        throw declaredNotEmitted(`declared rule "${rule.id}" is absent from the artefact`, {
          subject: `${expectedAgentPath(persona.id)} (persona ${persona.id})`,
          action: 'the renderer dropped declared content; nothing was written',
        });
      }
    }
  }

  const owners = ruleOwners(source);
  for (const persona of source.personas) {
    for (const other of source.personas) {
      if (other.id === persona.id) {
        continue;
      }
      const otherContent = contents.get(expectedAgentPath(other.id));
      if (otherContent === undefined) {
        continue;
      }
      for (const rule of persona.rules) {
        if ((owners.get(rule.id)?.size ?? 0) !== 1) {
          continue;
        }
        if (otherContent.includes(rule.body.trim())) {
          throw declaredNotEmitted(
            `persona ${persona.id}'s rule "${rule.id}" leaked into ${other.id}`,
            {
              subject: expectedAgentPath(other.id),
              action: 'the renderer mixed persona content; nothing was written',
            },
          );
        }
      }
    }
  }
}
