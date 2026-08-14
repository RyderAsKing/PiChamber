/* eslint-disable */
import { create } from "zustand";

export const useQuotaStore = create(() => ({
  results: [] as Array<any>,
  lastUpdated: 0,
  displayMode: "usage" as "usage" | "remaining",
  isLoading: false,
  showPredValues: false,
  dropdownProviderIds: [] as string[],
  selectedModels: {} as Record<string, string[]>,
  expandedFamilies: new Set<string>(),
  load: async () => {},
  refresh: async () => {},
  loadSettings: async () => {},
  fetchAllQuotas: async () => {},
  setDisplayMode: (_mode: "usage" | "remaining") => {},
  toggleFamilyExpanded: (_providerOrFamily?: string, _family?: string) => {},
}));

export const useQuotaAutoRefresh = () => {};
