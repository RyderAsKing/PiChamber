import { create } from 'zustand';

type GlobalSyncState = {
  ready: boolean;
  error: string | null;
};

export const useGlobalSyncStore = create<GlobalSyncState>()(() => ({
  ready: true,
  error: null,
}));
