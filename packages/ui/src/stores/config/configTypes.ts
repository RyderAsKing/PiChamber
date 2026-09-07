import type { StoreApi, UseBoundStore } from 'zustand';
import type { ModelMetadata } from '@/types';
import type { ProviderModel, ProviderWithModelList } from './selection';

export const PROVIDER_CONFIG_REFRESH_CONCURRENCY = 4;
export const CONNECTION_PROBE_TIMEOUT_MS = 800;
export const CONFIG_REFRESH_TTL_MS = 30_000;
export const PROJECT_CONFIG_PREWARM_DELAY_MS = 1_000;

export interface DirectoryScopedConfig {
  providers: ProviderWithModelList[];
  currentProviderId: string;
  currentModelId: string;
  currentVariant?: string | undefined;
  selectedProviderId: string;
  defaultProviders: { [key: string]: string };
  selectionSource?: 'auto' | 'manual';
}

export interface ConfigStore {
  activeDirectoryKey: string;
  directoryScoped: Record<string, DirectoryScopedConfig>;

  providers: ProviderWithModelList[];
  currentProviderId: string;
  currentModelId: string;
  currentVariant: string | undefined;
  selectedProviderId: string;
  defaultProviders: { [key: string]: string };
  selectionSource: 'auto' | 'manual';
  isConnected: boolean;
  hasEverConnected: boolean;
  connectionPhase: 'connecting' | 'connected' | 'reconnecting';
  lastDisconnectReason: string | null;
  isInitialized: boolean;
  modelsMetadata: Map<string, ModelMetadata>;
  // PiChamber settings-based defaults (fallback when no explicit provider/model selection)
  settingsDefaultModel: string | undefined; // format: "provider/model"
  settingsDefaultVariant: string | undefined;
  settingsDefaultThinking: string | undefined;
  settingsDefaultThinkingByModel: Record<string, string>;
  settingsAutoCreateWorktree: boolean;
  settingsZenModel: string | undefined;

  activateDirectory: (directory: string | null | undefined) => Promise<void>;

  loadProviders: (options?: {
    directory?: string | null;
    source?: string;
  }) => Promise<void>;
  invalidateModelMetadataCache: () => void;
  invalidateProviderCache: (directory?: string | null) => void;
  setProvider: (providerId: string) => void;
  setModel: (modelId: string) => void;
  setCurrentVariant: (variant: string | undefined) => void;
  cycleCurrentVariant: () => void;
  getCurrentModelVariants: () => string[];
  setSelectedProvider: (providerId: string) => void;
  setSettingsDefaultModel: (model: string | undefined) => void;
  setSettingsDefaultVariant: (variant: string | undefined) => void;
  setSettingsDefaultThinking: (thinking: string | undefined) => void;
  setSettingsDefaultThinkingByModel: (map: Record<string, string>) => void;
  setSettingsAutoCreateWorktree: (enabled: boolean) => void;
  setSettingsZenModel: (model: string | undefined) => void;
  getResolvedGitGenerationModel: () => {
    providerId: string;
    modelId: string;
  } | null;
  probeConnection: (options?: { timeoutMs?: number }) => Promise<boolean>;
  checkConnection: () => Promise<boolean>;
  initializeApp: () => Promise<void>;
  prewarmProjectConfigs: (initialDirectory?: string | null) => Promise<void>;
  getCurrentProvider: () => ProviderWithModelList | undefined;
  getCurrentModel: () => ProviderModel | undefined;
  getModelMetadata: (
    providerId: string,
    modelId: string
  ) => ModelMetadata | undefined;
}

declare global {
  interface Window {
    __zustand_config_store__?: UseBoundStore<StoreApi<ConfigStore>>;
  }
}

