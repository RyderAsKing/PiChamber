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
      add: (_input?: unknown) => { void _input; return undefined; },
      remove: (_input?: unknown) => { void _input; return undefined; },
      confirm: (_input?: unknown) => { void _input; return undefined; },
    },
  };
}
