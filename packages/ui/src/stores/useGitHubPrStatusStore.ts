/* eslint-disable */
import { create } from "zustand";
export const getGitHubPrStatusKey = () => "";
export const getFreshestPrStatusForBranch = () => null;
export const useGitHubPrStatusStore = create(() => ({
  results: {} as Record<string, unknown>,
  refresh: async () => {},
  load: async () => {},
}));
export type PrVisualSummary = {
  visualState: 'merged' | 'open' | 'blocked' | 'draft' | 'closed' | string;
  number: number;
  canMerge?: boolean;
  mergeableState?: string;
  checks?: { state?: string };
};
export const usePrVisualSummary = (_key?: string | null): PrVisualSummary | null => null;
