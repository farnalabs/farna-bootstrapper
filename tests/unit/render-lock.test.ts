import { describe, expect, it } from 'vitest';
import { withRenderLock } from '../../src/render/upstream.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('the render lock', () => {
  it('serialises two renders instead of letting them race on the process cwd', async () => {
    const order: string[] = [];
    const first = withRenderLock(async () => {
      order.push('first:start');
      await delay(30);
      order.push('first:end');
    });
    const second = withRenderLock(async () => {
      order.push('second:start');
      await delay(1);
      order.push('second:end');
    });
    await Promise.all([first, second]);
    // Without the lock the second body starts while the first is mid-await.
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('releases the lock when a render throws', async () => {
    const order: string[] = [];
    await withRenderLock(async () => {
      order.push('throwing');
      throw new Error('boom');
    }).catch(() => undefined);
    await withRenderLock(async () => {
      order.push('after');
    });
    expect(order).toEqual(['throwing', 'after']);
  });
});
