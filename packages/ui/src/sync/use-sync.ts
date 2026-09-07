import { useMemo } from 'react';
import { getPiSessionStore } from '@/apps/pi-session-store';

export function useSync() {
  const store = getPiSessionStore();
  return useMemo(() => ({
    ensureSessionRenderable: async (sessionId: string) => {
      if (!sessionId) return;
      const state = store.getState();
      if (state.selectedSessionId !== sessionId) {
        await store.select(sessionId);
        return;
      }
      await store.ensureHydrated(sessionId);
    },
    syncSession: async (sessionId: string) => {
      if (!sessionId) return;
      const state = store.getState();
      if (state.selectedSessionId !== sessionId) {
        await store.select(sessionId);
      }
    },
  }), [store]);
}
