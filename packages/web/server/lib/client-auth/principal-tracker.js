/**
 * Live principal tracking and credential-revocation propagation.
 *
 * Two focused pieces:
 *
 * - `createPrincipalTracker` tracks live connections (SSE event streams,
 *   terminal/dictation WebSocket upgrades) under the principal derived from
 *   trusted auth at the owning boundary — never under client-supplied IDs.
 *   Closing is synchronous and immediate; entries are removed when the
 *   connection ends naturally, fails, or the owner detaches a pending one.
 *
 *   Resource bound: at most `maxPerPrincipal` live connections per principal
 *   and `maxTotal` live connections globally (defaults 50 / 1000). A new
 *   registration beyond either bound is reject-closed synchronously
 *   (`close('over-limit')`) without evicting unrelated entries. Memory is
 *   therefore O(maxTotal) entries. After `dispose()` new registrations are
 *   reject-closed with `close('shutdown')`.
 *
 * - `createRevocationCoordinator` wires revocation to the tracker. Revocation
 *   happens against the shared on-disk credential store
 *   (`remote-clients.json`, guarded by a cross-process file lock), which more
 *   than one process can write (the server, the `pichamber connect-url`
 *   pairing CLI). There is no reliable cross-process revocation emitter, so
 *   propagation is defined in two layers, and the emitter layer must never be
 *   claimed as sufficient on its own:
 *
 *   1. In-process: the auth-owning revoke route calls `clientRevoked()` right
 *      after the store write commits, so connections are closed inside that
 *      request — immediate, bounded latency, no timers involved.
 *   2. Cross-process: a bounded poll of `listRevokedClientIds()` (default
 *      every 15 seconds, timer unref'd) converges this process with
 *      revocations committed by any other process sharing the data directory.
 *      A failed poll tick is transient: current state is kept and the next
 *      tick retries; it is never treated as an authoritative empty result.
 *
 * Verify-registration barrier: bearer/URL-token validation awaits the store
 * (and the WebSocket path additionally awaits the origin gate), so a
 * revocation can commit and close between verification and registration. The
 * coordinator therefore remembers every in-process revocation
 * (`revokedClientIds`, bounded FIFO, default 2000 entries) and a monotonic
 * global-invalidation generation (bumped by every `revokeAllLive()`).
 * `trackLiveConnection()` checks both synchronously — revoked-ID match
 * reject-closes with `close('credential-revoked')`, stale-generation match
 * reject-closes with `close('global-invalidation')` — without trusting the
 * caller's claim that verification passed. The synchronous check+insert is
 * atomic on the event loop, so no in-process revoke can slip between them.
 * Auth boundaries must capture `getGeneration()` BEFORE their first await
 * and pass it as `generation` at track time; the WebSocket upgrade path must
 * additionally capture before the origin check and must not call
 * `handleUpgrade` when the returned entry is inactive (`active === false`).
 *
 * Latency guarantee (healthy storage only): a revocation observed by this
 * process closes its tracked connections synchronously within the revoking
 * call; a revocation committed by another process is applied within one poll
 * interval after the next SUCCESSFUL poll. A failed poll tick provides no
 * guarantee — already-established cross-process connections stay open until
 * a later tick succeeds (degraded retention), while new bearer/URL-token
 * establishment remains authoritatively gated by direct store/secret reads
 * and is unaffected by poll health.
 *
 * Topology: one server process per data directory. The pairing CLI shares
 * only `remote-clients.json` (never the JWT secret); JWT-secret rotation for
 * browser sessions is in-process only and has no cross-process poll. See
 * `../ui-auth/DOCUMENTATION.md` for the browser-session contract.
 */

const DEFAULT_REVOCATION_POLL_INTERVAL_MS = 15_000;

export const MAX_LIVE_CONNECTIONS_PER_PRINCIPAL = 50;
export const MAX_LIVE_CONNECTIONS_GLOBAL = 1000;
export const MAX_REMEMBERED_REVOKED_CLIENTS = 2000;

