import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareManagedFile, unproducedEntryDrift } from '../../src/cli/commands/check.js';
import {
  assertOwnership,
  mergePlannedFiles,
  runGenerate,
} from '../../src/cli/commands/generate.js';
import type { ResolvedSource } from '../../src/compose/resolve.js';
import { configuredLocationClaims, findLocationCollisions } from '../../src/config/collision.js';
import { loadConfig } from '../../src/config/load.js';
import { PROFILE_TARGETS } from '../../src/core/constants.js';
import type { FarnaError } from '../../src/core/errors.js';
import { sha256Hex } from '../../src/core/json.js';
import {
  entryKey,
  type LockFileEntry,
  type RenderedFile,
  readLockfile,
} from '../../src/lock/lockfile.js';
import { renderFeatures } from '../../src/materialise/source-tree.js';
import type { ManagedTarget } from '../../src/render/commit.js';
import { isManagedOutputPath, planOrphans, removeOrphans } from '../../src/render/orphans.js';
import type { RenderRequest, RenderResult } from '../../src/render/port.js';
import { annotateOwnership } from '../../src/render/prepare.js';
import {
  regionBeginMarker,
  regionBlock,
  regionEndMarker,
  regionEntryKey,
} from '../../src/render/region.js';
import { FakeRenderTarget } from '../support/fake-renderer.js';
import { createTempRepo, listFiles } from '../support/temp-repo.js';

const PATH = 'CLAUDE.md';
const ID = 'claude-instructions';
const BODY = '## House style\n\nWrite the smallest change.\n';

function capturedError(run: () => unknown): FarnaError {
  try {
    run();
  } catch (error) {
    return error as FarnaError;
  }
  throw new Error('expected the call to throw');
}

/** A region file as `prepare` annotates it, with the body as its rendered bytes. */
function regionFile(body = BODY): RenderedFile {
  return {
    path: PATH,
    bytes: body,
    shape: 'region',
    regionId: ID,
    ownedSha256: sha256Hex(body),
    ownedSize: Buffer.byteLength(body),
  };
}

/** The lockfile entry a recorded region body produces. */
function regionEntry(body = BODY): LockFileEntry {
  return {
    path: PATH,
    sha256: sha256Hex(body),
    size: Buffer.byteLength(body),
    shape: 'region',
    regionId: ID,
  };
}

function inspected(root: string, bytes: string | undefined): Map<string, ManagedTarget> {
  const map = new Map<string, ManagedTarget>();
  if (bytes !== undefined) {
    map.set(PATH, { path: PATH, target: join(root, PATH), existing: Buffer.from(bytes, 'utf8') });
  }
  return map;
}

/** A shared instruction file with user prose before and after the region. */
function markedFile(body = 'old\n'): string {
  return `# Team notes\n\nSome user prose.\n\n${regionBeginMarker(ID)}\n${body}${regionEndMarker(ID)}\n\nMore user prose.\n`;
}

async function tempRepoWith(text: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const repo = await createTempRepo();
  await writeFile(join(repo.root, PATH), text, 'utf8');
  return repo;
}

describe('prepare annotates a region file', () => {
  it('records the region id and the digest of the body it will write', () => {
    const annotated = annotateOwnership({ path: PATH, bytes: 'body' });
    expect(annotated.shape).toBe('region');
    expect(annotated.regionId).toBe(ID);
    expect(annotated.bytes).toBe('body\n');
    expect(annotated.ownedSha256).toBe(sha256Hex('body\n'));
    expect(annotated.ownedSize).toBe(5);
  });

  it('leaves a whole file with no shape', () => {
    const annotated = annotateOwnership({ path: '.claude/agents/builder.md', bytes: 'agent\n' });
    expect(annotated).toEqual({ path: '.claude/agents/builder.md', bytes: 'agent\n' });
  });

  it('still annotates a structured file by the keys it owns', () => {
    const annotated = annotateOwnership({ path: 'opencode.jsonc', bytes: '{\n  "mcp": {}\n}\n' });
    expect(annotated.shape).toBe('structured');
    expect(annotated.ownedKeys).toEqual(['mcp']);
    expect(annotated.regionId).toBeUndefined();
  });

  it('refuses a rendered body that already carries a marker', () => {
    const error = capturedError(() =>
      annotateOwnership({ path: PATH, bytes: `rule\n${regionBeginMarker(ID)}\n` }),
    );
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.subject).toBe(PATH);
  });
});

