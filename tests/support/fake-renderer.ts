import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { compareCodepoints } from '../../src/core/json.js';
import type {
  RendererIdentity,
  RenderRequest,
  RenderResult,
  RenderTarget,
  RenderTargetName,
} from '../../src/render/port.js';

export type FakeMode =
  | { kind: 'ok' }
  | { kind: 'drop-body'; persona: string }
  | { kind: 'drop-file'; persona: string }
  | { kind: 'leak'; from: string; into: string }
  | { kind: 'extra-file' };

type SourceDoc = {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
};

async function readSources(sourceRoot: string): Promise<SourceDoc[]> {
  const dir = join(sourceRoot, 'subagents');
  const names = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort(compareCodepoints);
  const docs: SourceDoc[] = [];
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8');
    const normalised = text.replace(/\r\n/g, '\n');
    const close = normalised.indexOf('\n---', 4);
    const frontmatter = parse(normalised.slice(4, close)) as Record<string, unknown>;
    const bodyStart = normalised.indexOf('\n', close + 4);
    const body = bodyStart === -1 ? '' : normalised.slice(bodyStart + 1);
    docs.push({ name: String(frontmatter['name']), frontmatter, body });
  }
  return docs;
}

function renderAgent(doc: SourceDoc): string {
  const claudecode = doc.frontmatter['claudecode'] as
    | { model?: string; tools?: string[]; disallowedTools?: string[] }
    | undefined;
  const frontmatter: Record<string, unknown> = {
    name: doc.name,
    description: doc.frontmatter['description'],
    ...(claudecode?.model === undefined ? {} : { model: claudecode.model }),
    ...(claudecode?.tools === undefined ? {} : { tools: claudecode.tools }),
    ...(claudecode?.disallowedTools === undefined
      ? {}
      : { disallowedTools: claudecode.disallowedTools }),
  };
  return `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n${doc.body}`;
}

/**
 * A deliberately independent renderer used by the unit tests. It reads the
 * same source shape as the real renderer and writes Claude Code agent files.
 * Modes simulate the failure classes the port exists to catch.
 */
export class FakeRenderTarget implements RenderTarget {
  readonly name: RenderTargetName = 'claudecode';

  constructor(private readonly mode: FakeMode = { kind: 'ok' }) {}

  identity(): RendererIdentity {
    return {
      name: 'fake-renderer',
      version: '0.0.0-test',
      integrity: 'sha512-fake',
    };
  }

  async generate(request: RenderRequest): Promise<RenderResult> {
    const mode = this.mode;
    const docs = await readSources(request.sourceRoot);
    const agentsDir = join(request.outputRoot, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });

    const files: string[] = [];
    for (const doc of docs) {
      if (mode.kind === 'drop-file' && mode.persona === doc.name) {
        continue;
      }
      let body = doc.body;
      if (mode.kind === 'drop-body' && mode.persona === doc.name) {
        body = '';
      }
      if (mode.kind === 'leak' && mode.into === doc.name) {
        const donor = docs.find((candidate) => candidate.name === mode.from);
        if (donor !== undefined) {
          body = `${body}\n${donor.body}`;
        }
      }
      const path = `.claude/agents/${doc.name}.md`;
      await writeFile(join(request.outputRoot, path), renderAgent({ ...doc, body }), 'utf8');
      files.push(path);
    }

    if (mode.kind === 'extra-file') {
      const path = '.claude/agents/extra.md';
      await writeFile(join(request.outputRoot, path), '---\nname: extra\n---\n', 'utf8');
      files.push(path);
    }

    return {
      target: request.target,
      files: files.sort(compareCodepoints),
      sourceLoadFailed: false,
    };
  }
}
