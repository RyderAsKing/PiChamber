import type { StoreApi, UseBoundStore } from 'zustand';
import type { Agent, Config } from '@/lib/chat/types';
import type { ModelMetadata } from '@/types';
import type { ProviderModel, ProviderWithModelList } from './selection';

export const PROVIDER_CONFIG_REFRESH_CONCURRENCY = 4;
export const CONNECTION_PROBE_TIMEOUT_MS = 800;
export const CONFIG_REFRESH_TTL_MS = 30_000;
export const PROJECT_CONFIG_PREWARM_DELAY_MS = 1_000;

export interface DirectoryScopedConfig {
  providers: ProviderWithModelList[];
  agents: Agent[];
  currentProviderId: string;
  currentModelId: string;
  currentVariant?: string | undefined;
  currentAgentName: string | undefined;
  selectedProviderId: string;
  agentModelSelections: {
    [agentName: string]: { providerId: string; modelId: string };
  };
  defaultProviders: { [key: string]: string };
  runtimeDefaultAgent?: string;
  runtimeDefaultModel?: string;
  selectionSource?: 'auto' | 'manual';
}

export interface ConfigStore {
  activeDirectoryKey: string;
  directoryScoped: Record<string, DirectoryScopedConfig>;

  providers: ProviderWithModelList[];
  agents: Agent[];
  currentProviderId: string;
  currentModelId: string;
  currentVariant: string | undefined;
  currentAgentName: string | undefined;
  selectedProviderId: string;
  agentModelSelections: {
    [agentName: string]: { providerId: string; modelId: string };
  };
  defaultProviders: { [key: string]: string };
  selectionSource: 'auto' | 'manual';
  isConnected: boolean;
  hasEverConnected: boolean;
  connectionPhase: 'connecting' | 'connected' | 'reconnecting';
  lastDisconnectReason: string | null;
  isInitialized: boolean;
  modelsMetadata: Map<string, ModelMetadata>;
  // PiChamber settings-based defaults (take precedence over agent preferences)
  settingsDefaultModel: string | undefined; // format: "provider/model"
  settingsDefaultVariant: string | undefined;
  settingsDefaultThinking: string | undefined;
  settingsDefaultThinkingByModel: Record<string, string>;
  // Pi server's own `default_agent` config field (name of a primary agent), used as a
  // fallback when our own settingsDefaultAgent is unset. Sourced from sync config.
  runtimeDefaultAgent: string | undefined;
  // Pi server's own global `model` config field ("provider/model"), used as a fallback
  // when neither our settingsDefaultModel nor the resolved agent pins a model.
  runtimeDefaultModel: string | undefined;
  settingsAutoCreateWorktree: boolean;
  settingsGitmojiEnabled: boolean;
  settingsDefaultFileViewerPreview: boolean;
  settingsZenModel: string | undefined;

  activateDirectory: (directory: string | null | undefined) => Promise<void>;

