/**
 * Send-intent deduplication registry.
 *
 * Owns the authoritative execution boundary for prompt/steer/followUp sends
 * (finding #3). A client labels every send intent with a stable
 * `operationId`; the daemon claims the id here BEFORE activating Pi or
 * consuming anything. The registry guarantees:
 *
 * - One intent executes at most once per daemon process lifetime. A retry of
 *   the same intent (transport retry, manual confirmation, queue backoff)
 *   returns the original acceptance receipt instead of invoking Pi again.
 * - Concurrent duplicates of a still-pending intent share the original
 *   outcome: they await the first execution's settlement instead of racing it.
 *   Pending claims are never evicted while their owner is still active:
 *   expiring a still-executing claim would let a duplicate re-execute the
 *   same operation, so pending entries stay until their owner settles and
 *   duplicates always share (never re-execute a pending-expired operation).
 * - The same id with a different payload (text, model, thinking, message id,
 *   attachments, or delivery kind) is rejected as
 *   `OPERATION_PAYLOAD_MISMATCH` — a duplicated id never silently executes
 *   unrelated work. `streamEpoch` (stamped only by the stream-epoch split)
 *   is intentionally NOT fingerprinted, so adding or omitting it on a retry
 *   in the same lifetime never causes a mismatch. This split performs no
 *   epoch guard; the stream-epoch branch enforces `STALE_STREAM_EPOCH`
 *   before the claim.
 * - Scope is `kind + sessionId + operationId`, so the same id on a different
 *   session or delivery kind is a different intent.
 *
 * Retention is bounded and explicit: accepted receipts are kept for `ttlMs`
 * and at most `maxEntries` accepted receipts are retained (oldest evicted).
 * Evicted or TTL-expired acceptances leave a bounded `expired` tombstone
 * (capped at `maxEntries`) so `query()` can distinguish `expired` — "was
 * seen but retention is gone, outcome unknown, never assume success" —
 * from `unknown` — "never seen in this daemon lifetime". A later retry
 * with the same id after expiry is rejected as `expired` (OPERATION_EXPIRED),
 * never an automatic re-execution: callers must treat the retention window
 * as the only safe retry window and use a new operation id afterwards.
 * Pending claims are bounded separately by `maxPending` entries: an unsettled
 * pending entry is never evicted (its duplicates share the outcome), and a
 * new distinct pending claim past the bound is rejected as `overloaded`
 * (SESSION_BUSY, retry with backoff) so the map cannot grow without bound
 * while active ownership is preserved. `pendingTtlMs` is retained as a
 * constructor-validated bound for future waiter timeouts, but pending entries
 * are not auto-expired: a leaked claim occupies one of `maxPending` slots
 * until restart instead of risking a duplicate execution. The registry is
 * in-memory per daemon process: a daemon restart loses receipts, which is
 * the documented crash-window — a client retry across a restart may
 * re-execute an accepted intent, and clients must not replay uncertain
 * sends across restarts (the stream-epoch split adds a verified-epoch guard
 * for this window; this split documents the raw window without it). After `ttlMs` the receipt is
 * gone: a retry with the same id is rejected as expired, never a silent
 * deduplicated success nor an automatic re-execution — callers must treat
 * the retention window as the only safe retry window and use a new
 * operation id afterwards.
 *
 * Only acceptances are retained. Request-path rejections happen before Pi is
 * invoked, so nothing executed and a later retry with the same id is safe;
 * pending duplicates still share the original rejection so a concurrent
 * duplicate never proceeds on its own. Every claim — including
 * pending-overload (SESSION_BUSY) and validation rejections — must
 * settle its entry; an unsettled pending entry is a hang, not a queue.
 */

const SEND_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const isValidSendOperationId = (value) => (
  typeof value === 'string' && SEND_OPERATION_ID_PATTERN.test(value)
);

/** Deterministic stringify so payload fingerprints are order-independent. */
export const stableFingerprint = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableFingerprint).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableFingerprint(value[key])}`).join(',')}}`;
};

const entryKey = ({ kind, sessionId, operationId }) => `${kind}\u0000${sessionId}\u0000${operationId}`;

