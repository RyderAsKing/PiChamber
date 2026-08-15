import { create } from "zustand";

export interface GitHubAuthStatus {
  connected: boolean;
  user?: string;
  [key: string]: unknown;
}

export interface GitHubAuthState {
  status: GitHubAuthStatus;
  accounts: unknown[];
  hasChecked: boolean;
  load: () => Promise<void>;
  refreshStatus: (_apis?: unknown, _opts?: unknown) => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const useGitHubAuthStore = create<GitHubAuthState>()(() => ({
  status: { connected: false },
  accounts: [],
  hasChecked: true,
  load: async () => {},
  refreshStatus: async () => {},
  signIn: async () => {},
  signOut: async () => {},
}));
