import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { PiSessionShelfEntry, PiSessionShelfInput } from '@/lib/pi/protocol';

let readImpl: () => Promise<{ sessions: Record<string, PiSessionShelfEntry> }> = async () => ({ sessions: {} });
let writeImpl: (input: PiSessionShelfInput) => Promise<PiSessionShelfEntry | null> = async () => null;
let runtimeKey = 'runtime-1';

mock.module('@/lib/pi/client', () => ({
  piClient: {
    getSessionShelf: () => readImpl(),
    setSessionShelf: (input: PiSessionShelfInput) => writeImpl(input),
  },
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));

const { useSessionShelfStore } = await import('./useSessionShelfStore');

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('useSessionShelfStore', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-1';
    useSessionShelfStore.setState({ runtimeKey: null, entries: {}, status: 'idle' });
    readImpl = async () => ({ sessions: {} });
    writeImpl = async () => null;
  });

  test('a failed read keeps the previous entries instead of reading as empty', async () => {
    readImpl = async () => ({ sessions: { a: { snoozedUntil: 100, snoozedAt: 1 } } });
    await useSessionShelfStore.getState().load();
    readImpl = async () => {
      throw new Error('offline');
    };
    await useSessionShelfStore.getState().load();
    expect(useSessionShelfStore.getState().status).toBe('failed');
    expect(useSessionShelfStore.getState().entries).toEqual({ a: { snoozedUntil: 100, snoozedAt: 1 } });
  });

  test('a change made while a read is in flight survives the read', async () => {
    const read = deferred<{ sessions: Record<string, PiSessionShelfEntry> }>();
    readImpl = () => read.promise;
    const loading = useSessionShelfStore.getState().load();
    writeImpl = async () => ({ snoozedUntil: 200, snoozedAt: 2 });
    await useSessionShelfStore.getState().update('a', { snoozedUntil: 200 });
    read.resolve({ sessions: { b: { snoozedUntil: 100, snoozedAt: 1 } } });
    await loading;
    expect(useSessionShelfStore.getState().entries).toEqual({
      a: { snoozedUntil: 200, snoozedAt: 2 },
      b: { snoozedUntil: 100, snoozedAt: 1 },
    });
  });

  test('a failed write rolls back and rethrows; a newer change is not rolled back', async () => {
    writeImpl = async () => {
      throw new Error('nope');
    };
    await expect(useSessionShelfStore.getState().update('a', { snoozedUntil: 200 })).rejects.toThrow('nope');
    expect(useSessionShelfStore.getState().entries).toEqual({});

    const first = deferred<PiSessionShelfEntry | null>();
    writeImpl = () => first.promise;
    const firstUpdate = useSessionShelfStore.getState().update('a', { snoozedUntil: 200 });
    writeImpl = async () => ({ snoozedUntil: 100, snoozedAt: 1 });
    await useSessionShelfStore.getState().update('a', { snoozedUntil: 100 });
    first.reject(new Error('late failure'));
    await expect(firstUpdate).rejects.toThrow('late failure');
    expect(useSessionShelfStore.getState().entries).toEqual({ a: { snoozedUntil: 100, snoozedAt: 1 } });
  });

  test('a runtime switch drops the other runtime entries', async () => {
    readImpl = async () => ({ sessions: { a: { snoozedUntil: 100, snoozedAt: 1 } } });
    await useSessionShelfStore.getState().load();
    runtimeKey = 'runtime-2';
    const read = deferred<{ sessions: Record<string, PiSessionShelfEntry> }>();
    readImpl = () => read.promise;
    const loading = useSessionShelfStore.getState().load();
    expect(useSessionShelfStore.getState().entries).toEqual({});
    read.resolve({ sessions: {} });
    await loading;
    expect(useSessionShelfStore.getState()).toMatchObject({ runtimeKey: 'runtime-2', status: 'ready', entries: {} });
  });
});
