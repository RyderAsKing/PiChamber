import { usePluginsStore } from '@/plugins/store';

/** Visuals' "Let pages load from the network" value for a folder; off until known. */
export const useAllowNetwork = (directory: string | null): boolean => usePluginsStore((state) => {
  const plugins = state.entries[directory?.trim() ?? '']?.plugins ?? state.entries['']?.plugins;
  return plugins?.find((plugin) => plugin.id === 'visuals')?.state.allowNetwork === true;
});
