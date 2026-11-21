import { rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { renderFailed } from '../../src/core/errors.js';
import { cleanupStage, withStage } from '../../src/render/stage.js';

function silenceStderr() {
  return vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((() => true) as typeof process.stderr.write);
}

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
      expect(output).toContain(stageRoot);
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
      const output = spy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('could not remove temporary stage');
      expect(output).toContain('refusing to remove a path outside the temporary root');
    } finally {
      spy.mockRestore();
    }
  });
});
