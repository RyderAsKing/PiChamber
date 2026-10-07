// Daemon-owned "pending input" state: whether a session is blocked waiting
// for the user. Every device learns it without opening the session through
// `sessions.list` rows, snapshots, details, `sessions.pendingInput`, and
// `session.input` events. Sources are daemon-hosted blocking requests (today
// Pi extension dialogs) and registered session engines reporting through the
// engine contract. The contract never assumes a Pi runtime.
export const PENDING_INPUT_KINDS = Object.freeze(['input', 'approval']);

export const MAX_PENDING_INPUT_COUNT = 99;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Normalize a wire summary. `null` means authoritatively nothing pending;
// `undefined` means unknown (older daemon) or malformed. Unknown kind
// strings normalize to 'input'; a zero count normalizes to null.
export const normalizePendingInputSummary = (value) => {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const rawCount = value.count;
  if (typeof rawCount !== 'number' || !Number.isSafeInteger(rawCount)) return undefined;
  if (rawCount <= 0) {
    if (rawCount === 0) return null;
    return undefined;
  }
  if (typeof value.since !== 'number' || !Number.isFinite(value.since) || value.since <= 0) return undefined;
  const kind = typeof value.kind === 'string' && PENDING_INPUT_KINDS.includes(value.kind) ? value.kind : 'input';
  return {
    count: Math.min(rawCount, MAX_PENDING_INPUT_COUNT),
    kind,
    since: value.since,
  };
};

const sameSummary = (left, right) => {
  if (left === null && right === null) return true;
  if (!left || !right) return false;
  return left.count === right.count && left.kind === right.kind && left.since === right.since;
};

const validId = (value) => typeof value === 'string' && value.length > 0;

// Small synchronous index with no timers. Hosted requests carry insertion
// order so ties on `since` resolve deterministically. When a session has
// both hosted requests and an engine summary, hosted wins.
export const createPendingInputIndex = ({ publish, now = Date.now, onHostedSessionSettled } = {}) => {
  // sessionId -> { directory, hosted: Map(requestId -> { since, kind, order }),
  //   engine: summary|null }
  const bySession = new Map();
  let order = 0;

  const entryFor = (sessionId) => bySession.get(sessionId);

  const deriveHosted = (entry) => {
    if (!entry || entry.hosted.size === 0) return null;
    let oldest;
    for (const record of entry.hosted.values()) {
      if (!oldest || record.since < oldest.since
        || (record.since === oldest.since && record.order < oldest.order)) {
        oldest = record;
      }
    }
    return {
      count: Math.min(entry.hosted.size, MAX_PENDING_INPUT_COUNT),
      kind: oldest.kind,
      since: oldest.since,
    };
  };

  const derivedFor = (entry) => deriveHosted(entry) ?? entry?.engine ?? null;

  const maybePublish = (sessionId, entry) => {
    const summary = derivedFor(entry);
    if (sameSummary(entry?.published ?? null, summary)) return;
    if (entry) entry.published = summary;
    const directory = entry?.directory;
    if (typeof publish === 'function' && typeof directory === 'string' && directory.length > 0) {
      publish('session.input', { pending: summary }, sessionId, directory);
    }
  };

  // A settled entry has published `null`, so dropping it keeps the index
  // bounded by sessions that currently need input.
  const dropIfSettled = (sessionId, entry) => {
    if (entry.hosted.size === 0 && entry.engine === null) bySession.delete(sessionId);
  };

  const open = ({ sessionId, directory, requestId, kind = 'input' } = {}) => {
    if (!validId(sessionId) || !validId(requestId)) return;
    if (typeof directory !== 'string' || directory.length === 0) return;
    let entry = bySession.get(sessionId);
    if (!entry) {
      entry = { directory, hosted: new Map(), engine: null, published: null };
      bySession.set(sessionId, entry);
    }
    entry.directory = directory;
    if (entry.hosted.has(requestId)) return;
    order += 1;
    entry.hosted.set(requestId, {
      since: now(),
      kind: typeof kind === 'string' && PENDING_INPUT_KINDS.includes(kind) ? kind : 'input',
      order,
    });
    maybePublish(sessionId, entry);
  };

  const close = (sessionId, requestId) => {
    if (!validId(sessionId) || !validId(requestId)) return;
    const entry = bySession.get(sessionId);
    if (!entry || !entry.hosted.delete(requestId)) return;
    const settled = entry.hosted.size === 0;
    maybePublish(sessionId, entry);
    dropIfSettled(sessionId, entry);
    if (settled) {
      try {
        onHostedSessionSettled?.(sessionId);
      } catch {}
    }
  };

  const applyEngineSummary = (sessionId, directory, summary) => {
    if (!validId(sessionId)) return;
    if (typeof directory !== 'string' || directory.length === 0) return;
    if (summary !== null && !isRecord(summary)) return;
    let entry = bySession.get(sessionId);
    if (!entry) {
      entry = { directory, hosted: new Map(), engine: null, published: null };
      bySession.set(sessionId, entry);
    }
    entry.directory = directory;
    entry.engine = summary;
    maybePublish(sessionId, entry);
    dropIfSettled(sessionId, entry);
  };

  const summaryFor = (sessionId) => {
    if (!validId(sessionId)) return null;
    return derivedFor(entryFor(sessionId));
  };

  const hasHostedRequests = (sessionId) => {
    if (!validId(sessionId)) return false;
    return (entryFor(sessionId)?.hosted.size ?? 0) > 0;
  };

  const list = () => {
    const rows = [];
    for (const [sessionId, entry] of bySession) {
      const pending = derivedFor(entry);
      if (!pending) continue;
      rows.push({ sessionId, directory: entry.directory, pending });
    }
    rows.sort((left, right) => left.pending.since - right.pending.since);
    return rows;
  };

  const forgetSession = (sessionId) => {
    if (!validId(sessionId)) return;
    bySession.delete(sessionId);
  };

  const clear = () => {
    for (const [sessionId, entry] of [...bySession]) {
      if (!derivedFor(entry)) {
        bySession.delete(sessionId);
        continue;
      }
      entry.hosted.clear();
      entry.engine = null;
      entry.published = null;
      if (typeof publish === 'function') {
        publish('session.input', { pending: null }, sessionId, entry.directory);
      }
      bySession.delete(sessionId);
    }
  };

  return {
    open,
    close,
    applyEngineSummary,
    summaryFor,
    hasHostedRequests,
    list,
    forgetSession,
    clear,
  };
};
