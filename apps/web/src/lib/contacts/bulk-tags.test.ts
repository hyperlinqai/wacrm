import { describe, expect, it, vi } from 'vitest';

import { runWithConcurrency } from './bulk-tags';

describe('runWithConcurrency', () => {
  it('runs every item and counts successes', async () => {
    const seen: number[] = [];
    const result = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(result).toEqual({ succeeded: 5, failed: 0 });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('counts a thrown error as failed without aborting the rest', async () => {
    const result = await runWithConcurrency([1, 2, 3], 3, async (n) => {
      if (n === 2) throw new Error('boom');
    });
    expect(result).toEqual({ succeeded: 2, failed: 1 });
  });

  it('never runs more than `limit` items concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runWithConcurrency(items, 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    const fn = vi.fn();
    const result = await runWithConcurrency([], 5, fn);
    expect(result).toEqual({ succeeded: 0, failed: 0 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('caps concurrency at the item count when limit is larger', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const result = await runWithConcurrency([1, 2], 100, fn);
    expect(result).toEqual({ succeeded: 2, failed: 0 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
