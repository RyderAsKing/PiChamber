import { create } from "zustand";
export const useGitHubAuthStore = create(() => ({
  status: "signed-out" as const,
  accounts: [] as unknown[],
  load: async () => {},
  signIn: async () => {},
  signOut: async () => {},
}));
