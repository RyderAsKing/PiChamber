/* eslint-disable */
import { create } from "zustand";

/**
 * Permission auto-accept is not a Pi runtime concept: Pi follows its normal
 * no-permission-popup default, so no session auto-accepts permissions. This
 * store keeps the composer's permission-toggle wiring intact while behaving as
 * a stable no-op rather than tracking per-session accept state.
 */
export const usePermissionStore = create(() => ({
  requests: [] as unknown[],
  reply: async () => {},
  isSessionAutoAccepting: (_sessionId: string) => false,
  setSessionAutoAccept: async (_sessionId: string, _enabled: boolean) => {},
  reset: () => {},
}));
