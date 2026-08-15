import { create } from 'zustand';

export const getGitHubPrStatusKey = (_directory?: string | null, _branch?: string | null): string => {
  void _directory;
  void _branch;
  return '';
};
export const getFreshestPrStatusForBranch = (_directory?: string | null, _branch?: string | null): null => {
  void _directory;
  void _branch;
  return null;
};

export const useGitHubPrStatusStore = create(() => ({
  results: {} as Record<string, unknown>,
  refresh: async () => {},
  load: async () => {},
  resetForRuntimeSwitch: () => {},
}));

export type PrVisualSummary = {
  visualState: 'merged' | 'open' | 'blocked' | 'draft' | 'closed' | string;
  number: number;
  draft?: boolean;
  title?: string;
  canMerge?: boolean;
  mergeableState?: string;
  checks?: { state?: string; total?: number; failure?: number; pending?: number; success?: number };
};

export const usePrVisualSummary = (_key?: string | null): PrVisualSummary | null => {
  void _key;
  return null;
};
