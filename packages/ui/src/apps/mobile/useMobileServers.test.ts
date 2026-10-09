import { describe, expect, test } from 'bun:test';

import {
  connectMobileServerRecord,
  dedupedMobileConnect,
  removeMobileServerRecord,
  resolveMobileServerStatus,
  shouldLeaveToConnectScreen,
  type MobileServerConnectionStore,
} from './useMobileServers';
import type { MobileSavedConnection } from './mobileConnectionTypes';

const lanConnection: MobileSavedConnection = {
  id: 'lan',
  label: 'Studio LAN',
  candidates: [{ kind: 'direct', url: 'http://192.168.1.74:2606' }],
  lastUsedAt: 2,
  clientToken: 'tok-lan',
};

const relayConnection: MobileSavedConnection = {
  id: 'relay',
  label: 'Cabin',
  candidates: [
    {
      kind: 'relay',
      relay: {
        relayUrl: 'wss://relay.example/tunnel',
        serverId: 'srv_cabin',
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' },
      },
    },
  ],
  lastUsedAt: 1,
  hasToken: true,
};

describe('resolveMobileServerStatus', () => {
  const base = { isCurrent: false, relayActive: false, needsLogin: false, connecting: false, uncertain: false };

  test('unlock beats every other signal', () => {
    expect(
      resolveMobileServerStatus({ ...base, isCurrent: true, needsLogin: true, connecting: true }),
    ).toEqual({ kind: 'needs-login' });
  });

  test('connecting maps to checking for non-current rows', () => {
    expect(resolveMobileServerStatus({ ...base, connecting: true })).toEqual({ kind: 'connecting' });
  });

  test('current rows follow the live transport', () => {
    expect(resolveMobileServerStatus({ ...base, isCurrent: true })).toEqual({
      kind: 'connected',
      transport: 'direct',
    });
    expect(resolveMobileServerStatus({ ...base, isCurrent: true, relayActive: true })).toEqual({
      kind: 'connected',
      transport: 'relay',
    });
  });

  test('uncertain current rows read as unreachable (retrying)', () => {
    expect(resolveMobileServerStatus({ ...base, isCurrent: true, uncertain: true })).toEqual({
      kind: 'unreachable',
    });
  });

  test('saved non-current rows stay unknown', () => {
    expect(resolveMobileServerStatus(base)).toEqual({ kind: 'unknown' });
    expect(resolveMobileServerStatus({ ...base, uncertain: true })).toEqual({ kind: 'unknown' });
  });
});

describe('shouldLeaveToConnectScreen', () => {
  test('active or last removal leaves to the connect screen', () => {
    expect(shouldLeaveToConnectScreen({ wasLast: true, wasActive: false })).toBe(true);
    expect(shouldLeaveToConnectScreen({ wasLast: false, wasActive: true })).toBe(true);
    expect(shouldLeaveToConnectScreen({ wasLast: true, wasActive: true })).toBe(true);
    expect(shouldLeaveToConnectScreen({ wasLast: false, wasActive: false })).toBe(false);
  });
});

describe('connectMobileServerRecord', () => {
  test('delegates to the existing transport with the saved candidates', async () => {
    const calls: unknown[] = [];
    const store: MobileServerConnectionStore = {
      connections: [lanConnection, relayConnection],
      connect: async (input) => {
        calls.push(input);
      },
      removeConnection: async () => null,
    };
    expect(await connectMobileServerRecord(store, 'relay')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: 'relay',
      candidates: relayConnection.candidates,
      clientToken: undefined,
      label: 'Cabin',
    });
  });

  test('unknown ids never touch the transport', async () => {
    let calls = 0;
    const store: MobileServerConnectionStore = {
      connections: [lanConnection],
      connect: async () => {
        calls += 1;
      },
      removeConnection: async () => null,
    };
    expect(await connectMobileServerRecord(store, 'missing')).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('removeMobileServerRecord', () => {
  const deletingStore = (
    remaining: MobileSavedConnection[],
    isActive: (connection: MobileSavedConnection) => boolean,
  ) => {
    const removed: MobileSavedConnection[] = [];
    return {
      store: {
        connections: remaining,
        connect: async () => undefined,
        removeConnection: async (id: string) => {
          const found = remaining.find((connection) => connection.id === id) ?? null;
          if (found) removed.push(found);
          return found;
        },
        readConnectionCount: () => remaining.length,
        isActive,
      },
      removed,
    };
  };

  test('removing the last connection triggers the connect-screen fallback', async () => {
    const { store } = deletingStore([lanConnection], () => false);
    let fallback = 0;
    expect(await removeMobileServerRecord(store, 'lan', () => {
      fallback += 1;
    })).toBe(true);
    expect(fallback).toBe(1);
  });

  test('removing the active connection triggers the fallback', async () => {
    const { store } = deletingStore(
      [lanConnection, relayConnection],
      (connection) => connection.id === 'lan',
    );
    let fallback = 0;
    expect(await removeMobileServerRecord(store, 'lan', () => {
      fallback += 1;
    })).toBe(true);
    expect(fallback).toBe(1);
  });

  test('removing an idle connection keeps the current screen', async () => {
    const { store } = deletingStore(
      [lanConnection, relayConnection],
      (connection) => connection.id === 'lan',
    );
    let fallback = 0;
    expect(await removeMobileServerRecord(store, 'relay', () => {
      fallback += 1;
    })).toBe(true);
    expect(fallback).toBe(0);
  });

  test('missing ids report false without a fallback', async () => {
    const { store } = deletingStore([lanConnection], () => false);
    let fallback = 0;
    expect(await removeMobileServerRecord(store, 'missing', () => {
      fallback += 1;
    })).toBe(false);
    expect(fallback).toBe(0);
  });
});

describe('dedupedMobileConnect', () => {
  test('concurrent connects to the same server share one probe race', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async () => {
      runs += 1;
      await gate;
    };
    const first = dedupedMobileConnect('lan', run);
    const second = dedupedMobileConnect('lan', run);
    release();
    await Promise.all([first, second]);
    expect(runs).toBe(1);
  });

  test('different servers probe independently', async () => {
    let runs = 0;
    const run = async () => {
      runs += 1;
    };
    await Promise.all([dedupedMobileConnect('a', run), dedupedMobileConnect('b', run)]);
    expect(runs).toBe(2);
  });

  test('a failed probe clears the key so a retry runs again', async () => {
    let runs = 0;
    const failing = async () => {
      runs += 1;
      throw new Error('unreachable');
    };
    await expect(dedupedMobileConnect('lan', failing)).rejects.toThrow('unreachable');
    await expect(dedupedMobileConnect('lan', failing)).rejects.toThrow('unreachable');
    expect(runs).toBe(2);
  });
});
