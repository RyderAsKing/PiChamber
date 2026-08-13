import { create } from "zustand";
export const usePluginsStore = create(() => ({
  plugins: [] as unknown[],
  loadPlugins: async () => {},
}));
