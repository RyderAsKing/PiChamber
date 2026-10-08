// Daemon-owned "recent extension notices" store: a small bounded per-session
// list of `ctx.ui.notify` notices so a device that connects later can still
// show a "Recent notices" list. Notices are independent of runtime residency:
// they survive idle disposal of the runtime and are dropped on session
// deletion and on daemon stop. Memory only; lost on daemon restart.
//
// The store is synchronous with no timers. Age pruning happens at read time
// (`listFor`), so an idle session's entries disappear lazily without a
// background sweep.
import { randomUUID } from 'node:crypto';

export const MAX_RECENT_NOTICE_MESSAGE_CHARS = 2000;
export const MAX_RECENT_NOTICES_PER_SESSION = 20;
export const MAX_RECENT_NOTICE_SESSIONS = 128;
export const MAX_RECENT_NOTICE_AGE_MS = 24 * 60 * 60 * 1000;

const NOTICE_LEVELS = Object.freeze(['info', 'warning', 'error']);

const validId = (value) => typeof value === 'string' && value.length > 0;

const normalizeLevel = (level) => (
  level === 'warning' || level === 'error' ? level : 'info'
);

// Normalize a candidate notice into the stored entry shape. Returns undefined
// when the notice carries no usable message: empty messages are never
// recorded. Overlong messages are capped at 2000 characters, matching the
// public projection cap.
export const normalizeRecentNotice = (notice, now = Date.now) => {
  if (!notice || typeof notice !== 'object' || Array.isArray(notice)) return undefined;
  if (typeof notice.message !== 'string' || notice.message.length === 0) return undefined;
  const id = typeof notice.id === 'string' && notice.id.length >= 1 && notice.id.length <= 128
    ? notice.id
    : randomUUID();
  const createdAt = Number.isFinite(notice.createdAt) && notice.createdAt > 0
    ? notice.createdAt
    : now();
  return {
    id,
    level: normalizeLevel(notice.level),
    message: notice.message.slice(0, MAX_RECENT_NOTICE_MESSAGE_CHARS),
    createdAt,
  };
};

export const createRecentNoticeStore = ({
  now = Date.now,
  maxPerSession = MAX_RECENT_NOTICES_PER_SESSION,
  maxAgeMs = MAX_RECENT_NOTICE_AGE_MS,
  maxSessions = MAX_RECENT_NOTICE_SESSIONS,
} = {}) => {
  // sessionId -> { notices: Array<entry>, lastRecordAt: number }
  const bySession = new Map();

  const prune = (sessionId, entry) => {
    if (!entry) return;
    const cutoff = now() - maxAgeMs;
    if (!Number.isFinite(cutoff)) return;
    // Drop entries older than maxAgeMs; an emptied session drops out so the
    // index stays bounded by sessions that still hold fresh notices.
    const kept = entry.notices.filter((notice) => notice.createdAt > cutoff);
    if (kept.length !== entry.notices.length) {
      entry.notices = kept;
    }
    if (entry.notices.length === 0) bySession.delete(sessionId);
  };

  const evictSessions = () => {
    if (bySession.size <= maxSessions) return;
    // Evict sessions whose most recent notice is oldest (LRU by last record).
    const ordered = [...bySession.entries()].sort((left, right) => {
      const leftLast = left[1].lastRecordAt ?? 0;
      const rightLast = right[1].lastRecordAt ?? 0;
      return leftLast - rightLast;
    });
    const excess = bySession.size - maxSessions;
    for (let index = 0; index < excess; index += 1) {
      bySession.delete(ordered[index][0]);
    }
  };

  const record = (sessionId, notice) => {
    if (!validId(sessionId)) return undefined;
    const entry = normalizeRecentNotice(notice, now);
    if (!entry) return undefined;
    let session = bySession.get(sessionId);
    if (!session) {
      session = { notices: [], lastRecordAt: 0 };
      bySession.set(sessionId, session);
    }
    session.notices.push(entry);
    // Keep at most maxPerSession per session, dropping the oldest first.
    if (session.notices.length > maxPerSession) {
      session.notices.splice(0, session.notices.length - maxPerSession);
    }
    session.lastRecordAt = now();
    evictSessions();
    return entry;
  };

  const listFor = (sessionId) => {
    if (!validId(sessionId)) return [];
    const session = bySession.get(sessionId);
    if (!session) return [];
    prune(sessionId, session);
    const current = bySession.get(sessionId);
    if (!current) return [];
    return [...current.notices];
  };

  const forgetSession = (sessionId) => {
    if (!validId(sessionId)) return;
    bySession.delete(sessionId);
  };

  const clear = () => {
    bySession.clear();
  };

  return {
    record,
    listFor,
    forgetSession,
    clear,
  };
};