/**
 * Lift the active directory's cached provider snapshot into the top-level
 * fields the pickers read (`providers`, selections), so a cold start
 * paints instantly from persisted data. Falls back to whatever top-level data
 * was persisted; handles legacy persisted blobs that only stored directoryScoped.
 * Legacy generic-agent fields (`agents`, `currentAgentName`,
 * `agentModelSelections`, `runtimeDefaultAgent`, `runtimeDefaultModel`) that
 * older builds persisted are stripped from both the root state and every
 * directory snapshot and never restored: the config-level agent registry is
 * retired (the daemon exposes no agent list endpoint), so those values are
 * discarded even when older blobs hold non-empty data. The retired Gitmoji
 * preference (`settingsGitmojiEnabled`) is stripped the same way. Per-session
 * agent/model/variant maps in `selection-store`/`contextStore` are retained
 * untouched.
 */
export const hydrateActiveDirectorySnapshot = <T extends Partial<ConfigStore>>(
  merged: T
): T => {
  // Strip obsolete generic-agent fields from the root state and every persisted
  // snapshot so they can never repopulate live state or be written back out.
  // Older builds stored `agents`, `currentAgentName`, `agentModelSelections`,
  // `runtimeDefaultAgent`, and `runtimeDefaultModel`; the config-level agent
  // registry is retired, so those values are discarded even when older blobs
  // hold non-empty data. Work on copies so caller-owned objects are not mutated.
  const sanitized = { ...merged } as unknown as Record<string, unknown>;
  delete sanitized.agents;
  delete sanitized.currentAgentName;
  delete sanitized.agentModelSelections;
  delete sanitized.runtimeDefaultAgent;
  delete sanitized.runtimeDefaultModel;
  delete sanitized.settingsDefaultFileViewerPreview;
  delete sanitized.defaultFileViewerPreview;
  delete sanitized.settingsGitmojiEnabled;
  delete sanitized.gitmojiEnabled;
  const directoryScoped = merged.directoryScoped;
  if (directoryScoped && typeof directoryScoped === 'object') {
    const cleaned: Record<string, DirectoryScopedConfig> = {};
    for (const [key, snapshot] of Object.entries(directoryScoped)) {
      if (!snapshot || typeof snapshot !== 'object') {
        cleaned[key] = snapshot as DirectoryScopedConfig;
        continue;
      }
      const copy = { ...(snapshot as unknown as Record<string, unknown>) };
      delete copy.agents;
      delete copy.currentAgentName;
      delete copy.agentModelSelections;
      delete copy.runtimeDefaultAgent;
      delete copy.runtimeDefaultModel;
      delete copy.settingsDefaultFileViewerPreview;
      delete copy.defaultFileViewerPreview;
      cleaned[key] = copy as unknown as DirectoryScopedConfig;
    }
    sanitized.directoryScoped = cleaned;
  }
  const cleanedScoped = sanitized.directoryScoped as
    | Record<string, DirectoryScopedConfig>
    | undefined;
  const activeKey = sanitized.activeDirectoryKey as string | undefined;
  if (!cleanedScoped || !activeKey) return sanitized as unknown as T;
  const snapshot = cleanedScoped[activeKey];
  if (!snapshot) return sanitized as unknown as T;

  const next = { ...sanitized } as unknown as Partial<ConfigStore>;
  if (
    (!next.providers || next.providers.length === 0) &&
    snapshot.providers?.length
  ) {
    next.providers = snapshot.providers;
  }
  if (
    !next.defaultProviders ||
    Object.keys(next.defaultProviders).length === 0
  ) {
    if (
      snapshot.defaultProviders &&
      Object.keys(snapshot.defaultProviders).length > 0
    ) {
      next.defaultProviders = snapshot.defaultProviders;
    }
  }
  if (snapshot.selectionSource) {
    next.selectionSource = snapshot.selectionSource;
  }
  return next as unknown as T;
};

export const _providersLoadedAt = new Map<string, number>();

export const isConfigFresh = (
  loadedAt: Map<string, number>,
  key: string
): boolean => {
  const at = loadedAt.get(key);
  return typeof at === 'number' && Date.now() - at < CONFIG_REFRESH_TTL_MS;
};