  loadProviders: (options?: {
    directory?: string | null;
    source?: string;
  }) => Promise<void>;
  loadAgents: (options?: {
    directory?: string | null;
    source?: string;
  }) => Promise<boolean>;
  invalidateModelMetadataCache: () => void;
  invalidateProviderCache: (directory?: string | null) => void;
  setProvider: (providerId: string) => void;
  setModel: (modelId: string) => void;
  setCurrentVariant: (variant: string | undefined) => void;
  cycleCurrentVariant: () => void;
  getCurrentModelVariants: () => string[];
  setAgent: (agentName: string | undefined) => void;
  applyDefaultModelAgentSelection: (options?: {
    projectDefaultModel?: string;
  }) => void;
  applyRuntimeConfigDefaults: (
    directory?: string | null,
    source?: string,
    config?: Config
  ) => void;
  setSelectedProvider: (providerId: string) => void;
  setSettingsDefaultModel: (model: string | undefined) => void;
  setSettingsDefaultVariant: (variant: string | undefined) => void;
  setSettingsDefaultThinking: (thinking: string | undefined) => void;
  setSettingsDefaultThinkingByModel: (map: Record<string, string>) => void;
  setSettingsAutoCreateWorktree: (enabled: boolean) => void;
  setSettingsGitmojiEnabled: (enabled: boolean) => void;
  setSettingsDefaultFileViewerPreview: (enabled: boolean) => void;
  setSettingsZenModel: (model: string | undefined) => void;
  getResolvedGitGenerationModel: () => {
    providerId: string;
    modelId: string;
  } | null;
  saveAgentModelSelection: (
    agentName: string,
    providerId: string,
    modelId: string
  ) => void;
  getAgentModelSelection: (
    agentName: string
  ) => { providerId: string; modelId: string } | null;
  probeConnection: (options?: { timeoutMs?: number }) => Promise<boolean>;
  checkConnection: () => Promise<boolean>;
  initializeApp: () => Promise<void>;
  prewarmProjectConfigs: (initialDirectory?: string | null) => Promise<void>;
  getCurrentProvider: () => ProviderWithModelList | undefined;
  getCurrentModel: () => ProviderModel | undefined;
  getCurrentAgent: () => Agent | undefined;
  getModelMetadata: (
    providerId: string,
    modelId: string
  ) => ModelMetadata | undefined;
  getVisibleAgents: () => Agent[];
}

declare global {
  interface Window {
    __zustand_config_store__?: UseBoundStore<StoreApi<ConfigStore>>;
  }
}

export const createEmptyDirectoryScopedConfig = (
  providers: ProviderWithModelList[] = [],
  agents: Agent[] = []
): DirectoryScopedConfig => ({
  providers,
  agents,
  currentProviderId: '',
  currentModelId: '',
  currentVariant: undefined,
  currentAgentName: undefined,
  selectedProviderId: '',
  agentModelSelections: {},
  defaultProviders: {},
  runtimeDefaultAgent: undefined,
  runtimeDefaultModel: undefined,
  selectionSource: 'auto',
});

/**
 * Lift the active directory's cached provider/agent snapshot into the top-level
 * fields the pickers read (`providers`, `agents`, selections), so a cold start
 * paints instantly from persisted data. Falls back to whatever top-level data
 * was persisted; handles legacy persisted blobs that only stored directoryScoped.
 */
export const hydrateActiveDirectorySnapshot = <T extends Partial<ConfigStore>>(
  merged: T
): T => {
  const directoryScoped = merged.directoryScoped;
  const activeKey = merged.activeDirectoryKey;
  if (!directoryScoped || !activeKey) return merged;
  const snapshot = directoryScoped[activeKey];
  if (!snapshot) return merged;

  const next: Partial<ConfigStore> = { ...merged };
  if (
    (!merged.providers || merged.providers.length === 0) &&
    snapshot.providers?.length
  ) {
    next.providers = snapshot.providers;
  }
  if ((!merged.agents || merged.agents.length === 0) && snapshot.agents?.length) {
    next.agents = snapshot.agents;
  }
  if (
    !merged.defaultProviders ||
    Object.keys(merged.defaultProviders).length === 0
  ) {
    if (
      snapshot.defaultProviders &&
      Object.keys(snapshot.defaultProviders).length > 0
    ) {
      next.defaultProviders = snapshot.defaultProviders;
    }
  }
  if (snapshot.runtimeDefaultAgent !== undefined) {
    next.runtimeDefaultAgent = snapshot.runtimeDefaultAgent;
  }
  if (snapshot.runtimeDefaultModel !== undefined) {
    next.runtimeDefaultModel = snapshot.runtimeDefaultModel;
  }
  if (snapshot.selectionSource) {
    next.selectionSource = snapshot.selectionSource;
  }
  return next as T;
};

export const _providersLoadedAt = new Map<string, number>();
export const _agentsLoadedAt = new Map<string, number>();

export const isConfigFresh = (
  loadedAt: Map<string, number>,
  key: string
): boolean => {
  const at = loadedAt.get(key);
  return typeof at === 'number' && Date.now() - at < CONFIG_REFRESH_TTL_MS;
};