describe('generate takes ownership of a region by its key', () => {
  it('refuses an existing unrecorded region file and names --adopt', () => {
    const error = capturedError(() =>
      assertOwnership([regionFile()], inspected('/repo', 'user prose\n'), new Set(), false),
    );
    expect(error.code).toBe('F007_DRIFT');
    expect(error.subject).toBe(PATH);
    expect(error.action).toContain('generate --adopt');
  });

  it('refuses even when the existing body already equals the fresh render', () => {
    // A region file is never adopted by byte equality: the markers are not
    // proof this tool wrote the surrounding bytes.
    const error = capturedError(() =>
      assertOwnership([regionFile()], inspected('/repo', markedFile(BODY)), new Set(), false),
    );
    expect(error.code).toBe('F007_DRIFT');
  });

  it('accepts a recorded region entry', () => {
    expect(() =>
      assertOwnership(
        [regionFile()],
        inspected('/repo', 'user prose\n'),
        new Set([regionEntryKey(PATH, ID)]),
        false,
      ),
    ).not.toThrow();
  });

  it('accepts --adopt and an absent file', () => {
    expect(() =>
      assertOwnership([regionFile()], inspected('/repo', 'user prose\n'), new Set(), true),
    ).not.toThrow();
    expect(() =>
      assertOwnership([regionFile()], inspected('/repo', undefined), new Set(), false),
    ).not.toThrow();
  });

  it('keeps the whole-file rule: an unrecorded file that differs is refused', () => {
    const whole: RenderedFile = { path: '.claude/agents/builder.md', bytes: 'agent\n' };
    const map = new Map<string, ManagedTarget>([
      [whole.path, { path: whole.path, target: '/repo/x', existing: Buffer.from('other\n') }],
    ]);
    expect(() => assertOwnership([whole], map, new Set(), false)).toThrow();
    expect(() =>
      assertOwnership(
        [whole],
        new Map<string, ManagedTarget>([
          [whole.path, { path: whole.path, target: '/repo/x', existing: Buffer.from('agent\n') }],
        ]),
        new Set(),
        false,
      ),
    ).not.toThrow();
  });
});

describe('generate merges a region into the file it occupies', () => {
  it('creates the marker pair when the file is absent', () => {
    const [planned] = mergePlannedFiles(
      [regionFile()],
      inspected('/repo', undefined),
      new Set(),
      false,
    );
    expect(planned?.bytes).toBe(regionBlock(ID, BODY));
  });

  it('replaces the body of a recorded region and keeps every byte outside it', () => {
    const existing = markedFile('an older instruction\n');
    const [planned] = mergePlannedFiles(
      [regionFile()],
      inspected('/repo', existing),
      new Set([regionEntryKey(PATH, ID)]),
      false,
    );
    expect(planned?.bytes).toContain(BODY);
    expect(planned?.bytes).not.toContain('an older instruction');
    expect(planned?.bytes.startsWith('# Team notes\n\nSome user prose.\n\n')).toBe(true);
    expect(planned?.bytes.endsWith('\n\nMore user prose.\n')).toBe(true);
  });

  it('appends one blank line to an unmarked file on adopt', () => {
    const [planned] = mergePlannedFiles(
      [regionFile()],
      inspected('/repo', '# Team notes\n'),
      new Set(),
      true,
    );
    expect(planned?.bytes).toBe(`# Team notes\n\n${regionBlock(ID, BODY)}`);
  });

  it('refuses an unrecorded existing file without --adopt', () => {
    const error = capturedError(() =>
      mergePlannedFiles([regionFile()], inspected('/repo', markedFile()), new Set(), false),
    );
    expect(error.code).toBe('F007_DRIFT');
  });
});

