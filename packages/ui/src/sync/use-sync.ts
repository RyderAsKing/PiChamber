import { getPiSessionStore } from '@/apps/pi-session-store';

export function useSync() {
  const store = getPiSessionStore();
  return {
    ensureSessionRenderable: async (sessionId: string) => {
      await store.select(sessionId);
    },
    loadMore: async () => undefined,
    syncSession: async (sessionId: string) => {
      await store.select(sessionId);
    },
    recoverPendingQuestions: async () => undefined,
    optimistic: {
      add: () => undefined,
      remove: () => undefined,
      confirm: () => undefined,
    },
  };
}
