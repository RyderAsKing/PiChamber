import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { scopeMatches, subscribeToConfigChanges } from '@/lib/configSync';
import { subscribeToSyncConfigChanges } from '@/sync/sync-refs';
import { markStartupTrace } from '@/lib/startupTrace';
import { fromDirectoryKey, toDirectoryKey } from './directoryScope';
import { PROVIDER_CONFIG_REFRESH_CONCURRENCY, type ConfigStore } from './configTypes';
import type { UseBoundStore, StoreApi } from 'zustand';

export const refreshKnownProviderDirectories = async (
  store: UseBoundStore<StoreApi<ConfigStore>>,
  source: string
): Promise<void> => {
  const state = store.getState();
  const directoryKeys = Array.from(
    new Set([state.activeDirectoryKey, ...Object.keys(state.directoryScoped)])
  ).filter((key) => key.length > 0);

  state.invalidateProviderCache();

  let nextIndex = 0;
  const workerCount = Math.min(
    PROVIDER_CONFIG_REFRESH_CONCURRENCY,
    directoryKeys.length
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < directoryKeys.length) {
      const directoryKey = directoryKeys[nextIndex];
      nextIndex += 1;
      await store.getState().loadProviders({
        directory: fromDirectoryKey(directoryKey),
        source,
      });
    }
  });

  await Promise.all(workers);
};

let unsubscribeConfigStoreChanges: (() => void) | null = null;
let unsubscribeConfigStoreDirectoryChanges: (() => void) | null = null;
let unsubscribeConfigStoreSyncConfigChanges: (() => void) | null = null;

export const setupConfigStoreSubscribers = (
  store: UseBoundStore<StoreApi<ConfigStore>>
): void => {
  if (typeof window !== 'undefined') {
    window.__zustand_config_store__ = store;
  }

  if (!unsubscribeConfigStoreChanges) {
    unsubscribeConfigStoreChanges = subscribeToConfigChanges(async (event) => {
      const tasks: Promise<void>[] = [];

      if (scopeMatches(event, 'agents')) {
        const { loadAgents } = store.getState();
        tasks.push(loadAgents({ source: 'configChange:agents' }).then(() => {}));
      }

      if (scopeMatches(event, 'providers')) {
        tasks.push(refreshKnownProviderDirectories(store, 'configChange:providers'));
      }

      if (tasks.length > 0) {
        await Promise.all(tasks);
      }
    });
  }

  if (!unsubscribeConfigStoreSyncConfigChanges) {
    unsubscribeConfigStoreSyncConfigChanges = subscribeToSyncConfigChanges(
      (directory, config) => {
        store
          .getState()
          .applyRuntimeConfigDefaults(directory, 'syncConfig', config);
      }
    );
  }

  if (typeof window !== 'undefined' && !unsubscribeConfigStoreDirectoryChanges) {
    unsubscribeConfigStoreDirectoryChanges = useDirectoryStore.subscribe(
      (state, prevState) => {
        const nextKey = toDirectoryKey(state.currentDirectory);
        const prevKey = toDirectoryKey(prevState.currentDirectory);
        if (nextKey === prevKey) {
          return;
        }

        markStartupTrace('directoryStore:changed', {
          previous: prevKey,
          next: nextKey,
        });
        void store.getState().activateDirectory(state.currentDirectory);
      }
    );
  }
};