export const createPrincipalTracker = ({
  onCloseError,
  maxPerPrincipal = MAX_LIVE_CONNECTIONS_PER_PRINCIPAL,
  maxTotal = MAX_LIVE_CONNECTIONS_GLOBAL,
} = {}) => {
  const byPrincipal = new Map();
  let entrySequence = 0;
  let trackerDisposed = false;

  const remove = (entry) => {
    const set = byPrincipal.get(entry.principal);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) byPrincipal.delete(entry.principal);
  };

  const rejectClose = (principal, close, reason) => {
    const entry = {
      id: ++entrySequence,
      principal,
      active: false,
      revoke: () => false,
      end: () => {},
    };
    try {
      close(reason);
    } catch (error) {
      onCloseError?.({ entry, error });
    }
    return entry;
  };

  const tracker = {
    /**
     * Track one live connection under `principal`. `close(reason)` must end
     * the underlying transport synchronously (destroy the response or socket).
     * Returns an entry whose `revoke(reason)` closes it exactly once and
     * whose `end()` detaches it when the transport ended by itself — both are
     * idempotent, so a revoke racing a natural close is safe.
     *
     * When the tracker is disposed or either resource bound is reached, the
     * new connection is reject-closed synchronously and an inactive entry
     * (`active === false`) is returned without touching unrelated entries.
     */
    track({ principal, close }) {
      if (typeof principal !== 'string' || principal.length === 0) {
        throw new Error('principal is required');
      }
      if (typeof close !== 'function') {
        throw new Error('close callback is required');
      }
      if (trackerDisposed) {
        return rejectClose(principal, close, 'shutdown');
      }
      const perPrincipal = byPrincipal.get(principal)?.size ?? 0;
      if (perPrincipal >= maxPerPrincipal) {
        return rejectClose(principal, close, 'over-limit');
      }
      if (tracker.size >= maxTotal) {
        return rejectClose(principal, close, 'over-limit');
      }
      const entry = {
        id: ++entrySequence,
        principal,
        active: true,
        revoke: (reason = 'revoked') => {
          if (!entry.active) return false;
          entry.active = false;
          remove(entry);
          try {
            close(reason);
          } catch (error) {
            // One failing close must not strand the remaining connections or
            // the caller; the failure signal stays available via onCloseError.
            onCloseError?.({ entry, error });
          }
          return true;
        },
        end: () => {
          if (!entry.active) return;
          entry.active = false;
          remove(entry);
        },
      };
      let set = byPrincipal.get(principal);
      if (!set) {
        set = new Set();
        byPrincipal.set(principal, set);
      }
      set.add(entry);
      return entry;
    },

    /** Close every tracked connection of one principal. Returns the count. */
    closePrincipal: (principal, reason = 'revoked') => {
      const set = byPrincipal.get(principal);
      if (!set) return 0;
      let closed = 0;
      for (const entry of [...set]) {
        if (entry.revoke(reason)) closed += 1;
      }
      return closed;
    },

    /** Close every tracked connection. Used by global invalidation and shutdown. */
    closeAll: (reason = 'revoked') => {
      let closed = 0;
      for (const principal of [...byPrincipal.keys()]) {
        closed += tracker.closePrincipal(principal, reason);
      }
      return closed;
    },

    countPrincipal: (principal) => byPrincipal.get(principal)?.size ?? 0,
    principals: () => [...byPrincipal.keys()],
    get size() {
      let total = 0;
      for (const set of byPrincipal.values()) total += set.size;
      return total;
    },
    get maxPerPrincipal() {
      return maxPerPrincipal;
    },
    get maxTotal() {
      return maxTotal;
    },
    get disposed() {
      return trackerDisposed;
    },
    /**
     * Mark disposed and close remaining entries synchronously. Later `track`
     * calls reject-close with `close('shutdown')`.
     */
    dispose: (reason = 'shutdown') => {
      trackerDisposed = true;
      return tracker.closeAll(reason);
    },
  };
  return tracker;
};

