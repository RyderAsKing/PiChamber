import { useMemo } from 'react';
import { getPiSessionStore } from '@/apps/pi-session-store';

const optimisticNoop = {
  add: (_input?: unknown) => { void _input; return undefined; },
  remove: (_input?: unknown) => { void _input; return undefined; },
  confirm: (_input?: unknown) => { void _input; return undefined; },
};

export function useSync() {
  const store = getPiSessionStore();
  return useMemo(() => ({
    ensureSessionRenderable: async (sessionId: string) => {
      if (!sessionId) return;
      const state = store.getState();
      if (state.selectedSessionId !== sessionId) {
        await store.select(sessionId);
      }
    },
    loadMore: async () => undefined,
    syncSession: async (sessionId: string) => {
      if (!sessionId) return;
      const state = store.getState();
      if (state.selectedSessionId !== sessionId) {
        await store.select(sessionId);
      }
    },
    recoverPendingQuestions: async () => undefined,
    optimistic: optimisticNoop,
  }), [store]);
}

