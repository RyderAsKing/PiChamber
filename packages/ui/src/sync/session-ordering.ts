import { create } from 'zustand';
import type { Session } from '@/lib/chat/types';
import { isSessionPinned } from '@/stores/useSessionPinnedStore';
import { normalizePath } from '@/lib/pathNormalization';

type SessionActivityPhase = 'active' | 'settled';

type SessionOrderingState = {
  rankById: Map<string, number>;
};

export const EMPTY_SESSION_ORDER_RANKS: ReadonlyMap<string, number> = new Map();

const phaseById = new Map<string, SessionActivityPhase>();
const baselineRankById = new Map<string, { created?: number; updated?: number }>();
let lastRank = 0;

export const useSessionOrderingStore = create<SessionOrderingState>(() => ({
  rankById: new Map(),
}));

const nextRank = (): number => {
  lastRank = Math.max(lastRank + 1, Date.now());
  return lastRank;
};

const promoteSessions = (sessionIds: Iterable<string>, useSharedRank = false): void => {
  const ids = [...sessionIds];
  if (ids.length === 0) return;

  useSessionOrderingStore.setState((state) => {
    const rankById = new Map(state.rankById);
    const sharedRank = useSharedRank ? nextRank() : null;
    for (const sessionId of ids) {
      rankById.set(sessionId, sharedRank ?? nextRank());
    }
    return { rankById };
  });
};

export const observeSessionActivityEvent = (
  sessionId: string,
  phase: SessionActivityPhase,
): void => {
  const previous = phaseById.get(sessionId);
  phaseById.set(sessionId, phase);

  // Sidebar order is last prompt, not last turn stage. Settling, hydrate
  // replay, and repeated busy ticks must not move a row. Only a new
  // `active` observation (the send path) promotes.
  if (phase !== 'active') return;
  if (previous === 'active') return;
  promoteSessions([sessionId]);
};

export const reconcileSessionActivitySnapshot = (
  activeSessionIds: Iterable<string>,
  knownSessionIds: Iterable<string>,
): void => {
  const active = new Set(activeSessionIds);
  const observed = new Set([...knownSessionIds, ...active]);

  for (const sessionId of observed) {
    const phase: SessionActivityPhase = active.has(sessionId) ? 'active' : 'settled';
    phaseById.set(sessionId, phase);
  }
};

export const removeSessionOrdering = (sessionId: string): void => {
  phaseById.delete(sessionId);
  baselineRankById.delete(sessionId);
  useSessionOrderingStore.setState((state) => {
    if (!state.rankById.has(sessionId)) return state;
    const rankById = new Map(state.rankById);
    rankById.delete(sessionId);
    return { rankById };
  });
};

export const resetSessionOrdering = (): void => {
  phaseById.clear();
  baselineRankById.clear();
  lastRank = 0;
  useSessionOrderingStore.setState({ rankById: new Map() });
};

const finiteTime = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

const updatedAt = (session: Session): number => (
  finiteTime(session.time?.updated) || finiteTime(session.time?.created)
);

const createdAt = (session: Session): number => finiteTime(session.time?.created);

const parentIdOf = (session: Session): string | null => (
  (session as Session & { parentID?: string | null }).parentID ?? null
);

const sessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(record.directory ?? null) ?? normalizePath(record.project?.worktree ?? null);
};

const baselineRank = (session: Session, pinned: boolean): number => {
  const existing = baselineRankById.get(session.id);
  const key = pinned ? 'created' : 'updated';
  const existingRank = existing?.[key];
  if (existingRank !== undefined) return existingRank;
  const rank = pinned ? createdAt(session) : updatedAt(session);
  baselineRankById.set(session.id, { ...existing, [key]: rank });
  return rank;
};

/**
 * Raise cached baselines to the sessions' current authoritative timestamps.
 *
 * The frozen baseline keeps live metadata churn from reordering an open list,
 * but a client that slept through a session's whole active→settled cycle never
 * saw the transition that would have promoted its live rank — so its stale
 * baseline pins it in place forever. Call this when an authoritative session
 * SNAPSHOT arrives (global refresh); monotonic, so it can never demote.
 */
export const raiseSessionOrderingBaselines = (sessions: Iterable<Session>): void => {
  const currentRanks = useSessionOrderingStore.getState().rankById;
  let baselinesChanged = false;

  for (const session of sessions) {
    const fresh = updatedAt(session);
    if (currentRanks.get(session.id) !== undefined) {
      // Live ranks are last-prompt order. List stamps must not outrank them.
      continue;
    }
    const existing = baselineRankById.get(session.id);
    if (existing?.updated !== undefined && existing.updated >= fresh) continue;
    baselineRankById.set(session.id, { ...existing, updated: fresh });
    baselinesChanged = true;
  }

  if (baselinesChanged) {
    useSessionOrderingStore.setState((state) => ({ rankById: new Map(state.rankById) }));
  }
};

export const getSessionLifecycleOrderValue = (
  session: Session,
  rankById: ReadonlyMap<string, number>,
  pinned = false,
): number => rankById.get(session.id) ?? baselineRank(session, pinned);

export const compareSessionsByLifecycleOrder = (
  left: Session,
  right: Session,
  pinnedSessionIds: Set<string>,
  rankById: ReadonlyMap<string, number>,
): number => {
  const leftPinned = isSessionPinned(pinnedSessionIds, sessionDirectory(left), left.id);
  const rightPinned = isSessionPinned(pinnedSessionIds, sessionDirectory(right), right.id);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;

  const leftFallback = baselineRank(left, leftPinned);
  const rightFallback = baselineRank(right, rightPinned);
  if (parentIdOf(left) === parentIdOf(right)) {
    const rankDelta = getSessionLifecycleOrderValue(right, rankById, rightPinned)
      - getSessionLifecycleOrderValue(left, rankById, leftPinned);
    if (rankDelta !== 0) return rankDelta;
  }

  const baselineDelta = rightFallback - leftFallback;
  if (baselineDelta !== 0) return baselineDelta;
  const createdDelta = baselineRank(right, true) - baselineRank(left, true);
  if (createdDelta !== 0) return createdDelta;
  return left.id.localeCompare(right.id);
};

export const orderSessionsByLifecycleScopes = (
  sessions: Session[],
  pinnedSessionIds: Set<string>,
  rankById: ReadonlyMap<string, number>,
): Session[] => {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const roots: Session[] = [];
  const childrenByParent = new Map<string, Session[]>();

  for (const session of sessions) {
    const parentId = parentIdOf(session);
    if (!parentId || !sessionIds.has(parentId)) {
      roots.push(session);
      continue;
    }

    const siblings = childrenByParent.get(parentId);
    if (siblings) {
      siblings.push(session);
    } else {
      childrenByParent.set(parentId, [session]);
    }
  }

  const compare = (left: Session, right: Session) => (
    compareSessionsByLifecycleOrder(left, right, pinnedSessionIds, rankById)
  );
  roots.sort(compare);
  for (const siblings of childrenByParent.values()) {
    siblings.sort(compare);
  }

  const ordered: Session[] = [];
  const visited = new Set<string>();
  const append = (session: Session): void => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    ordered.push(session);
    for (const child of childrenByParent.get(session.id) ?? []) {
      append(child);
    }
  };
  for (const root of roots) {
    append(root);
  }
  for (const session of sessions) {
    append(session);
  }
  return ordered;
};
