import { create } from "zustand";
export const usePermissionStore = create(() => ({
  requests: [] as unknown[],
  reply: async () => {},
}));
