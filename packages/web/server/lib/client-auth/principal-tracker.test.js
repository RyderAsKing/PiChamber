import { describe, expect, it } from 'bun:test';
import {
  MAX_LIVE_CONNECTIONS_GLOBAL,
  MAX_LIVE_CONNECTIONS_PER_PRINCIPAL,
  MAX_REMEMBERED_REVOKED_CLIENTS,
  createPrincipalTracker,
  createRevocationCoordinator,
} from './principal-tracker.js';

describe('principal tracker', () => {
  it('closes only the revoked principal connections and reports the count', () => {
    const tracker = createPrincipalTracker();
    const closedA = [];
    const closedB = [];
    tracker.track({ principal: 'client:a', close: (reason) => closedA.push(reason) });
    tracker.track({ principal: 'client:a', close: (reason) => closedA.push(reason) });
    tracker.track({ principal: 'client:b', close: (reason) => closedB.push(reason) });

    expect(tracker.size).toBe(3);
    expect(tracker.countPrincipal('client:a')).toBe(2);
    expect(tracker.closePrincipal('client:a', 'credential-revoked')).toBe(2);

    expect(closedA).toEqual(['credential-revoked', 'credential-revoked']);
    expect(closedB).toEqual([]);
    expect(tracker.size).toBe(1);
    expect(tracker.closePrincipal('client:a', 'credential-revoked')).toBe(0);
    expect(tracker.closePrincipal('client:missing')).toBe(0);
  });

  it('detaches entries when connections end naturally and keeps revoke idempotent', () => {
    const tracker = createPrincipalTracker();
    const closed = [];
    const entry = tracker.track({ principal: 'client:a', close: (reason) => closed.push(reason) });

    entry.end();
    expect(tracker.countPrincipal('client:a')).toBe(0);
    expect(entry.revoke('late')).toBe(false);
    expect(closed).toEqual([]);

    const revoked = tracker.track({ principal: 'client:b', close: () => {} });
    expect(revoked.revoke('credential-revoked')).toBe(true);
    expect(revoked.revoke('credential-revoked')).toBe(false);
    expect(revoked.end()).toBeUndefined();
    expect(tracker.size).toBe(0);
  });

  it('isolates a failing close so other principals still close', () => {
    const errors = [];
    const tracker = createPrincipalTracker({ onCloseError: ({ error }) => errors.push(error) });
    const closed = [];
    tracker.track({ principal: 'client:bad', close: () => { throw new Error('destroy failed'); } });
    tracker.track({ principal: 'client:good', close: (reason) => closed.push(reason) });

    expect(tracker.closeAll('shutdown')).toBe(2);
    expect(closed).toEqual(['shutdown']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(tracker.size).toBe(0);
  });

  it('closeAll reports every tracked principal and empties the index', () => {
    const tracker = createPrincipalTracker();
    tracker.track({ principal: 'client:a', close: () => {} });
    tracker.track({ principal: 'client:b', close: () => {} });
    tracker.track({ principal: 'session-jwt-1', close: () => {} });
    expect([...tracker.principals()].sort()).toEqual(['client:a', 'client:b', 'session-jwt-1']);
    expect(tracker.closeAll('signout-everywhere')).toBe(3);
    expect(tracker.size).toBe(0);
  });

  it('rejects tracking without a principal or close callback', () => {
    const tracker = createPrincipalTracker();
    expect(() => tracker.track({ principal: '', close: () => {} })).toThrow();
    expect(() => tracker.track({ principal: 'client:a' })).toThrow();
  });
});

describe('revocation coordinator', () => {
  it('closes the revoked principal connections immediately on the in-process path', () => {
    const closed = [];
    const coordinator = createRevocationCoordinator({ listRevokedClientIds: async () => [] });
    coordinator.trackLiveConnection({ principal: 'client:dev-1', close: (reason) => closed.push(reason) });
    coordinator.trackLiveConnection({ principal: 'client:dev-2', close: () => closed.push('other') });

    expect(coordinator.clientRevoked('dev-1')).toBe(1);
    expect(coordinator.clientRevoked('unknown-device')).toBe(0);
    expect(closed).toEqual(['credential-revoked']);
    expect(coordinator.liveConnectionCount).toBe(1);
  });

  it('converges with cross-process revocations through the bounded poll', async () => {
    let revokedIds = [];
    const polls = { count: 0 };
    const coordinator = createRevocationCoordinator({
      listRevokedClientIds: async () => {
        polls.count += 1;
        return revokedIds;
      },
      pollIntervalMs: 5,
      setIntervalFn: (fn, ms) => setInterval(fn, ms),
      clearIntervalFn: (handle) => clearInterval(handle),
    });
    const closed = [];
    coordinator.trackLiveConnection({ principal: 'client:dev-1', close: (reason) => closed.push(reason) });
    coordinator.start();

    // Simulate a revocation committed by another process sharing the store.
    revokedIds = ['dev-1'];
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(polls.count).toBeGreaterThan(0);
    expect(closed).toEqual(['credential-revoked']);
    await coordinator.dispose();
  });

  it('keeps previous state when a poll fails and recovers on the next tick', async () => {
    let shouldFail = false;
    let revokedIds = [];
    const coordinator = createRevocationCoordinator({
      listRevokedClientIds: async () => {
        if (shouldFail) throw new Error('store read failed');
        return revokedIds;
      },
      pollIntervalMs: 5,
      setIntervalFn: (fn, ms) => setInterval(fn, ms),
      clearIntervalFn: (handle) => clearInterval(handle),
    });
    const closed = [];
    coordinator.trackLiveConnection({ principal: 'client:dev-1', close: (reason) => closed.push(reason) });
    coordinator.start();

    shouldFail = true;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closed).toEqual([]);

    shouldFail = false;
    revokedIds = ['dev-1'];
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closed).toEqual(['credential-revoked']);
    await coordinator.dispose();
  });

  it('dispose stops polling and closes remaining connections synchronously', async () => {
    let polls = 0;
    const coordinator = createRevocationCoordinator({
      listRevokedClientIds: async () => {
        polls += 1;
        return [];
      },
      pollIntervalMs: 5,
      setIntervalFn: (fn, ms) => setInterval(fn, ms),
      clearIntervalFn: (handle) => clearInterval(handle),
    });
    coordinator.trackLiveConnection({ principal: 'client:dev-1', close: () => {} });
    coordinator.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(coordinator.dispose({ closeConnections: true })).toBe(1);
    expect(coordinator.liveConnectionCount).toBe(0);

    const pollsAfterDispose = polls;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(polls).toBe(pollsAfterDispose);
  });

  it('dispose without closeConnections leaves tracked connections in place', () => {
    const coordinator = createRevocationCoordinator({ listRevokedClientIds: async () => [] });
    coordinator.trackLiveConnection({ principal: 'client:dev-1', close: () => {} });
    coordinator.dispose({ closeConnections: false });
    expect(coordinator.liveConnectionCount).toBe(1);
  });

  it('requires a listRevokedClientIds implementation', () => {
    expect(() => createRevocationCoordinator({})).toThrow();
  });
});

