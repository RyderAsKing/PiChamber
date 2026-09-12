import { describe, expect, it } from 'vitest';

import {
  createSendOperationRegistry,
  isValidSendOperationId,
  stableFingerprint,
} from './send-operation-registry.js';

describe('send operation registry', () => {
  const streamEpoch = 'epoch-1';
  const createRegistry = (options = {}) => createSendOperationRegistry({ streamEpoch, ...options });
  const baseClaim = {
    kind: 'prompt',
    sessionId: 'sess-1',
    operationId: 'op-1',
    streamEpoch,
    fingerprint: '{"text":"hello"}',
  };

  it('accepts a new claim and settles the acceptance receipt', () => {
    const registry = createRegistry();
    const claim = registry.claim(baseClaim);
    expect(claim.outcome).toBe('new');
    claim.entry.settle({ accepted: true, receipt: { accepted: true, messageId: 'msg-1' } });
    const retry = registry.claim(baseClaim);
    expect(retry.outcome).toBe('accepted');
    expect(retry.receipt).toEqual({ accepted: true, messageId: 'msg-1' });
    expect(retry.deduplicated).toBe(true);
  });

  it('shares the original receipt with a concurrent pending duplicate', async () => {
    const registry = createRegistry();
    const first = registry.claim(baseClaim);
    expect(first.outcome).toBe('new');

    const duplicate = registry.claim(baseClaim);
    expect(duplicate.outcome).toBe('pending');

    const duplicateResult = duplicate.settled.then((result) => result);
    first.entry.settle({ accepted: true, receipt: { accepted: true, messageId: 'msg-original' } });
    await expect(duplicateResult).resolves.toEqual({
      accepted: true,
      receipt: { accepted: true, messageId: 'msg-original' },
    });
    // The late duplicate resolves against the retained receipt afterwards.
    expect(registry.claim(baseClaim).outcome).toBe('accepted');
  });

  it('shares the original rejection with a concurrent pending duplicate and frees the id', async () => {
    const registry = createRegistry();
    const first = registry.claim(baseClaim);
    const duplicate = registry.claim(baseClaim);
    expect(duplicate.outcome).toBe('pending');

    first.entry.settle({ accepted: false, error: new Error('busy') });
    await expect(duplicate.settled).rejects.toThrow('busy');
    // A rejection happened before Pi ran, so the id is free for a retry.
    expect(registry.claim(baseClaim).outcome).toBe('new');
  });

  it('rejects payload changes and retired epochs before claiming', () => {
    const registry = createRegistry();
    expect(registry.claim({ ...baseClaim, streamEpoch: 'epoch-retired' }).outcome).toBe('stale');
    expect(registry.size).toBe(0);
    const first = registry.claim(baseClaim);
    first.entry.settle({ accepted: true, receipt: { accepted: true, messageId: 'msg-1' } });
    expect(registry.claim({ ...baseClaim, fingerprint: '{"text":"different"}' }).outcome).toBe('mismatch');
    expect(registry.claim({ ...baseClaim, kind: 'steer' }).outcome).toBe('new');
    expect(registry.claim({ ...baseClaim, sessionId: 'sess-2' }).outcome).toBe('new');
  });

  it('expires accepted receipts after the ttl so the same id can never auto-replay', () => {
    let time = 1_000;
    const registry = createRegistry({ now: () => time, ttlMs: 50 });
    const claim = registry.claim(baseClaim);
    claim.entry.settle({ accepted: true, receipt: { accepted: true, messageId: 'msg-1' } });
    expect(registry.claim(baseClaim).outcome).toBe('accepted');

    time += 49;
    expect(registry.claim(baseClaim).outcome).toBe('accepted');
    time += 2;
    // Retention gone: the same id is rejected as expired (never a silent
    // re-execution). Callers must use a new operation id after expiry.
    expect(registry.claim(baseClaim).outcome).toBe('expired');
    expect(registry.query({ kind: 'prompt', sessionId: 'sess-1', operationId: 'op-1', streamEpoch }).status).toBe('expired');
    // A distinct id is still a distinct intent and executes.
    expect(registry.claim({ ...baseClaim, operationId: 'op-2' }).outcome).toBe('new');
  });

  it('bounds retention by evicting the oldest accepted receipts', () => {
    const registry = createRegistry({ maxEntries: 2 });
    const one = registry.claim({ ...baseClaim, operationId: 'op-1' });
    one.entry.settle({ accepted: true, receipt: { accepted: true, messageId: 'm1' } });
    const two = registry.claim({ ...baseClaim, operationId: 'op-2' });
    two.entry.settle({ accepted: true, receipt: { accepted: true, messageId: 'm2' } });
    const three = registry.claim({ ...baseClaim, operationId: 'op-3' });
    three.entry.settle({ accepted: true, receipt: { accepted: true, messageId: 'm3' } });

    // Evicted acceptances leave an expired tombstone: never a false
    // acceptance and never an automatic re-execution with the same id.
    expect(registry.claim({ ...baseClaim, operationId: 'op-1' }).outcome).toBe('expired');
    expect(registry.claim({ ...baseClaim, operationId: 'op-2' }).outcome).toBe('accepted');
    expect(registry.claim({ ...baseClaim, operationId: 'op-3' }).outcome).toBe('accepted');
  });

  it('never evicts a pending claim so concurrent duplicates keep sharing the outcome', () => {
    const registry = createRegistry({ maxEntries: 2 });
    const pending = registry.claim({ ...baseClaim, operationId: 'op-pending' });
    expect(pending.outcome).toBe('new');
    for (let index = 0; index < 5; index += 1) {
      const claim = registry.claim({ ...baseClaim, operationId: `op-fill-${index}` });
      claim.entry.settle({ accepted: true, receipt: { accepted: true, messageId: `m-${index}` } });
    }
    const duplicate = registry.claim({ ...baseClaim, operationId: 'op-pending' });
    expect(duplicate.outcome).toBe('pending');
  });

  it('produces order-independent stable fingerprints', () => {
    expect(stableFingerprint({ a: 1, b: 'x' })).toBe(stableFingerprint({ b: 'x', a: 1 }));
    expect(stableFingerprint({ a: 1 })).not.toBe(stableFingerprint({ a: 2 }));
    expect(stableFingerprint({ a: undefined })).toBe(stableFingerprint({}));
    expect(stableFingerprint(['x', 1])).toBe(stableFingerprint(['x', 1]));
    expect(stableFingerprint(null)).toBe('null');
  });

  it('validates operation ids without wildcard or control characters', () => {
    expect(isValidSendOperationId('op_1')).toBe(true);
    expect(isValidSendOperationId('qm:abc.def-2')).toBe(true);
    expect(isValidSendOperationId('')).toBe(false);
    expect(isValidSendOperationId('-leading-symbol')).toBe(false);
    expect(isValidSendOperationId('has spaces')).toBe(false);
    expect(isValidSendOperationId(`x${'y'.repeat(128)}`)).toBe(false);
    expect(isValidSendOperationId(undefined)).toBe(false);
  });

  it('query() distinguishes pending, accepted, unknown, and expired with no false acceptance', () => {
    let time = 1_000;
    const registry = createRegistry({ now: () => time, ttlMs: 50, maxEntries: 10 });
    const key = { kind: 'prompt', sessionId: 'sess-1', operationId: 'op-q', streamEpoch };
    expect(registry.query({ ...key, streamEpoch: undefined }).status).toBe('unknown');
    expect(registry.query(key).status).toBe('unknown');

    const fresh = registry.claim({ kind: 'prompt', sessionId: 'sess-1', operationId: 'op-q', streamEpoch, fingerprint: baseClaim.fingerprint });
    expect(fresh.outcome).toBe('new');
    expect(registry.query(key).status).toBe('pending');

    fresh.entry.settle({ accepted: true, receipt: { accepted: true, messageId: 'm1' } });
    expect(registry.query(key)).toMatchObject({ status: 'accepted', receipt: { accepted: true, messageId: 'm1' } });

    // Exact identity: wrong kind/session/operation is unknown, never accepted.
    expect(registry.query({ ...key, kind: 'steer' }).status).toBe('unknown');
    expect(registry.query({ ...key, sessionId: 'sess-2' }).status).toBe('unknown');
    expect(registry.query({ ...key, operationId: 'op-other' }).status).toBe('unknown');

    time += 51;
    // After TTL the receipt is gone: expired, never a stale acceptance.
    expect(registry.query(key).status).toBe('expired');
    expect(registry.query(key).receipt).toBeUndefined();
    // A retry after expiry is rejected as expired — it must not
    // automatically re-execute. The caller needs a new operation id.
    const retry = registry.claim({ kind: 'prompt', sessionId: 'sess-1', operationId: 'op-q', streamEpoch, fingerprint: baseClaim.fingerprint });
    expect(retry.outcome).toBe('expired');
    expect(registry.query(key).status).toBe('expired');
    expect(registry.query(key).receipt).toBeUndefined();
  });

  it('rejections before Pi leave no tombstone while evicted acceptances expire', () => {
    const registry = createRegistry({ maxEntries: 2 });
    const rejected = registry.claim({ ...baseClaim, operationId: 'op-reject' });
    rejected.entry.settle({ accepted: false, error: new Error('busy') });
    // Nothing executed: unknown (reusable), not expired.
    expect(registry.query({ kind: 'prompt', sessionId: 'sess-1', operationId: 'op-reject', streamEpoch }).status).toBe('unknown');

    const one = registry.claim({ ...baseClaim, operationId: 'op-1' });
    one.entry.settle({ accepted: true, receipt: { accepted: true, messageId: 'm1' } });
    const two = registry.claim({ ...baseClaim, operationId: 'op-2' });
    two.entry.settle({ accepted: true, receipt: { accepted: true, messageId: 'm2' } });
    const three = registry.claim({ ...baseClaim, operationId: 'op-3' });
    three.entry.settle({ accepted: true, receipt: { accepted: true, messageId: 'm3' } });
    // Oldest acceptance evicted: expired tombstone, never a false acceptance.
    expect(registry.query({ kind: 'prompt', sessionId: 'sess-1', operationId: 'op-1', streamEpoch }).status).toBe('expired');
    expect(registry.query({ kind: 'prompt', sessionId: 'sess-1', operationId: 'op-2', streamEpoch }).status).toBe('accepted');
  });

  it('never expires an active pending claim so duplicates cannot double-execute', async () => {
    let time = 1_000;
    const registry = createRegistry({ now: () => time, pendingTtlMs: 20, maxEntries: 4, maxPending: 2 });
    const first = registry.claim({ ...baseClaim, operationId: 'op-leak-1' });
    const second = registry.claim({ ...baseClaim, operationId: 'op-leak-2' });
    expect(first.outcome).toBe('new');
    expect(second.outcome).toBe('new');
    // Pending bound: a third distinct pending claim is overloaded, never executed.
    expect(registry.claim({ ...baseClaim, operationId: 'op-leak-3' }).outcome).toBe('overloaded');
    time += 21;
    // Active ownership survives past pendingTtlMs: expiring here would let a
    // duplicate re-execute the same operation, so duplicates still share.
    expect(registry.claim({ ...baseClaim, operationId: 'op-leak-1' }).outcome).toBe('pending');
    expect(registry.query({ kind: 'prompt', sessionId: 'sess-1', operationId: 'op-leak-1', streamEpoch }).status).toBe('pending');
    expect(registry.claim({ ...baseClaim, operationId: 'op-after' }).outcome).toBe('overloaded');
    // Settling frees the slot: a busy rejection shares with its duplicate
    // and leaves the id reusable (nothing executed).
    const duplicate = registry.claim({ ...baseClaim, operationId: 'op-leak-1' });
    expect(duplicate.outcome).toBe('pending');
    first.entry.settle({ accepted: false, error: Object.assign(new Error('busy'), { code: 'SESSION_BUSY' }) });
    await expect(duplicate.settled).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(registry.query({ kind: 'prompt', sessionId: 'sess-1', operationId: 'op-leak-1', streamEpoch }).status).toBe('unknown');
    expect(registry.claim({ ...baseClaim, operationId: 'op-leak-1' }).outcome).toBe('new');
    expect(registry.pendingSize).toBeLessThanOrEqual(2);
    expect(registry.expiredSize).toBeLessThanOrEqual(4);
  });
});
