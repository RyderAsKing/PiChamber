import { create } from "zustand";
export const getGitHubPrStatusKey = () => "";
export const getFreshestPrStatusForBranch = () => null;
export const useGitHubPrStatusStore = create(() => ({
  results: {} as Record<string, unknown>,
  refresh: async () => {},
  load: async () => {},
}));
export type PrVisualSummary = { state?: string };
export const usePrVisualSummary = () => null;
export const usePrVisualSummaryByKeys = () => new Map();
