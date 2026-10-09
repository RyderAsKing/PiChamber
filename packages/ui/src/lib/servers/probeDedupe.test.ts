import { describe, expect, test } from 'bun:test';
import { createProbeDeduper } from './probeDedupe';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('createProbeDeduper', () => {
  test('concurrent probes for one host share a single run', async () => {
    const dedupe = createProbeDeduper();
    let runs = 0;
    const gate = deferred<string>();
    const run = () => {
      runs += 1;
      return gate.promise;
    };
    const first = dedupe('host-a', run);
    const second = dedupe('host-a', run);
    expect(runs).toBe(1);
    gate.resolve('ok');
    expect(await first).toBe('ok');
    expect(await second).toBe('ok');
  });

  test('different hosts probe independently', async () => {
    const dedupe = createProbeDeduper();
    let runs = 0;
    const run = () => {
      runs += 1;
      return Promise.resolve(runs);
    };
    const [a, b] = await Promise.all([dedupe('host-a', run), dedupe('host-b', run)]);
    expect([a, b]).toEqual([1, 2]);
  });

  test('a settled probe runs again on the next cycle', async () => {
    const dedupe = createProbeDeduper();
    let runs = 0;
    const run = () => {
      runs += 1;
      return Promise.resolve(runs);
    };
    expect(await dedupe('host-a', run)).toBe(1);
    expect(await dedupe('host-a', run)).toBe(2);
  });

  test('a rejected probe does not poison the next cycle', async () => {
    const dedupe = createProbeDeduper();
    let runs = 0;
    await expect(
      dedupe('host-a', () => {
        runs += 1;
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    expect(await dedupe('host-a', () => {
      runs += 1;
      return Promise.resolve('recovered');
    })).toBe('recovered');
    expect(runs).toBe(2);
  });
});
