import type { PiReducerSessionState } from '@/lib/pi/event-reducer';
import type { PiSessionId } from '@/lib/pi/types';

/** Busy/retry is the live signal the sidebar and status hooks share. Streaming
 *  parts without a busy lifecycle are leftovers, not an active turn. */
export const isPiSessionLive = (session: PiReducerSessionState | undefined): boolean => {
  if (!session) return false;
  return session.lifecycle === 'busy' || session.lifecycle === 'retry';
};

const piLiveSessionKind = (session: PiReducerSessionState): 'busy' | 'retry' => (
  session.lifecycle === 'retry' ? 'retry' : 'busy'
);

/** Sorted `id:kind` signature; Object.is-stable unless the live set changes. */
export const piLiveStatusSignature = (bySession: ReadonlyMap<PiSessionId, PiReducerSessionState>): string => {
  const parts: string[] = [];
  for (const [sessionId, session] of bySession) {
    if (isPiSessionLive(session)) parts.push(`${sessionId}:${piLiveSessionKind(session)}`);
  }
  parts.sort();
  return parts.join('|');
};

export const piLiveSessionIdsKey = (
  bySession: ReadonlyMap<PiSessionId, PiReducerSessionState>,
): string => {
  const ids: string[] = [];
  for (const [sessionId, session] of bySession) {
    if (isPiSessionLive(session)) ids.push(sessionId);
  }
  ids.sort();
  return ids.join('|');
};