export const createRevocationCoordinator = ({
  listRevokedClientIds,
  pollIntervalMs = DEFAULT_REVOCATION_POLL_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  maxPerPrincipal = MAX_LIVE_CONNECTIONS_PER_PRINCIPAL,
  maxTotal = MAX_LIVE_CONNECTIONS_GLOBAL,
  maxRevoked = MAX_REMEMBERED_REVOKED_CLIENTS,
  onCloseError,
} = {}) => {
  if (typeof listRevokedClientIds !== 'function') {
    throw new Error('listRevokedClientIds is required');
  }
  const tracker = createPrincipalTracker({ maxPerPrincipal, maxTotal, onCloseError });
  // Authoritative in-process revocation memory: every clientRevoked() and
  // every successful poll inserts here synchronously, so a track racing the
  // verify await is rejected even though verification passed moments earlier.
  // Bounded FIFO: beyond maxRevoked the oldest ID is evicted and that ID
  // falls back to establishment-time store checks plus the next poll.
  const revokedClientIds = new Set();
  // Monotonic global-invalidation generation for browser-secret rotation.
  // Auth captures getGeneration() before its first await; track rejects when
  // the captured value is stale. Never reset; a Number is sufficient.
  let globalGeneration = 0;
  let pollTimer = null;
  let disposed = false;
  let pollInFlight = false;
  let coordinatorSequence = 0;

  const rememberRevoked = (clientId) => {
    if (typeof clientId !== 'string' || clientId.length === 0) return;
    if (revokedClientIds.has(clientId)) return;
    if (revokedClientIds.size >= maxRevoked) {
      const oldest = revokedClientIds.values().next().value;
      revokedClientIds.delete(oldest);
    }
    revokedClientIds.add(clientId);
  };

  const inactiveEntry = (principal) => ({
    id: ++coordinatorSequence,
    principal,
    active: false,
    revoke: () => false,
    end: () => {},
  });

  const rejectCloseQuiet = (principal, close, reason) => {
    const entry = inactiveEntry(principal);
    try {
      close(reason);
    } catch (error) {
      onCloseError?.({ entry, error });
    }
    return entry;
  };

  const closeRevokedClient = (clientId) => {
    if (typeof clientId !== 'string' || clientId.length === 0) return 0;
    rememberRevoked(clientId);
    if (disposed) return 0;
    return tracker.closePrincipal(`client:${clientId}`, 'credential-revoked');
  };

  const pollOnce = async () => {
    if (pollInFlight || disposed) return;
    pollInFlight = true;
    try {
      const revokedIds = await listRevokedClientIds();
      if (Array.isArray(revokedIds)) {
        for (const clientId of revokedIds) closeRevokedClient(clientId);
      }
    } catch {
      // A transient store read failure must not look like an authoritative
      // empty result; keep current state and let the next tick retry. While
      // polls fail, cross-process revocations of ESTABLISHED connections are
      // retained (degraded); new establishment stays authoritatively gated by
      // direct store/secret reads.
    } finally {
      pollInFlight = false;
    }
  };

  return {
    /** Close every tracked connection of a client revoked in THIS process. */
    clientRevoked: closeRevokedClient,
    /**
     * Close every tracked connection (global sign-out everywhere) and bump
     * the generation so late registrations captured before this call are
     * rejected at track time.
     */
    revokeAllLive: (reason = 'global-invalidation') => {
      globalGeneration += 1;
      if (disposed) return 0;
      return tracker.closeAll(reason);
    },
    /**
     * Register a verified live connection. `generation` must be the value of
     * `getGeneration()` captured BEFORE the caller's first auth await;
     * a stale generation reject-closes without trusting the caller's
     * principal. A `client:<id>` whose id is in revoked memory reject-closes
     * the same way. Resource bounds reject-close without evicting unrelated
     * entries. After `dispose()` every registration reject-closes.
     * Returns an inactive entry (`active === false`) on every rejection;
     * WebSocket upgrades must not call `handleUpgrade` for those.
     */
    trackLiveConnection: ({ principal, close, generation } = {}) => {
      if (typeof principal !== 'string' || principal.length === 0) {
        throw new Error('principal is required');
      }
      if (typeof close !== 'function') {
        throw new Error('close callback is required');
      }
      if (disposed) {
        return rejectCloseQuiet(principal, close, 'shutdown');
      }
      if (generation !== undefined && generation !== globalGeneration) {
        return rejectCloseQuiet(principal, close, 'global-invalidation');
      }
      if (principal.startsWith('client:')) {
        const clientId = principal.slice('client:'.length);
        if (clientId.length > 0 && revokedClientIds.has(clientId)) {
          return rejectCloseQuiet(principal, close, 'credential-revoked');
        }
      }
      return tracker.track({ principal, close });
    },
    countPrincipal: (principal) => tracker.countPrincipal(principal),
    principals: () => tracker.principals(),
    isClientRevoked: (clientId) =>
      typeof clientId === 'string' && clientId.length > 0 && revokedClientIds.has(clientId),
    getRevokedCount: () => revokedClientIds.size,
    getGeneration: () => globalGeneration,
    get maxPerPrincipal() {
      return tracker.maxPerPrincipal;
    },
    get maxTotal() {
      return tracker.maxTotal;
    },
    get maxRevoked() {
      return maxRevoked;
    },
    get liveConnectionCount() {
      return tracker.size;
    },
    /** Begin bounded cross-process convergence polling. Idempotent. */
    start: () => {
      if (disposed || pollTimer) return;
      pollTimer = setIntervalFn(() => { void pollOnce(); }, pollIntervalMs);
      if (typeof pollTimer?.unref === 'function') pollTimer.unref();
    },
    /**
     * Stop polling and, by default, close remaining tracked connections
     * synchronously (bounded shutdown cleanup). Later registrations are
     * reject-closed.
     */
    dispose: ({ closeConnections = true } = {}) => {
      disposed = true;
      let closed = 0;
      if (pollTimer) {
        clearIntervalFn(pollTimer);
        pollTimer = null;
      }
      if (closeConnections) {
        closed = tracker.closeAll('shutdown');
      }
      return closed;
    },
  };
};
