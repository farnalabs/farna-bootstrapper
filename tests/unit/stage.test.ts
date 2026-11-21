import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderFailed } from '../../src/core/errors.js';
import { isPathInside } from '../../src/core/paths.js';
import { cleanupStage, type StageOperations, withStage } from '../../src/render/stage.js';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function silenceStderr() {
  return vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((() => true) as typeof process.stderr.write);
}

describe('stage containment', () => {
  it('accepts a native child path and refuses a sibling', () => {
    expect(isPathInside('/tmp', '/tmp/stage')).toBe(true);
    expect(isPathInside('/tmp', '/tmp')).toBe(true);
    expect(isPathInside('/tmp', '/tmp/other/stage')).toBe(true);
    expect(isPathInside('/tmp', '/other')).toBe(false);
  });

  it('handles Windows-shaped paths with a backslash separator', () => {
    const api = { relative: win32.relative, isAbsolute: win32.isAbsolute };
    expect(isPathInside('C:\\tmp', 'C:\\tmp\\stage', api)).toBe(true);
    expect(isPathInside('C:\\tmp', 'C:\\other\\stage', api)).toBe(false);
    expect(isPathInside('C:\\tmp', 'C:\\tmp\\..\\escape', api)).toBe(false);
  });

  it('removes the stage when directory creation fails early', async () => {
    let created = '';
    const operations: StageOperations = {
      tmpdir,
      realpath: async (path) => await realpath(path),
      mkdtemp: async (prefix) => {
        created = await mkdtemp(prefix);
        return created;
      },
      mkdir: async (path, options) => {
        if (path.endsWith('out')) {
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        await mkdir(path, options);
      },
    };
    await expect(withStage(async () => 'unreachable', undefined, operations)).rejects.toMatchObject(
      {
        code: 'F009_RENDER_FAILED',
        subject: 'temporary stage',
      },
    );
    expect(created).not.toBe('');
    expect(await exists(created)).toBe(false);
  });
});

describe('stage cleanup', () => {
  it('keeps the renderer error and warns when the stage cannot be removed', async () => {
    const spy = silenceStderr();
    let stageRoot = '';
    try {
      await expect(
        withStage(
          async (stage) => {
            stageRoot = stage.root;
            throw renderFailed('the renderer threw', { subject: 'hostile' });
          },
          async () => {
            throw new Error('EACCES: permission denied');
          },
        ),
      ).rejects.toMatchObject({
        code: 'F009_RENDER_FAILED',
        message: 'the renderer threw',
      });
      const output = spy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('could not remove temporary stage');
      // The absolute stage root is redacted; only its leaf name is printed.
      expect(output).toContain(basename(stageRoot));
      expect(output).not.toContain(tmpdir());
    } finally {
      spy.mockRestore();
      if (stageRoot !== '') {
        await rm(stageRoot, { recursive: true, force: true });
      }
    }
  });

  it('never throws when cleanup fails or the path is outside the temp root', async () => {
    const spy = silenceStderr();
    try {
      await expect(
        cleanupStage('/tmp/not-ours', '/tmp', async () => {
          throw new Error('EACCES');
        }),
      ).resolves.toBeUndefined();
      await expect(
        cleanupStage('/etc/passwd', '/tmp', async () => {
          throw new Error('must not run');
        }),
      ).resolves.toBeUndefined();
      await expect(
        cleanupStage(join('/tmp', 'not-ours'), join('/tmp', 'elsewhere'), async () => {
          throw new Error('must not run');
        }),
      ).resolves.toBeUndefined();
      const output = spy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('could not remove temporary stage');
      // A path outside the temporary root is refused by code, not by leaking
      // the absolute path into the warning.
      expect(output).toContain('F003_PATH_UNSAFE');
    } finally {
      spy.mockRestore();
    }
  });
});