describe('principal tracker resource bounds', () => {
  it('reject-closes a new connection beyond the per-principal bound without evicting unrelated entries', () => {
    const tracker = createPrincipalTracker({ maxPerPrincipal: 2, maxTotal: 10 });
    const closedA = [];
    const closedB = [];
    tracker.track({ principal: 'client:a', close: () => {} });
    tracker.track({ principal: 'client:a', close: () => {} });
    tracker.track({ principal: 'client:b', close: (reason) => closedB.push(reason) });

    const rejected = tracker.track({ principal: 'client:a', close: (reason) => closedA.push(reason) });
    expect(rejected.active).toBe(false);
    expect(closedA).toEqual(['over-limit']);
    expect(rejected.revoke('late')).toBe(false);
    rejected.end();
    // Unrelated entries are untouched: A keeps 2, B keeps 1.
    expect(tracker.countPrincipal('client:a')).toBe(2);
    expect(tracker.countPrincipal('client:b')).toBe(1);
    expect(tracker.size).toBe(3);
    expect(closedB).toEqual([]);
  });

  it('reject-closes a new connection beyond the global bound without evicting unrelated entries', () => {
    const tracker = createPrincipalTracker({ maxPerPrincipal: 10, maxTotal: 2 });
    tracker.track({ principal: 'client:a', close: () => {} });
    tracker.track({ principal: 'client:b', close: () => {} });
    const closed = [];
    const rejected = tracker.track({ principal: 'client:c', close: (reason) => closed.push(reason) });
    expect(rejected.active).toBe(false);
    expect(closed).toEqual(['over-limit']);
    expect(tracker.size).toBe(2);
    expect(tracker.countPrincipal('client:a')).toBe(1);
    expect(tracker.countPrincipal('client:b')).toBe(1);
  });

  it('exposes the configured bounds and defaults', () => {
    const tracker = createPrincipalTracker();
    expect(tracker.maxPerPrincipal).toBe(MAX_LIVE_CONNECTIONS_PER_PRINCIPAL);
    expect(tracker.maxTotal).toBe(MAX_LIVE_CONNECTIONS_GLOBAL);
    const coordinator = createRevocationCoordinator({ listRevokedClientIds: async () => [] });
    expect(coordinator.maxRevoked).toBe(MAX_REMEMBERED_REVOKED_CLIENTS);
    coordinator.dispose({ closeConnections: false });
  });

  it('disposed tracker reject-closes new registrations', () => {
    const tracker = createPrincipalTracker();
    tracker.track({ principal: 'client:a', close: () => {} });
    expect(tracker.dispose('shutdown')).toBe(1);
    expect(tracker.disposed).toBe(true);
    const closed = [];
    const rejected = tracker.track({ principal: 'client:b', close: (reason) => closed.push(reason) });
    expect(rejected.active).toBe(false);
    expect(closed).toEqual(['shutdown']);
    expect(tracker.size).toBe(0);
  });
});

