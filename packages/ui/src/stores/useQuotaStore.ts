/* eslint-disable */
import { create } from "zustand";

export const useQuotaStore = create(() => ({
  results: [] as Array<{ providerId: string }>,
  lastUpdated: 0,
  displayMode: "usage" as "usage" | "remaining",
  isLoading: false,
  showPredValues: false,
  dropdownProviderIds: [] as string[],
  selectedModels: [] as unknown[],
  expandedFamilies: new Set<string>(),
  load: async () => {},
  refresh: async () => {},
  loadSettings: async () => {},
  fetchAllQuotas: async () => {},
  setDisplayMode: (_mode: "usage" | "remaining") => {},
  toggleFamilyExpanded: (_family: string) => {},
}));

export const useQuotaAutoRefresh = () => {};
