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

type ClaudeBlock = { model?: string; tools?: string[]; disallowedTools?: string[] };

export type FakeMode =
  | { kind: 'ok' }
  | { kind: 'drop-body'; persona: string }
  | { kind: 'drop-file'; persona: string }
  | { kind: 'leak'; from: string; into: string }
  | { kind: 'extra-file' }
  | { kind: 'drop-tools'; persona: string }
  | { kind: 'drop-deny'; persona: string }
  | { kind: 'invent-tools'; persona: string }
  | { kind: 'invent-frontmatter'; persona: string; key: string; value: unknown }
  | { kind: 'swap-tools'; from: string; into: string }
  | { kind: 'inject-body'; persona: string; text: string }
  | { kind: 'prepend-body'; persona: string; text: string }
  | { kind: 'prepend-foreign-body'; from: string; into: string }
  | { kind: 'empty' }
  | { kind: 'list-only' };

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
    // The source file lays the body out after one blank separator line; the
    // real renderer drops it, so the fake must too or its output would carry a
    // leading newline the composed body never has.
    const body = bodyStart === -1 ? '' : normalised.slice(bodyStart + 1).replace(/^\n/, '');
    docs.push({ name: String(frontmatter['name']), frontmatter, body });
  }
  return docs;
}

function claudeBlock(doc: SourceDoc): ClaudeBlock {
  const block = doc.frontmatter['claudecode'];
  return typeof block === 'object' && block !== null ? (block as ClaudeBlock) : {};
}

function renderAgent(
  doc: SourceDoc,
  block: ClaudeBlock,
  body: string,
  extraFrontmatter: Record<string, unknown> = {},
): string {
  const frontmatter: Record<string, unknown> = {
    name: doc.name,
    description: doc.frontmatter['description'],
    ...(block.model === undefined ? {} : { model: block.model }),
    ...(block.tools === undefined ? {} : { tools: block.tools }),
    ...(block.disallowedTools === undefined ? {} : { disallowedTools: block.disallowedTools }),
    ...extraFrontmatter,
  };
  return `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n${body}`;
}

/**
 * A deliberately independent renderer used by the unit tests. It reads the
 * same source shape as the real renderer and writes Claude Code agent files.
 * Modes simulate the failure classes the port exists to catch, including every
 * way a renderer can weaken or invent a permission.
 */
export class FakeRenderTarget implements RenderTarget {
  readonly name: RenderTargetName = 'claudecode';

  constructor(
    private readonly mode: FakeMode = { kind: 'ok' },
    private readonly identityOverride?: RendererIdentity,
  ) {}

  identity(): RendererIdentity {
    return (
      this.identityOverride ?? {
        name: 'fake-renderer',
        version: '0.0.0-test',
        integrity: 'sha512-fake',
      }
    );
  }

  async generate(request: RenderRequest): Promise<RenderResult> {
    const mode = this.mode;
    const docs = await readSources(request.sourceRoot);
    const agentsDir = join(request.outputRoot, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });

    if (mode.kind === 'list-only') {
      return {
        target: request.target,
        files: docs.map((doc) => `.claude/agents/${doc.name}.md`).sort(compareCodepoints),
        sourceLoadFailed: false,
      };
    }

    const swapFrom = mode.kind === 'swap-tools' ? mode.from : undefined;
    const donor = swapFrom === undefined ? undefined : docs.find((doc) => doc.name === swapFrom);
    const files: string[] = [];
    for (const doc of docs) {
      if (mode.kind === 'drop-file' && mode.persona === doc.name) {
        continue;
      }
      let body = doc.body;
      const block: ClaudeBlock = { ...claudeBlock(doc) };
      if (mode.kind === 'drop-body' && mode.persona === doc.name) {
        body = '';
      }
      if (mode.kind === 'leak' && mode.into === doc.name) {
        const donorDoc = docs.find((candidate) => candidate.name === mode.from);
        if (donorDoc !== undefined) {
          body = `${body}\n${donorDoc.body}`;
        }
      }
      if (mode.kind === 'drop-tools' && mode.persona === doc.name) {
        delete block.tools;
      }
      if (mode.kind === 'drop-deny' && mode.persona === doc.name) {
        delete block.disallowedTools;
      }
      if (mode.kind === 'invent-tools' && mode.persona === doc.name) {
        block.tools = ['Read'];
      }
      if (mode.kind === 'swap-tools' && mode.into === doc.name && donor !== undefined) {
        const donorBlock = claudeBlock(donor);
        if (donorBlock.tools === undefined) {
          delete block.tools;
        } else {
          block.tools = donorBlock.tools;
        }
        if (donorBlock.disallowedTools === undefined) {
          delete block.disallowedTools;
        } else {
          block.disallowedTools = donorBlock.disallowedTools;
        }
      }
      if (mode.kind === 'inject-body' && mode.persona === doc.name) {
        body = `${body}\n${mode.text}\n`;
      }
      if (mode.kind === 'prepend-body' && mode.persona === doc.name) {
        body = `${mode.text}\n\n${body}`;
      }
      if (mode.kind === 'prepend-foreign-body' && mode.into === doc.name) {
        const donorDoc = docs.find((candidate) => candidate.name === mode.from);
        if (donorDoc !== undefined) {
          body = `${donorDoc.body}\n\n${body}`;
        }
      }
      const extraFrontmatter =
        mode.kind === 'invent-frontmatter' && mode.persona === doc.name
          ? { [mode.key]: mode.value }
          : {};
      const path = `.claude/agents/${doc.name}.md`;
      const value = mode.kind === 'empty' ? '' : renderAgent(doc, block, body, extraFrontmatter);
      await writeFile(join(request.outputRoot, path), value, 'utf8');
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