describe('revocation coordinator verify-registration barrier', () => {
  it('rejects a late client registration that races revocation (no poll involved)', () => {
    const coordinator = createRevocationCoordinator({ listRevokedClientIds: async () => [] });
    // Verification passed, then the revoke commits+closes before track.
    expect(coordinator.clientRevoked('dev-1')).toBe(0);
    expect(coordinator.isClientRevoked('dev-1')).toBe(true);
    const closed = [];
    const late = coordinator.trackLiveConnection({
      principal: 'client:dev-1',
      close: (reason) => closed.push(reason),
    });
    expect(late.active).toBe(false);
    expect(closed).toEqual(['credential-revoked']);
    expect(coordinator.liveConnectionCount).toBe(0);
    expect(late.revoke('late')).toBe(false);
    coordinator.dispose({ closeConnections: false });
  });

  it('rejects a stale-generation registration after global invalidation without trusting the principal', () => {
    const coordinator = createRevocationCoordinator({ listRevokedClientIds: async () => [] });
    const generation = coordinator.getGeneration();
    // A global sign-out commits between verify and track.
    expect(coordinator.revokeAllLive('signout-everywhere')).toBe(0);
    const closed = [];
    const late = coordinator.trackLiveConnection({
      principal: 'session-jwt-old',
      close: (reason) => closed.push(reason),
      generation,
    });
    expect(late.active).toBe(false);
    expect(closed).toEqual(['global-invalidation']);
    // A registration verified AFTER the invalidation carries the new
    // generation and is tracked normally.
    const fresh = coordinator.trackLiveConnection({
      principal: 'session-jwt-new',
      close: () => {},
      generation: coordinator.getGeneration(),
    });
    expect(fresh.active).toBe(true);
    expect(coordinator.liveConnectionCount).toBe(1);
    coordinator.dispose();
  });

  it('reject-closes beyond coordinator bounds without evicting unrelated principals', () => {
    const coordinator = createRevocationCoordinator({
      listRevokedClientIds: async () => [],
      maxPerPrincipal: 1,
      maxTotal: 10,
    });
    coordinator.trackLiveConnection({ principal: 'client:a', close: () => {} });
    const closed = [];
    const rejected = coordinator.trackLiveConnection({
      principal: 'client:a',
      close: (reason) => closed.push(reason),
    });
    expect(rejected.active).toBe(false);
    expect(closed).toEqual(['over-limit']);
    expect(coordinator.countPrincipal('client:a')).toBe(1);
    coordinator.dispose();
  });

  it('disposed coordinator reject-closes new registrations', () => {
    const coordinator = createRevocationCoordinator({ listRevokedClientIds: async () => [] });
    coordinator.dispose({ closeConnections: false });
    const closed = [];
    const rejected = coordinator.trackLiveConnection({
      principal: 'client:a',
      close: (reason) => closed.push(reason),
    });
    expect(rejected.active).toBe(false);
    expect(closed).toEqual(['shutdown']);
  });

  it('bounds remembered revoked IDs with FIFO eviction', () => {
    const coordinator = createRevocationCoordinator({
      listRevokedClientIds: async () => [],
      maxRevoked: 2,
    });
    coordinator.clientRevoked('a');
    coordinator.clientRevoked('b');
    expect(coordinator.getRevokedCount()).toBe(2);
    coordinator.clientRevoked('c');
    expect(coordinator.getRevokedCount()).toBe(2);
    expect(coordinator.isClientRevoked('a')).toBe(false);
    expect(coordinator.isClientRevoked('b')).toBe(true);
    expect(coordinator.isClientRevoked('c')).toBe(true);
    coordinator.dispose({ closeConnections: false });
  });
});