export const createSendOperationRegistry = ({
  now = () => Date.now(),
  ttlMs = 10 * 60 * 1_000,
  maxEntries = 1_024,
  maxPending = 256,
  pendingTtlMs = 30_000,
} = {}) => {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('send operation ttlMs must be positive');
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) throw new Error('send operation maxEntries must be positive');
  if (!Number.isFinite(maxPending) || maxPending <= 0) throw new Error('send operation maxPending must be positive');
  if (!Number.isFinite(pendingTtlMs) || pendingTtlMs <= 0) throw new Error('send operation pendingTtlMs must be positive');

  const entries = new Map();
  // Bounded tombstones for ids whose acceptance is gone (TTL expiry or
  // oldest-evicted). Lets `query()` report `expired` instead of falsely
  // implying `unknown`/safe-to-retry or `accepted`. Rejections before Pi ran
  // leave no tombstone: nothing executed, so the id is `unknown`/reusable.
  // A fresh claim clears its tombstone; tombstones are FIFO-capped at
  // `maxEntries` so `expired` degrades to `unknown` under pressure — both
  // mean "no guarantee, outcome unknown", never a false acceptance.
  const expiredKeys = new Map();
  const rememberExpired = (key) => {
    expiredKeys.delete(key);
    expiredKeys.set(key, now());
    while (expiredKeys.size > maxEntries) {
      const oldest = expiredKeys.keys().next();
      if (oldest.done) break;
      expiredKeys.delete(oldest.value);
    }
  };

  const countPending = () => {
    let count = 0;
    for (const entry of entries.values()) if (entry.state === 'pending') count += 1;
    return count;
  };

  // Expired accepted receipts become `expired` tombstones. Pending claims
  // are never auto-expired: evicting a still-executing claim would let a
  // duplicate re-execute the same operation, and rejecting its waiters as
  // SESSION_BUSY would falsely imply nothing executed. Pending entries stay
  // until their owner settles; `maxPending` bounds the map instead.
  const evictExpired = () => {
    const timestamp = now();
    for (const [key, entry] of entries) {
      if (entry.state === 'accepted' && timestamp >= entry.expiresAt) {
        entries.delete(key);
        rememberExpired(key);
      }
    }
  };
  const trimToBound = () => {
    // The bound applies to retained receipts; pending claims are transient and
    // must never evict an accepted receipt (their duplicates share the outcome).
    while (entries.size > maxEntries) {
      let accepted = 0;
      let oldestAccepted;
      for (const [key, entry] of entries) {
        if (entry.state === 'accepted') {
          accepted += 1;
          if (!oldestAccepted) oldestAccepted = key;
        }
      }
      if (accepted <= maxEntries) break;
      entries.delete(oldestAccepted);
      rememberExpired(oldestAccepted);
    }
  };

  const claim = ({ kind, sessionId, operationId, fingerprint }) => {
    const key = entryKey({ kind, sessionId, operationId });
    evictExpired();
    const existing = entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { outcome: 'mismatch' };
      if (existing.state === 'accepted') {
        return { outcome: 'accepted', receipt: existing.receipt, deduplicated: true };
      }
      // Still pending: the duplicate shares the original outcome, even past
      // `pendingTtlMs`. Expiring here would let a still-executing operation
      // duplicate, so pending never becomes `expired` while active.
      return { outcome: 'pending', settled: existing.settled };
    }
    // After retention the same id must not automatically re-execute: the
    // tombstone blocks reuse and the caller must use a new operation id.
    if (expiredKeys.has(key)) return { outcome: 'expired' };
    if (countPending() >= maxPending) return { outcome: 'overloaded' };
    let settleWaiters;
    let rejectWaiters;
    const settled = new Promise((resolve, reject) => {
      settleWaiters = resolve;
      rejectWaiters = reject;
    });
    // A claim whose id is rejected usually has no duplicate awaiting it; mark
    // the shared promise handled so the rejection reaches only real waiters.
    settled.then(undefined, () => {});
    const entry = {
      state: 'pending',
      fingerprint,
      settled,
      rejectWaiters,
      pendingExpiresAt: now() + pendingTtlMs,
      settle: (result) => {
        if (entry.state !== 'pending') return;
        if (result.accepted) {
          entry.state = 'accepted';
          entry.receipt = result.receipt;
          entry.expiresAt = now() + ttlMs;
          delete entry.pendingExpiresAt;
          trimToBound();
          settleWaiters(result);
          return;
        }
        // A rejection happened before Pi ran: nothing executed, so forget
        // the claim and let a later retry of the same id proceed.
        entries.delete(key);
        rejectWaiters(result.error);
      },
    };
    entries.set(key, entry);
    expiredKeys.delete(key);
    trimToBound();
    return { outcome: 'new', entry };
  };

  const getReceipt = ({ kind, sessionId, operationId }) => {
    evictExpired();
    if (typeof kind === 'string' && kind.length > 0) {
      const entry = entries.get(entryKey({ kind, sessionId, operationId }));
      if (entry?.state === 'accepted') return { receipt: entry.receipt, fingerprint: entry.fingerprint };
      return undefined;
    }
    for (const [key, entry] of entries) {
      if (entry.state !== 'accepted') continue;
      // Keys are `kind + NUL + sessionId + NUL + operationId`; match the
      // session+operation suffix when the caller did not specify a kind.
      if (key.endsWith(`\u0000${sessionId}\u0000${operationId}`)) {
        return { receipt: entry.receipt, fingerprint: entry.fingerprint, kind: key.slice(0, key.indexOf('\u0000')) };
      }
    }
    return undefined;
  };

  // Exact-identity receipt lookup for `sessions.sendReceipt`: requires the
  // full `kind + sessionId + operationId` key. Returns one of
  // `accepted` (retained receipt), `pending` (still-accepting claim),
  // `expired` (seen but retention gone — outcome unknown, never assume
  // success), or `unknown` (never seen in this lifetime, or rejected before
  // Pi ran so nothing executed). Never returns a receipt after expiry.
  const query = ({ kind, sessionId, operationId }) => {
    evictExpired();
    if (typeof kind !== 'string' || kind.length === 0
      || typeof sessionId !== 'string' || sessionId.length === 0
      || typeof operationId !== 'string' || operationId.length === 0) {
      return { status: 'unknown' };
    }
    const key = entryKey({ kind, sessionId, operationId });
    const entry = entries.get(key);
    if (entry?.state === 'accepted') {
      return { status: 'accepted', receipt: entry.receipt, fingerprint: entry.fingerprint };
    }
    if (entry?.state === 'pending') {
      return { status: 'pending', fingerprint: entry.fingerprint };
    }
    if (expiredKeys.has(key)) return { status: 'expired' };
    return { status: 'unknown' };
  };

  return {
    claim,
    getReceipt,
    query,
    get size() { return entries.size; },
    get pendingSize() { return countPending(); },
    get expiredSize() { return expiredKeys.size; },
  };
};