describe('check compares the region body, never the whole file', () => {
  it('passes when only the user bytes outside the region changed', async () => {
    const repo = await tempRepoWith(markedFile(BODY));
    try {
      await writeFile(join(repo.root, PATH), `${markedFile(BODY)}\nuser addition\n`, 'utf8');
      expect(await compareManagedFile(repo.root, regionFile())).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it('reports an edited body as modified drift', async () => {
    const repo = await tempRepoWith(markedFile('an edit by the user\n'));
    try {
      const item = await compareManagedFile(repo.root, regionFile());
      expect(item).toMatchObject({ path: PATH, kind: 'modified' });
      expect(item?.detail).toContain(`region "${ID}" differs from a fresh render`);
    } finally {
      await repo.cleanup();
    }
  });

  it('reports a removed region as missing drift while the file remains', async () => {
    const repo = await tempRepoWith('# Team notes\n\nNo region here.\n');
    try {
      const item = await compareManagedFile(repo.root, regionFile());
      expect(item).toEqual({
        code: 'F007_DRIFT',
        path: PATH,
        kind: 'missing',
        detail: 'the managed region is missing',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a malformed region with F001 rather than reporting drift', async () => {
    const repo = await tempRepoWith(`# Notes\n${regionBeginMarker(ID)}\nbody\n`);
    try {
      await expect(compareManagedFile(repo.root, regionFile())).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: PATH,
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a CRLF region file naming the line', async () => {
    const repo = await tempRepoWith(`# Notes\r\n${regionBeginMarker(ID)}\r\nbody\r\n`);
    try {
      await expect(compareManagedFile(repo.root, regionFile())).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        message: expect.stringContaining('line 1 ends in CR'),
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('still compares a whole file by its bytes', async () => {
    const repo = await createTempRepo();
    try {
      await mkdir(join(repo.root, '.claude/agents'), { recursive: true });
      await writeFile(join(repo.root, '.claude/agents/extra.md'), 'a\n', 'utf8');
      const whole: RenderedFile = { path: '.claude/agents/extra.md', bytes: 'b\n' };
      expect(await compareManagedFile(repo.root, whole)).toMatchObject({
        path: whole.path,
        kind: 'modified',
      });
    } finally {
      await repo.cleanup();
    }
  });
});

describe('the recorded set is keyed by path and region id', () => {
  it('reports a removed region while the file remains for another region', () => {
    const alpha: LockFileEntry = { ...regionEntry('a\n'), regionId: 'alpha' };
    const beta: LockFileEntry = { ...regionEntry('b\n'), regionId: 'beta' };
    const drift = unproducedEntryDrift(
      [{ targetId: 'claudecode', files: [alpha, beta] }],
      new Set([entryKey(alpha)]),
    );
    expect(drift.map((entry) => entry.item.path)).toEqual([PATH]);
    expect(drift[0]?.item.detail).toContain('region "beta"');
    expect(drift[0]?.targetId).toBe('claudecode');
  });

  it('reports a recorded whole path that is no longer produced', () => {
    const entry: LockFileEntry = {
      path: '.claude/agents/gone.md',
      sha256: sha256Hex('x'),
      size: 1,
    };
    const drift = unproducedEntryDrift([{ targetId: 'claudecode', files: [entry] }], new Set());
    expect(drift).toHaveLength(1);
    expect(drift[0]?.item.detail).toContain('no longer produced by this source');
    expect(drift[0]?.item.detail).not.toContain('region');
  });
});

describe('an orphaned region is stripped, not the whole file', () => {
  it('keeps the user prose and removes the marker pair and body', async () => {
    const text = `# Team notes\n\n${regionBlock(ID, BODY)}tail\n`;
    const repo = await tempRepoWith(text);
    try {
      const plan = await planOrphans(repo.root, [regionEntry()], new Set());
      expect(plan.map((entry) => entry.action)).toEqual(['rewrite']);
      await removeOrphans(repo.root, plan);
      const after = await readFile(join(repo.root, PATH), 'utf8');
      expect(after).toBe('# Team notes\n\ntail\n');
      expect(after).not.toContain(regionBeginMarker(ID));
    } finally {
      await repo.cleanup();
    }
  });

  it('removes the file when nothing but the region remained', async () => {
    const repo = await tempRepoWith(regionBlock(ID, BODY));
    try {
      const plan = await planOrphans(repo.root, [regionEntry()], new Set());
      expect(plan.map((entry) => entry.action)).toEqual(['remove']);
      await removeOrphans(repo.root, plan);
      expect(await listFiles(repo.root)).not.toContain(PATH);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses to strip a body that no longer matches the record', async () => {
    const repo = await tempRepoWith(regionBlock(ID, 'edited by the user\n'));
    try {
      await expect(planOrphans(repo.root, [regionEntry()], new Set())).rejects.toMatchObject({
        code: 'F007_DRIFT',
        subject: PATH,
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('drops the record without touching a file whose region is already gone', async () => {
    const repo = await tempRepoWith('# Team notes\n\nNo region.\n');
    try {
      expect(await planOrphans(repo.root, [regionEntry()], new Set())).toEqual([]);
      expect(await readFile(join(repo.root, PATH), 'utf8')).toBe('# Team notes\n\nNo region.\n');
    } finally {
      await repo.cleanup();
    }
  });

  it('strips only the region the plan no longer produces', async () => {
    const alpha: LockFileEntry = { ...regionEntry('a\n'), regionId: 'alpha' };
    const beta: LockFileEntry = { ...regionEntry('b\n'), regionId: 'beta' };
    const text = `${regionBlock('alpha', 'a\n')}${regionBlock('beta', 'b\n')}`;
    const repo = await tempRepoWith(text);
    try {
      const plan = await planOrphans(repo.root, [alpha, beta], new Set([entryKey(alpha)]));
      expect(plan.map((entry) => entry.entry.regionId)).toEqual(['beta']);
      await removeOrphans(repo.root, plan);
      expect(await readFile(join(repo.root, PATH), 'utf8')).toBe(regionBlock('alpha', 'a\n'));
    } finally {
      await repo.cleanup();
    }
  });

  it('claims CLAUDE.md as a managed location so an orphan can be removed', () => {
    expect(isManagedOutputPath(PATH)).toBe(true);
  });
});

describe('a region is emitted only by a profile render', () => {
  it('writes no region entry and no CLAUDE.md from the demo fixture in agent mode', async () => {
    const repo = await createTempRepo();
    try {
      await runGenerate({ cwd: repo.root, dryRun: false }, new FakeRenderTarget());
      const lock = await readLockfile(repo.root);
      const entries = Object.values(lock?.targets ?? {}).flatMap((target) => target.files);
      expect(entries.some((entry) => entry.shape === 'region')).toBe(false);
      expect(entries.every((entry) => entry.regionId === undefined)).toBe(true);
      expect(entries.map((entry) => entry.path)).toEqual([
        '.claude/agents/builder.md',
        '.claude/agents/reviewer.md',
      ]);
      expect(await listFiles(repo.root)).not.toContain(PATH);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a renderer that invents CLAUDE.md at the containment gate', async () => {
    class RegionEmittingRenderTarget extends FakeRenderTarget {
      override async generate(request: RenderRequest): Promise<RenderResult> {
        const result = await super.generate(request);
        await writeFile(join(request.outputRoot, PATH), 'Region body\n', 'utf8');
        return { ...result, files: [...result.files, PATH].sort() };
      }
    }
    const repo = await createTempRepo();
    try {
      await expect(
        runGenerate({ cwd: repo.root, dryRun: false }, new RegionEmittingRenderTarget()),
      ).rejects.toMatchObject({ code: 'F008_DECLARED_NOT_EMITTED', subject: PATH });
      const files = await listFiles(repo.root);
      expect(files).not.toContain(PATH);
      expect(files).not.toContain('.farna/lock.json');
    } finally {
      await repo.cleanup();
    }
  });

  it('puts claudecode in profile mode and asks for the features it declares there', () => {
    const agent = {
      target: 'claudecode',
      mode: 'agent',
      personas: [{ rules: [] }, { rules: [] }],
      mcp: [],
      skills: [],
      commands: [],
      hooks: [],
    } as unknown as ResolvedSource;
    expect(PROFILE_TARGETS as readonly string[]).toContain('claudecode');
    // Agent mode is one subagent per persona and no workspace surface.
    expect(renderFeatures('claudecode', agent)).toEqual(['subagents']);

    const profile = {
      target: 'claudecode',
      mode: 'profile',
      personas: [{ rules: [{}] }],
      mcp: [{}],
      skills: [],
      commands: [],
      hooks: [{ carried: true }],
    } as unknown as ResolvedSource;
    expect(renderFeatures('claudecode', profile)).toEqual(['subagents', 'rules', 'mcp', 'hooks']);

    const ruleOnly = {
      target: 'claudecode',
      mode: 'profile',
      personas: [{ rules: [{}] }],
      mcp: [],
      skills: [],
      commands: [],
      hooks: [{ carried: false }],
    } as unknown as ResolvedSource;
    expect(renderFeatures('claudecode', ruleOnly)).toEqual(['subagents', 'rules']);
  });

  it('claims CLAUDE.md for claudecode alone, so a second claimant is a collision', async () => {
    const repo = await createTempRepo();
    try {
      const claims = configuredLocationClaims(await loadConfig(repo.root));
      expect(claims.claudecode).toContain(PATH);
      expect(
        findLocationCollisions({ ...claims, synthetic: [PATH] }).map((entry) => entry.location),
      ).toEqual([PATH]);
    } finally {
      await repo.cleanup();
    }
  });
});
