import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedSource } from '../../src/compose/resolve.js';
import { LOCK_PATH } from '../../src/core/constants.js';
import type { FarnaError } from '../../src/core/errors.js';
import { sha256Hex } from '../../src/core/json.js';
import {
  buildLockfile,
  entryKey,
  type LockFileEntry,
  lockfileDocumentSchema,
  readLockfile,
  serialiseLockfile,
} from '../../src/lock/lockfile.js';
import { createTempRepo } from '../support/temp-repo.js';

const REGION_ID = 'claude-instructions';
const SUBJECT = 'CLAUDE.md';
const BODY = '## House style\n\nWrite the smallest change.\n';

const REGION_ENTRY = {
  path: SUBJECT,
  sha256: sha256Hex(BODY),
  size: Buffer.byteLength(BODY),
  shape: 'region',
  regionId: REGION_ID,
};

function captured(run: () => unknown): FarnaError {
  try {
    run();
  } catch (error) {
    return error as FarnaError;
  }
  throw new Error('expected the call to throw');
}

/** A minimal resolved source, shaped as the lockfile builder consumes it. */
function source(): ResolvedSource {
  return {
    target: 'claudecode',
    mode: 'agent',
    active: null,
    notLive: [],
    personas: [],
    mcp: [],
    skills: [],
    commands: [],
    hooks: [],
    warnings: [],
  } as unknown as ResolvedSource;
}

/** The validation issues of a document, as one searchable string. */
function issuesOf(value: unknown): string {
  const parsed = lockfileDocumentSchema.safeParse(value);
  return parsed.success ? '' : JSON.stringify(parsed.error.issues);
}

function documentOf(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 2,
    product: { name: 'farna-bootstrapper', version: '0.2.0' },
    renderer: { name: 'rulesync', version: '43.14.0', integrity: 'sha512-test' },
    configDigest: 'a'.repeat(64),
    targets: {
      claudecode: {
        mode: 'agent',
        activePersona: null,
        notLive: [],
        personas: [],
        files: [entry],
      },
    },
    warnings: [],
  };
}

describe('the region lock entry', () => {
  it('accepts a region entry that names its id and describes the body', () => {
    const parsed = lockfileDocumentSchema.safeParse(documentOf(REGION_ENTRY));
    expect(parsed.success).toBe(true);
  });

  it('refuses a region entry without a regionId', () => {
    const { regionId: _regionId, ...withoutId } = REGION_ENTRY;
    expect(lockfileDocumentSchema.safeParse(documentOf(withoutId)).success).toBe(false);
    expect(issuesOf(documentOf(withoutId))).toContain('a region entry names the region id it owns');
  });

  it('refuses a region entry that also claims owned keys', () => {
    const value = documentOf({ ...REGION_ENTRY, ownedKeys: ['mcp'] });
    expect(lockfileDocumentSchema.safeParse(value).success).toBe(false);
    expect(issuesOf(value)).toContain('only a structured entry owns keys');
  });

  it('refuses a whole entry that carries a regionId', () => {
    const value = documentOf({
      path: SUBJECT,
      sha256: sha256Hex(BODY),
      size: 4,
      regionId: REGION_ID,
    });
    expect(lockfileDocumentSchema.safeParse(value).success).toBe(false);
    expect(issuesOf(value)).toContain('only a region entry names a region id');
  });

  it('refuses a structured entry that carries a regionId', () => {
    const value = documentOf({
      path: 'opencode.jsonc',
      sha256: sha256Hex('{}\n'),
      size: 3,
      shape: 'structured',
      ownedKeys: ['mcp'],
      regionId: REGION_ID,
    });
    expect(lockfileDocumentSchema.safeParse(value).success).toBe(false);
    expect(issuesOf(value)).toContain('only a region entry names a region id');
  });

  it('still accepts the whole and structured entries this build writes', () => {
    expect(
      lockfileDocumentSchema.safeParse(
        documentOf({ path: '.claude/agents/builder.md', sha256: sha256Hex('a\n'), size: 2 }),
      ).success,
    ).toBe(true);
    expect(
      lockfileDocumentSchema.safeParse(
        documentOf({
          path: 'opencode.jsonc',
          sha256: sha256Hex('{}\n'),
          size: 3,
          shape: 'structured',
          ownedKeys: ['mcp'],
        }),
      ).success,
    ).toBe(true);
  });

  it('refuses a region id outside the lower-kebab grammar or over 64 characters', () => {
    for (const id of ['Not-Kebab', 'with_underscore', 'a'.repeat(65)]) {
      const parsed = lockfileDocumentSchema.safeParse(
        documentOf({ ...REGION_ENTRY, regionId: id }),
      );
      expect(parsed.success, `expected "${id}" to be refused`).toBe(false);
    }
  });
});

