/* eslint-disable */
import { create } from "zustand";
export const useGitHubAuthStore = create(() => ({
  status: { connected: false } as any,
  accounts: [] as unknown[],
  hasChecked: true,
  load: async () => {},
  signIn: async () => {},
  signOut: async () => {},
}));
