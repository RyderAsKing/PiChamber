import React from 'react';
import type { Session } from '@/lib/chat/types';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  buildAuthoritativeSessionIdentityMap,
  findRemovedAuthoritativeSessions,
} from '../authoritativeSessionCleanup';

export const useAuthoritativeSessionCleanup = (args: {
  enabled?: boolean;
  hasAuthoritativeGlobalSessions: boolean;
  sessions: Session[];
}): void => {
  const { enabled = true, hasAuthoritativeGlobalSessions, sessions } = args;
  const baselineRef = React.useRef<{
    runtimeKey: string;
    identities: ReturnType<typeof buildAuthoritativeSessionIdentityMap>;
  } | null>(null);

  React.useEffect(() => {
    if (!enabled || !hasAuthoritativeGlobalSessions) return;

    const runtimeKey = getRuntimeKey();
    const current = buildAuthoritativeSessionIdentityMap(sessions);
    const previous = baselineRef.current?.runtimeKey === runtimeKey
      ? baselineRef.current.identities
      : null;

    for (const identity of findRemovedAuthoritativeSessions(previous, current)) {
      // Funnel through the store's shared deletion commit so the missed
      // deletion also lands a runtime-scoped tombstone: an in-flight list,
      // detail, or history response started before the daemon-side deletion
      // cannot resurrect the row. Persisted state cleanup (runtime +
      // directory + session scoped) happens inside the same commit.
      getPiSessionStore().commitMissedDeletion(identity.sessionId, identity.directory);
    }
    baselineRef.current = { runtimeKey, identities: current };
  }, [enabled, hasAuthoritativeGlobalSessions, sessions]);
};