describe('the lockfile builder records the body, not the file', () => {
  const renderer = { name: 'rulesync', version: '43.14.0', integrity: 'sha512-test' };

  it('records the body digest and size for a region file', () => {
    const lock = buildLockfile(
      renderer,
      [
        {
          source: source(),
          files: [
            {
              path: SUBJECT,
              bytes: BODY,
              shape: 'region',
              regionId: REGION_ID,
              ownedSha256: sha256Hex(BODY),
              ownedSize: Buffer.byteLength(BODY),
            },
          ],
        },
      ],
      [],
      { configDigest: 'b'.repeat(64) },
    );
    const entry = lock.targets['claudecode']?.files[0];
    expect(entry).toEqual({
      path: SUBJECT,
      regionId: REGION_ID,
      sha256: sha256Hex(BODY),
      size: Buffer.byteLength(BODY),
      shape: 'region',
    });
    // The digest is the body's: a file digest would differ, because the body is
    // only part of what the target file holds.
    expect(entry?.sha256).not.toBe(sha256Hex(`${REGION_ID}${BODY}`));
    expect(entry?.ownedKeys).toBeUndefined();
  });

  it('hashes the body from the rendered bytes when no digest is supplied', () => {
    const lock = buildLockfile(
      renderer,
      [
        {
          source: source(),
          files: [{ path: SUBJECT, bytes: BODY, shape: 'region', regionId: REGION_ID }],
        },
      ],
      [],
      { configDigest: 'b'.repeat(64) },
    );
    const entry = lock.targets['claudecode']?.files[0];
    expect(entry?.sha256).toBe(sha256Hex(BODY));
    expect(entry?.size).toBe(Buffer.byteLength(BODY));
  });

  it('refuses a region file that names no region id rather than recording it whole', () => {
    const error = captured(() =>
      buildLockfile(
        renderer,
        [{ source: source(), files: [{ path: SUBJECT, bytes: BODY, shape: 'region' }] }],
        [],
        { configDigest: 'b'.repeat(64) },
      ),
    );
    expect(error.code).toBe('F001_INVALID_CONFIG');
    expect(error.subject).toBe(SUBJECT);
  });

  it('orders two regions of one path by their ids', () => {
    const lock = buildLockfile(
      renderer,
      [
        {
          source: source(),
          files: [
            { path: SUBJECT, bytes: 'b\n', shape: 'region', regionId: 'beta' },
            { path: SUBJECT, bytes: 'a\n', shape: 'region', regionId: 'alpha' },
          ],
        },
      ],
      [],
      { configDigest: 'b'.repeat(64) },
    );
    expect(lock.targets['claudecode']?.files.map((entry) => entry.regionId)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('produces a document its own reader accepts', () => {
    const lock = buildLockfile(
      renderer,
      [
        {
          source: source(),
          files: [{ path: SUBJECT, bytes: BODY, shape: 'region', regionId: REGION_ID }],
        },
      ],
      [],
      { configDigest: 'b'.repeat(64) },
    );
    expect(lockfileDocumentSchema.safeParse(JSON.parse(serialiseLockfile(lock))).success).toBe(
      true,
    );
  });
});

describe('the lockfile reader refuses a region entry it cannot understand', () => {
  async function repoWith(entry: Record<string, unknown>): Promise<{
    root: string;
    cleanup: () => Promise<void>;
  }> {
    const repo = await createTempRepo();
    await writeFile(
      join(repo.root, LOCK_PATH),
      `${JSON.stringify(documentOf(entry), null, 2)}\n`,
      'utf8',
    );
    return repo;
  }

  it('reads a region entry back with its id and body digest', async () => {
    const repo = await repoWith(REGION_ENTRY);
    try {
      const lock = await readLockfile(repo.root);
      const entry = lock?.targets['claudecode']?.files[0];
      expect(entry?.shape).toBe('region');
      expect(entry?.regionId).toBe(REGION_ID);
      expect(entry?.sha256).toBe(sha256Hex(BODY));
      expect(entry?.size).toBe(Buffer.byteLength(BODY));
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a region entry with no regionId, naming the lockfile', async () => {
    const { regionId: _regionId, ...withoutId } = REGION_ENTRY;
    const repo = await repoWith(withoutId);
    try {
      await expect(readLockfile(repo.root)).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: LOCK_PATH,
        message: expect.stringContaining('regionId'),
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a non-region entry that carries a regionId, naming the lockfile', async () => {
    const repo = await repoWith({
      path: '.claude/agents/builder.md',
      sha256: sha256Hex('a\n'),
      size: 2,
      regionId: REGION_ID,
    });
    try {
      await expect(readLockfile(repo.root)).rejects.toMatchObject({
        code: 'F001_INVALID_CONFIG',
        subject: LOCK_PATH,
        message: expect.stringContaining('only a region entry names a region id'),
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('accepts the untouched document it writes', async () => {
    const repo = await createTempRepo();
    try {
      const lock = buildLockfile(
        { name: 'rulesync', version: '43.14.0', integrity: 'sha512-test' },
        [
          {
            source: source(),
            files: [{ path: SUBJECT, bytes: BODY, shape: 'region', regionId: REGION_ID }],
          },
        ],
        [],
        { configDigest: 'b'.repeat(64) },
      );
      await writeFile(join(repo.root, LOCK_PATH), serialiseLockfile(lock), 'utf8');
      const read = await readLockfile(repo.root);
      expect(read?.targets['claudecode']?.files[0]?.regionId).toBe(REGION_ID);
      expect(await readFile(join(repo.root, LOCK_PATH), 'utf8')).toBe(serialiseLockfile(lock));
    } finally {
      await repo.cleanup();
    }
  });
});

describe('the recorded-set key', () => {
  it('keys a whole file by its path and a region by its path and id', () => {
    expect(entryKey({ path: '.claude/agents/builder.md' })).toBe('.claude/agents/builder.md');
    expect(entryKey({ path: SUBJECT, shape: 'region', regionId: REGION_ID })).toBe(
      `${SUBJECT}#region:${REGION_ID}`,
    );
  });

  it('gives two regions of one file two keys and never collides with the path', () => {
    const alpha = entryKey({ path: SUBJECT, shape: 'region', regionId: 'alpha' });
    const beta = entryKey({ path: SUBJECT, shape: 'region', regionId: 'beta' });
    expect(alpha).not.toBe(beta);
    expect([alpha, beta]).not.toContain(SUBJECT);
  });

  it('keys a recorded entry exactly as the plan keys the rendered file', () => {
    const lock = buildLockfile(
      { name: 'rulesync', version: '43.14.0', integrity: 'sha512-test' },
      [
        {
          source: source(),
          files: [{ path: SUBJECT, bytes: BODY, shape: 'region', regionId: REGION_ID }],
        },
      ],
      [],
      { configDigest: 'b'.repeat(64) },
    );
    const recorded: LockFileEntry | undefined = lock.targets['claudecode']?.files[0];
    expect(recorded).toBeDefined();
    expect(entryKey(recorded as LockFileEntry)).toBe(
      entryKey({ path: SUBJECT, shape: 'region', regionId: REGION_ID }),
    );
  });
});
