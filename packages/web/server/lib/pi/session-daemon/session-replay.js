/**
 * Byte- and count-bounded contiguous replay suffix for daemon events.
 *
 * The daemon broadcasts every event live at full fidelity and retains only a
 * recent contiguous suffix for reconnect replay. Retention is bounded by both
 * event count and serialized wire bytes so cumulative tool-output snapshots
 * cannot grow replay memory without bound. Eviction removes whole oldest
 * events first and never truncates content. A reconnect replays the retained
 * suffix only when its cursor is contiguous with it; otherwise it must take
 * the authoritative `session.snapshot` path.
 */

// Preserve the historical 1k-event ceiling and add an encoded-byte ceiling.
// 8 MiB of encoded wire bytes is a conservative initial protection: it holds
// thousands of small deltas/lifecycle events (typically well under 1 KiB
// encoded) or roughly a hundred recent 64 KiB cumulative tool snapshots,
// while keeping any single reconnect burst below the 16 MiB IPC frame
// ceiling. Older history remains available through `sessions.open` paging
// and `sessions.messages`; the snapshot + `sessions.open` hydrate path covers
// the live edge.
//
// The budget counts encoded wire bytes (Buffer.byteLength of the cached line),
// not heap: UTF-16 strings, JS object overhead, and shared references mean
// encoded bytes do not equal heap bytes, so no heap claim is made here.
//
// Snapshots assign sequence numbers without replay insertion, so numeric gaps
// from private snapshots are intentional: contiguity means "cursor is at or
// after oldest-retained - 1", not "every integer is retained". The retained
// suffix stays in broadcast order.
export const MAX_REPLAY_EVENTS = 1_024;
export const MAX_REPLAY_BYTES = 8 * 1024 * 1024;

export function createSessionReplayLog({ maxEvents = MAX_REPLAY_EVENTS, maxBytes = MAX_REPLAY_BYTES } = {}) {
  const entries = [];
  let retainedBytes = 0;

  const append = (sequence, sessionId, line) => {
    const bytes = Buffer.byteLength(line);
    if (bytes > maxBytes) {
      // An oversized single event still broadcasts live at full fidelity but
      // is not retained. Retaining the prior suffix alongside later events
      // would leave a hole at this sequence; clearing preserves the
      // contiguous-suffix invariant so a cursor that missed this event falls
      // back to a snapshot instead of replaying through the gap. A cursor
      // already at/after this sequence remains contiguous with later events.
      entries.length = 0;
      retainedBytes = 0;
      return { retained: false, bytes, oversized: true };
    }
    entries.push({ sequence, sessionId, line, bytes });
    retainedBytes += bytes;
    while (entries.length > maxEvents || retainedBytes > maxBytes) {
      const evicted = entries.shift();
      retainedBytes -= evicted.bytes;
    }
    if (retainedBytes < 0) retainedBytes = 0;
    return { retained: true, bytes };
  };

  const canReplay = (fromSequence, latestSequence) => {
    if (!Number.isSafeInteger(fromSequence) || fromSequence < 0) return false;
    if (entries.length === 0) return false;
    const oldest = entries[0].sequence;
    if (!Number.isSafeInteger(oldest)) return false;
    if (fromSequence < oldest - 1) return false;
    // A cursor beyond the latest assigned sequence has no contiguous basis:
    // it must resynchronize from a snapshot rather than wait on an empty replay.
    if (Number.isSafeInteger(latestSequence) && fromSequence > latestSequence) return false;
    return true;
  };

  function* linesAfter(fromSequence, requestedSessionId) {
    for (const entry of entries) {
      if (entry.sequence > fromSequence
        && (!requestedSessionId || entry.sessionId === requestedSessionId)) {
        yield entry.line;
      }
    }
  }

  return {
    get size() {
      return entries.length;
    },
    get retainedBytes() {
      return retainedBytes;
    },
    get oldestSequence() {
      return entries[0]?.sequence;
    },
    get newestSequence() {
      return entries.length > 0 ? entries[entries.length - 1].sequence : undefined;
    },
    append,
    canReplay,
    linesAfter,
  };
}
