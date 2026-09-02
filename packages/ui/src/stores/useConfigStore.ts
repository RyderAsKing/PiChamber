import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { Agent, Config } from "@/lib/chat/types";
import type { ModelMetadata } from "@/types";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { useSelectionStore } from "@/sync/selection-store";
import { updateDesktopSettings } from "@/lib/persistence";
import { useDirectoryStore } from "@/stores/useDirectoryStore";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { resolveProjectForSessionDirectory } from "@/lib/projectResolution";
import { streamDebugEnabled } from "@/stores/utils/streamDebug";
import { configurableThinkingLevels, cycleThinkingLevel } from "@/lib/pi/thinking";
import { ensureModelMetadataLoaded, invalidateModelMetadataLoad, resolveModelMetadata } from "./config/modelMetadata";
import { fetchPiChamberDefaults } from "./config/defaults";
import {
    fromDirectoryKey,
    getFallbackProjectDirectory,
    resolveConfigDirectory,
    resolveInitialDirectoryKey,
    toConfigDirectoryKey,
    toDirectoryKey,
} from "./config/directoryScope";
import {
    ADD_PROVIDER_SENTINEL,
    asConfigAgent,
    hasProviderModel,
    normalizeOptionalString,
    parseModelString,
    preserveAddProviderSelection,
    resolveDefaultAgentModelSelection,
    resolveGitGenerationModelSelection,
    resolveProviderModelSelection,
    resolveSelectionWithManualGuard,
    resolveThinkingVariant,
    sanitizePersistedSelectedProviderId,
    type ProviderModel,
    type ProviderWithModelList,
} from "./config/selection";
import {
    type ConfigStore,
    type DirectoryScopedConfig,
    createEmptyDirectoryScopedConfig,
    hydrateActiveDirectorySnapshot,
    _providersLoadedAt,
    _agentsLoadedAt,
    isConfigFresh,
    PROJECT_CONFIG_PREWARM_DELAY_MS,
} from "./config/configTypes";
import { checkPiHealth, probePiHealth } from "./config/configConnection";
import { setupConfigStoreSubscribers } from "./config/configSubscribers";
import { fetchAndProcessProviders } from "./config/configLoaders";
import { markStartupTrace, measureStartupTrace } from "@/lib/startupTrace";
import { getSyncConfig } from "@/sync/sync-refs";

export type { ConfigStore, DirectoryScopedConfig };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// In-flight dedup: prevent concurrent duplicate loadProviders/loadAgents calls for the same directory
const _inFlightProviders = new Map<string, Promise<void>>();
const _inFlightAgents = new Map<string, Promise<boolean>>();
let _initializeAppInFlight: Promise<void> | null = null;

export const useConfigStore = create<ConfigStore>()(
    devtools(
        persist(
            (set, get) => ({

                activeDirectoryKey: resolveInitialDirectoryKey(),
                directoryScoped: {},

                providers: [],
                agents: [],
                currentProviderId: "",
                currentModelId: "",
                currentVariant: undefined,
                currentAgentName: undefined,
                selectedProviderId: "",
                agentModelSelections: {},
                defaultProviders: {},
                selectionSource: "auto",
                isConnected: false,
                hasEverConnected: false,
                connectionPhase: "connecting",
                lastDisconnectReason: null,
                isInitialized: false,
                modelsMetadata: new Map<string, ModelMetadata>(),
                settingsDefaultModel: undefined,
                settingsDefaultVariant: undefined,
                settingsDefaultThinking: undefined,
                settingsDefaultThinkingByModel: {},
                runtimeDefaultAgent: undefined,
                runtimeDefaultModel: undefined,
                settingsAutoCreateWorktree: false,
                settingsGitmojiEnabled: false,
                settingsDefaultFileViewerPreview: false,
                settingsZenModel: undefined,

                activateDirectory: async (directory) => {
                    const configDirectory = resolveConfigDirectory(directory);
                    if (!configDirectory) {
                        markStartupTrace('activateDirectory:skippedUnknownDirectory', { directory });
                        return;
                    }
                    const directoryKey = toDirectoryKey(configDirectory);
                    let snapshotHadProviders = false;
                    let snapshotHadAgents = false;

                    set((state) => {
                        const snapshot = state.directoryScoped[directoryKey];
                        if (snapshot) {
                            snapshotHadProviders = snapshot.providers.length > 0;
                            snapshotHadAgents = snapshot.agents.length > 0;
                            return {
                                activeDirectoryKey: directoryKey,
                                providers: snapshot.providers,
                                agents: snapshot.agents,
                                currentProviderId: snapshot.currentProviderId,
                                currentModelId: snapshot.currentModelId,
                                currentVariant: snapshot.currentVariant,
                                currentAgentName: snapshot.currentAgentName,
                                selectedProviderId: snapshot.selectedProviderId,
                                agentModelSelections: snapshot.agentModelSelections,
                                defaultProviders: snapshot.defaultProviders,
                                runtimeDefaultAgent: snapshot.runtimeDefaultAgent,
                                runtimeDefaultModel: snapshot.runtimeDefaultModel,
                                selectionSource: snapshot.selectionSource ?? "auto",
                            };
                        }

                        return {
                            activeDirectoryKey: directoryKey,
                            providers: [],
                            agents: [],
                            currentProviderId: "",
                            currentModelId: "",
                            currentAgentName: undefined,
                            selectedProviderId: "",
                            agentModelSelections: {},
                            defaultProviders: {},
                            runtimeDefaultAgent: undefined,
                            runtimeDefaultModel: undefined,
                            selectionSource: "auto",
                        };
                    });

                    if (!get().isConnected) {
                        return;
                    }

                    if (snapshotHadProviders) {
                        if (isConfigFresh(_providersLoadedAt, directoryKey)) {
                            markStartupTrace('activateDirectory:providersFresh', { directoryKey });
                        } else {
                            markStartupTrace('activateDirectory:refreshProvidersBackground', { directoryKey });
                            void get().loadProviders({ directory: fromDirectoryKey(directoryKey), source: 'activateDirectory:refresh' });
                        }
                    } else {
                        await get().loadProviders({ directory: fromDirectoryKey(directoryKey), source: 'activateDirectory' });
                    }

                    if (snapshotHadAgents) {
                        if (isConfigFresh(_agentsLoadedAt, directoryKey)) {
                            markStartupTrace('activateDirectory:agentsFresh', { directoryKey });
                        } else {
                            markStartupTrace('activateDirectory:refreshAgentsBackground', { directoryKey });
                            void get().loadAgents({ directory: fromDirectoryKey(directoryKey), source: 'activateDirectory:refresh' });
                        }
                    } else {
                        await get().loadAgents({ directory: fromDirectoryKey(directoryKey), source: 'activateDirectory' });
                    }
                },

                invalidateProviderCache: (directory) => {
                    const targetDirectoryKey = directory === undefined ? null : toDirectoryKey(directory);

                    set((state) => {
                        const nextState: Partial<ConfigStore> = {};
                        let scopedChanged = false;
                        const nextDirectoryScoped: Record<string, DirectoryScopedConfig> = {
                            ...state.directoryScoped,
                        };

                        const clearSnapshot = (snapshot: DirectoryScopedConfig): DirectoryScopedConfig => {
                            if (snapshot.providers.length === 0 && Object.keys(snapshot.defaultProviders).length === 0) {
                                return snapshot;
                            }

                            scopedChanged = true;
                            return {
                                ...snapshot,
                                providers: [],
                                defaultProviders: {},
                            };
                        };

                        if (targetDirectoryKey) {
                            const snapshot = state.directoryScoped[targetDirectoryKey];
                            if (snapshot) {
                                nextDirectoryScoped[targetDirectoryKey] = clearSnapshot(snapshot);
                            }
                        } else {
                            for (const [directoryKey, snapshot] of Object.entries(state.directoryScoped)) {
                                nextDirectoryScoped[directoryKey] = clearSnapshot(snapshot);
                            }
                        }

                        if (scopedChanged) {
                            nextState.directoryScoped = nextDirectoryScoped;
                        }

                        if (targetDirectoryKey === null || targetDirectoryKey === state.activeDirectoryKey) {
                            if (state.providers.length > 0) {
                                nextState.providers = [];
                            }
                            if (Object.keys(state.defaultProviders).length > 0) {
                                nextState.defaultProviders = {};
                            }
                        }

                        return Object.keys(nextState).length > 0 ? nextState : state;
                    });
                },

                loadProviders: async (options) => {
                    const requestedDirectory = options?.directory ?? fromDirectoryKey(get().activeDirectoryKey);
                    const configDirectory = resolveConfigDirectory(requestedDirectory);
                    if (!configDirectory) {
                        markStartupTrace('loadProviders:skippedUnknownDirectory', { requestedDirectory, source: options?.source ?? 'unknown' });
                        return;
                    }
                    const effectiveDirectory = configDirectory ?? useDirectoryStore.getState().currentDirectory ?? null;
                    const directoryKey = toDirectoryKey(configDirectory);
                    const source = options?.source ?? 'unknown';
                    markStartupTrace('loadProviders:called', { directoryKey, source, requestedDirectory, effectiveDirectory });

                    const existing = _inFlightProviders.get(directoryKey);
                    if (existing) {
                        markStartupTrace('loadProviders:deduped', { directoryKey, source, requestedDirectory, effectiveDirectory });
                        return existing;
                    }

                    const promise = (async () => {
                    const loaderStarted = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    markStartupTrace('loadProviders:start', { directoryKey, source, requestedDirectory, effectiveDirectory });
                    const existingSnapshot = get().directoryScoped[directoryKey];
                    const previousProviders = existingSnapshot?.providers ?? (get().activeDirectoryKey === directoryKey ? get().providers : []);
                    const previousDefaults = existingSnapshot?.defaultProviders ?? (get().activeDirectoryKey === directoryKey ? get().defaultProviders : {});
                    let lastError: unknown = null;

                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            ensureModelMetadataLoaded(
                                () => get().modelsMetadata,
                                (metadata) => set({ modelsMetadata: metadata }),
                            );
                            const apiResult = await measureStartupTrace(
                                'loadProviders:api',
                                async () => fetchAndProcessProviders(),
                                { directoryKey, source, requestedDirectory, effectiveDirectory, attempt: attempt + 1 },
                            );
                            const processedProviders = apiResult?.providers ?? [];
                            const defaults = apiResult?.defaults ?? {};

                            set((state) => {
                                const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                                    providers: [],
                                    agents: [],
                                    currentProviderId: "",
                                    currentModelId: "",
                                    currentAgentName: undefined,
                                    selectedProviderId: "",
                                    agentModelSelections: {},
                                    defaultProviders: {},
                                };

                                const currentProviderId = state.activeDirectoryKey === directoryKey
                                    ? state.currentProviderId
                                    : baseSnapshot.currentProviderId;
                                const currentModelId = state.activeDirectoryKey === directoryKey
                                    ? state.currentModelId
                                    : baseSnapshot.currentModelId;
                                const currentVariant = state.activeDirectoryKey === directoryKey
                                    ? state.currentVariant
                                    : baseSnapshot.currentVariant;
                                const resolvedModel = resolveProviderModelSelection({
                                    providers: processedProviders,
                                    currentProviderId,
                                    currentModelId,
                                    currentVariant,
                                    settingsDefaultModel: state.settingsDefaultModel,
                                    settingsDefaultVariant: state.settingsDefaultVariant,
                                });
                                const currentSelectedProviderId = state.activeDirectoryKey === directoryKey
                                    ? state.selectedProviderId
                                    : baseSnapshot.selectedProviderId;
                                const selectedProviderId = currentSelectedProviderId === ADD_PROVIDER_SENTINEL
                                    || processedProviders.some((provider) => provider.id === currentSelectedProviderId)
                                    ? currentSelectedProviderId
                                    : (resolvedModel?.providerId ?? processedProviders[0]?.id ?? "");

                                const nextSnapshot: DirectoryScopedConfig = {
                                    ...baseSnapshot,
                                    providers: processedProviders,
                                    defaultProviders: defaults,
                                    currentProviderId: resolvedModel?.providerId ?? "",
                                    currentModelId: resolvedModel?.modelId ?? "",
                                    currentVariant: resolvedModel?.variant,
                                    selectedProviderId,
                                };

                                const nextState: Partial<ConfigStore> = {
                                    directoryScoped: {
                                        ...state.directoryScoped,
                                        [directoryKey]: nextSnapshot,
                                    },
                                };

                                if (state.activeDirectoryKey === directoryKey) {
                                    nextState.providers = processedProviders;
                                    nextState.defaultProviders = defaults;
                                    nextState.currentProviderId = nextSnapshot.currentProviderId;
                                    nextState.currentModelId = nextSnapshot.currentModelId;
                                    nextState.currentVariant = nextSnapshot.currentVariant;
                                    nextState.selectedProviderId = selectedProviderId;
                                }

                                return nextState;
                            });

                            const loaderEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                            markStartupTrace('loadProviders:end', {
                                directoryKey,
                                source,
                                requestedDirectory,
                                effectiveDirectory,
                                durationMs: Math.round(loaderEnded - loaderStarted),
                                providers: processedProviders.length,
                                models: processedProviders.reduce((count, provider) => count + provider.models.length, 0),
                            });
                            _providersLoadedAt.set(directoryKey, Date.now());
                            return;
                        } catch (error) {
                            lastError = error;
                            markStartupTrace('loadProviders:attemptError', {
                                directoryKey,
                                source,
                                requestedDirectory,
                                effectiveDirectory,
                                attempt: attempt + 1,
                                error: error instanceof Error ? error.message : String(error),
                            });
                            const waitMs = 200 * (attempt + 1);
                            await new Promise((resolve) => setTimeout(resolve, waitMs));
                        }
                    }

                    console.error("Failed to load providers:", lastError);
                    markStartupTrace('loadProviders:error', {
                        directoryKey,
                        source,
                        requestedDirectory,
                        effectiveDirectory,
                        error: lastError instanceof Error ? lastError.message : String(lastError),
                    });

                    set((state) => {
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: [],
                            agents: [],
                            currentProviderId: "",
                            currentModelId: "",
                            currentAgentName: undefined,
                            selectedProviderId: "",
                            agentModelSelections: {},
                            defaultProviders: {},
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            providers: previousProviders,
                            defaultProviders: previousDefaults,
                        };

                        const nextState: Partial<ConfigStore> = {
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };

                        if (state.activeDirectoryKey === directoryKey) {
                            nextState.providers = previousProviders;
                            nextState.defaultProviders = previousDefaults;

                            if (!state.currentProviderId && !state.currentModelId && state.settingsDefaultModel) {
                                const parsed = parseModelString(state.settingsDefaultModel);
                                if (parsed) {
                                    const settingsProvider = previousProviders.find((p) => p.id === parsed.providerId);
                                    if (settingsProvider?.models.some((m) => m.id === parsed.modelId)) {
                                        const model = settingsProvider.models.find((m) => m.id === parsed.modelId);
                                        const currentVariant = resolveThinkingVariant(model, state.settingsDefaultVariant);

                                        nextState.currentProviderId = parsed.providerId;
                                        nextState.currentModelId = parsed.modelId;
                                        nextState.currentVariant = currentVariant;
                                        nextState.selectedProviderId = parsed.providerId;

                                        nextSnapshot.currentProviderId = parsed.providerId;
                                        nextSnapshot.currentModelId = parsed.modelId;
                                        nextSnapshot.currentVariant = currentVariant;
                                        nextSnapshot.selectedProviderId = parsed.providerId;
                                    }
                                }
                            }
                        }

                        return nextState;
                    });
                    })().finally(() => _inFlightProviders.delete(directoryKey));

                    _inFlightProviders.set(directoryKey, promise);
                    return promise;
                },

                setProvider: (providerId: string) => {
                    const { providers } = get();
                    const provider = providers.find((p) => p.id === providerId);

                    if (!provider) {
                        return;
                    }

                    const firstModel = provider.models[0];
                    const newModelId = firstModel?.id || "";

                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentVariant: state.currentVariant,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            defaultProviders: state.defaultProviders,
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentProviderId: providerId,
                            currentModelId: newModelId,
                            selectedProviderId: providerId,
                            selectionSource: "manual",
                        };

                        return {
                            currentProviderId: providerId,
                            currentModelId: newModelId,
                            selectedProviderId: providerId,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                setModel: (modelId: string) => {
                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentVariant: state.currentVariant,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            defaultProviders: state.defaultProviders,
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentModelId: modelId,
                            selectionSource: "manual",
                        };

                        return {
                            currentModelId: modelId,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                setCurrentVariant: (variant: string | undefined) => {
                    set((state) => {
                        if (state.currentVariant === variant) {
                            return state;
                        }

                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentVariant: state.currentVariant,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            defaultProviders: state.defaultProviders,
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentVariant: variant,
                            selectionSource: "manual",
                        };

                        return {
                            currentVariant: variant,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                getCurrentModelVariants: () => configurableThinkingLevels(get().getCurrentModel()),

                cycleCurrentVariant: () => {
                    const next = cycleThinkingLevel(get().getCurrentModelVariants(), get().currentVariant, 1);
                    get().setCurrentVariant(next);
                },

                setSelectedProvider: (providerId: string) => {
                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            defaultProviders: state.defaultProviders,
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            selectedProviderId: providerId,
                            selectionSource: "manual",
                        };

                        return {
                            selectedProviderId: providerId,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                saveAgentModelSelection: (agentName: string, providerId: string, modelId: string) => {
                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const nextSelections = {
                            ...state.agentModelSelections,
                            [agentName]: { providerId, modelId },
                        };

                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            defaultProviders: state.defaultProviders,
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            agentModelSelections: nextSelections,
                            selectionSource: "manual",
                        };

                        return {
                            agentModelSelections: nextSelections,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                getAgentModelSelection: (agentName: string) => {
                    const { agentModelSelections } = get();
                    return agentModelSelections[agentName] || null;
                },

                loadAgents: async (options) => {
                    const requestedDirectory = options?.directory ?? fromDirectoryKey(get().activeDirectoryKey);
                    const configDirectory = resolveConfigDirectory(requestedDirectory);
                    if (!configDirectory) {
                        markStartupTrace('loadAgents:skippedUnknownDirectory', { requestedDirectory, source: options?.source ?? 'unknown' });
                        return false;
                    }
                    const effectiveDirectory = configDirectory ?? useDirectoryStore.getState().currentDirectory ?? null;
                    const directoryKey = toDirectoryKey(configDirectory);
                    const source = options?.source ?? 'unknown';
                    markStartupTrace('loadAgents:called', { directoryKey, source, requestedDirectory, effectiveDirectory });

                    const existing = _inFlightAgents.get(directoryKey);
                    if (existing) {
                        markStartupTrace('loadAgents:deduped', { directoryKey, source, requestedDirectory, effectiveDirectory });
                        return existing;
                    }

                    const promise = (async (): Promise<boolean> => {
                    const loaderStarted = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    markStartupTrace('loadAgents:start', { directoryKey, source, requestedDirectory, effectiveDirectory });
                    const existingSnapshot = get().directoryScoped[directoryKey];
                    const previousAgents = existingSnapshot?.agents ?? (get().activeDirectoryKey === directoryKey ? get().agents : []);
                    let lastError: unknown = null;

                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            const configDirectoryPath = fromDirectoryKey(directoryKey);
                            const initialSyncedRuntimeConfig = getSyncConfig(requestedDirectory ?? undefined)
                                ?? getSyncConfig(configDirectoryPath ?? undefined);
                            if (initialSyncedRuntimeConfig) {
                                markStartupTrace('loadAgents:syncConfigHit', { directoryKey, source });
                            }
                            const openChamberDefaults = await fetchPiChamberDefaults();

                            const providerLoad = _inFlightProviders.get(directoryKey);
                            if (providerLoad) {
                                markStartupTrace('loadAgents:awaitProviders', { directoryKey, source });
                                await providerLoad;
                            }

                            const latestSyncedRuntimeConfig = getSyncConfig(requestedDirectory ?? undefined)
                                ?? getSyncConfig(configDirectoryPath ?? undefined);
                            const hasLatestSyncedRuntimeConfig = latestSyncedRuntimeConfig !== undefined;
                            const latestSyncedRuntimeDefaultAgent = hasLatestSyncedRuntimeConfig
                                ? normalizeOptionalString(latestSyncedRuntimeConfig.default_agent)
                                : undefined;
                            const latestSyncedRuntimeDefaultModel = hasLatestSyncedRuntimeConfig
                                ? normalizeOptionalString(latestSyncedRuntimeConfig.model)
                                : undefined;

                            const providers = get().activeDirectoryKey === directoryKey
                                ? get().providers
                                : (get().directoryScoped[directoryKey]?.providers ?? []);
                            const existingZenModel = normalizeOptionalString(get().settingsZenModel);
                            const defaultZenModel = normalizeOptionalString(openChamberDefaults.zenModel);
                            const resolvedGitSelection = resolveGitGenerationModelSelection({
                                providers,
                                settingsZenModel: existingZenModel,
                            }) ?? resolveGitGenerationModelSelection({
                                providers,
                                settingsZenModel: defaultZenModel,
                            });
                            const resolvedZenModel = resolvedGitSelection?.modelId || defaultZenModel || existingZenModel;

                            set((state) => {
                                const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                                    providers,
                                    agents: previousAgents,
                                    currentProviderId: "",
                                    currentModelId: "",
                                    currentAgentName: undefined,
                                    selectedProviderId: "",
                                    agentModelSelections: {},
                                    defaultProviders: {},
                                };
                                const runtimeDefaultAgent = hasLatestSyncedRuntimeConfig
                                    ? latestSyncedRuntimeDefaultAgent
                                    : baseSnapshot.runtimeDefaultAgent ?? (state.activeDirectoryKey === directoryKey ? state.runtimeDefaultAgent : undefined);
                                const runtimeDefaultModel = hasLatestSyncedRuntimeConfig
                                    ? latestSyncedRuntimeDefaultModel
                                    : baseSnapshot.runtimeDefaultModel ?? (state.activeDirectoryKey === directoryKey ? state.runtimeDefaultModel : undefined);
                                const nextSnapshot: DirectoryScopedConfig = {
                                    ...baseSnapshot,
                                    providers,
                                    agents: [],
                                    currentAgentName: undefined,
                                    runtimeDefaultAgent,
                                    runtimeDefaultModel,
                                };
                                const nextState: Partial<ConfigStore> = {
                                    settingsDefaultModel: openChamberDefaults.defaultModel,
                                    settingsDefaultVariant: openChamberDefaults.defaultVariant,
                                    settingsDefaultThinking: openChamberDefaults.defaultThinking,
                                    settingsDefaultThinkingByModel: openChamberDefaults.defaultThinkingByModel ?? {},
                                    settingsAutoCreateWorktree: openChamberDefaults.autoCreateWorktree ?? false,
                                    settingsGitmojiEnabled: openChamberDefaults.gitmojiEnabled ?? false,
                                    settingsDefaultFileViewerPreview: openChamberDefaults.defaultFileViewerPreview ?? false,
                                    settingsZenModel: resolvedZenModel,
                                    directoryScoped: {
                                        ...state.directoryScoped,
                                        [directoryKey]: nextSnapshot,
                                    },
                                };
                                if (state.activeDirectoryKey === directoryKey) {
                                    nextState.agents = [];
                                    nextState.currentAgentName = undefined;
                                    nextState.runtimeDefaultAgent = runtimeDefaultAgent;
                                    nextState.runtimeDefaultModel = runtimeDefaultModel;
                                }
                                return nextState;
                            });

                            if (resolvedZenModel && resolvedZenModel !== defaultZenModel) {
                                updateDesktopSettings({
                                    zenModel: resolvedZenModel,
                                    gitProviderId: '',
                                    gitModelId: '',
                                }).catch(() => {});
                            }

                            const loaderEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                            markStartupTrace('loadAgents:end', {
                                directoryKey,
                                source,
                                requestedDirectory,
                                effectiveDirectory,
                                durationMs: Math.round(loaderEnded - loaderStarted),
                                agents: 0,
                            });
                            _agentsLoadedAt.set(directoryKey, Date.now());
                            return true;
                        } catch (error) {
                            lastError = error;
                            markStartupTrace('loadAgents:attemptError', {
                                directoryKey,
                                source,
                                requestedDirectory,
                                effectiveDirectory,
                                attempt: attempt + 1,
                                error: error instanceof Error ? error.message : String(error),
                            });
                            const waitMs = 200 * (attempt + 1);
                            await new Promise((resolve) => setTimeout(resolve, waitMs));
                        }
                    }

                    console.error("Failed to load agents:", lastError);
                    markStartupTrace('loadAgents:error', {
                        directoryKey,
                        source,
                        requestedDirectory,
                        effectiveDirectory,
                        error: lastError instanceof Error ? lastError.message : String(lastError),
                    });

                    set((state) => {
                        const providers = state.activeDirectoryKey === directoryKey
                            ? state.providers
                            : (state.directoryScoped[directoryKey]?.providers ?? []);

                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers,
                            agents: [],
                            currentProviderId: "",
                            currentModelId: "",
                            currentAgentName: undefined,
                            selectedProviderId: "",
                            agentModelSelections: {},
                            defaultProviders: {},
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            providers,
                            agents: previousAgents,
                        };

                        const nextState: Partial<ConfigStore> = {
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };

                        if (state.activeDirectoryKey === directoryKey) {
                            nextState.agents = previousAgents;
                        }

                        return nextState;
                    });

                    return false;
                    })().finally(() => _inFlightAgents.delete(directoryKey));

                    _inFlightAgents.set(directoryKey, promise);
                    return promise;
                },

                invalidateModelMetadataCache: () => {
                    invalidateModelMetadataLoad();
                    set({ modelsMetadata: new Map<string, ModelMetadata>() });
                },

                setAgent: (agentName: string | undefined) => {
                    const {
                        agents,
                        providers,
                        settingsDefaultModel,
                        settingsDefaultVariant,
                        currentProviderId,
                        currentModelId,
                    } = get();

                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentVariant: state.currentVariant,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            defaultProviders: state.defaultProviders,
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentAgentName: agentName,
                            selectionSource: "manual",
                        };

                        return {
                            currentAgentName: agentName,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });

                    if (agentName) {
                        const { currentSessionId } = useSessionUIStore.getState();
                        const selState = useSelectionStore.getState();

                        if (currentSessionId) {
                            selState.saveSessionAgentSelection(currentSessionId, agentName);
                        }

                        if (currentSessionId && useSessionUIStore.getState().isPiChamberCreatedSession(currentSessionId)) {
                            const existingAgentModel = selState.getAgentModelForSession(currentSessionId, agentName);
                            if (!existingAgentModel) {
                                useSessionUIStore.getState().initializeNewPiChamberSession(currentSessionId, agents);
                            }
                        }
                    }

                    if (agentName) {
                        const { currentSessionId } = useSessionUIStore.getState();

                        const applyResolvedModelSelection = (providerId: string, modelId: string, variant?: string) => {
                            set((state) => {
                                const directoryKey = state.activeDirectoryKey;
                                const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                                    providers: state.providers,
                                    agents: state.agents,
                                    currentProviderId: state.currentProviderId,
                                    currentModelId: state.currentModelId,
                                    currentVariant: state.currentVariant,
                                    currentAgentName: state.currentAgentName,
                                    selectedProviderId: state.selectedProviderId,
                                    agentModelSelections: state.agentModelSelections,
                                    defaultProviders: state.defaultProviders,
                                };

                                const nextSnapshot: DirectoryScopedConfig = {
                                    ...baseSnapshot,
                                    currentProviderId: providerId,
                                    currentModelId: modelId,
                                    currentVariant: variant,
                                    selectedProviderId: preserveAddProviderSelection(state.selectedProviderId, providerId),
                                    selectionSource: "manual",
                                };

                                return {
                                    currentProviderId: providerId,
                                    currentModelId: modelId,
                                    currentVariant: variant,
                                    selectedProviderId: preserveAddProviderSelection(state.selectedProviderId, providerId),
                                    selectionSource: "manual",
                                    directoryScoped: {
                                        ...state.directoryScoped,
                                        [directoryKey]: nextSnapshot,
                                    },
                                };
                            });
                        };

                        const resolveVariantForModel = (
                            providerId: string,
                            modelId: string,
                            agentVariant?: string,
                        ): string | undefined => {
                            const model = providers
                                .find((provider) => provider.id === providerId)
                                ?.models.find((candidate) => candidate.id === modelId);
                            const thinkingLevels = configurableThinkingLevels(model);
                            if (thinkingLevels.length === 0) return undefined;

                            const savedVariant = currentSessionId
                                ? useSelectionStore.getState().getAgentModelVariantForSession(
                                    currentSessionId,
                                    agentName,
                                    providerId,
                                    modelId,
                                )
                                : undefined;

                            for (const candidate of [savedVariant, agentVariant, settingsDefaultVariant]) {
                                const resolved = resolveThinkingVariant(model, candidate);
                                if (resolved) return resolved;
                            }

                            return undefined;
                        };

                        const agent = asConfigAgent(agents.find((candidate) => candidate.name === agentName));

                        if (currentSessionId) {
                            const existingAgentModel = useSelectionStore.getState().getAgentModelForSession(currentSessionId, agentName);
                            if (existingAgentModel && hasProviderModel(providers, existingAgentModel.providerId, existingAgentModel.modelId)) {
                                const resolvedVariant = resolveVariantForModel(existingAgentModel.providerId, existingAgentModel.modelId, agent?.variant);
                                if (
                                    currentProviderId !== existingAgentModel.providerId
                                    || currentModelId !== existingAgentModel.modelId
                                    || get().currentVariant !== resolvedVariant
                                ) {
                                    applyResolvedModelSelection(existingAgentModel.providerId, existingAgentModel.modelId, resolvedVariant);
                                }
                                return;
                            }
                        }

                        const agentModelSelection = agent?.model;
                        if (agentModelSelection?.providerID && agentModelSelection?.modelID) {
                            const { providerID, modelID } = agentModelSelection;
                            const agentProvider = providers.find((provider) => provider.id === providerID);
                            const agentModel = agentProvider?.models.find((model) => model.id === modelID);

                            if (agentModel) {
                                applyResolvedModelSelection(providerID, modelID, resolveVariantForModel(providerID, modelID, agent?.variant));
                                return;
                            }
                        }

                        if (settingsDefaultModel) {
                            const parsed = parseModelString(settingsDefaultModel);
                            if (parsed) {
                                const settingsProvider = providers.find((p) => p.id === parsed.providerId);
                                if (settingsProvider?.models.some((m) => m.id === parsed.modelId)) {
                                    applyResolvedModelSelection(parsed.providerId, parsed.modelId, resolveVariantForModel(parsed.providerId, parsed.modelId, agent?.variant));
                                    return;
                                }
                            }
                        }
                    }
                },

                applyDefaultModelAgentSelection: (options) => {
                    const {
                        agents,
                        providers,
                        settingsDefaultModel,
                        settingsDefaultVariant,
                        runtimeDefaultAgent,
                        runtimeDefaultModel,
                    } = get();

                    if (agents.length === 0 || providers.length === 0) {
                        return;
                    }

                    const {
                        agentName: resolvedAgentName,
                        providerId: resolvedProviderId,
                        modelId: resolvedModelId,
                        variant: resolvedVariant,
                    } = resolveDefaultAgentModelSelection({
                        agents,
                        providers,
                        projectDefaultModel: options?.projectDefaultModel,
                        settingsDefaultModel,
                        settingsDefaultVariant,
                        runtimeDefaultAgent,
                        runtimeDefaultModel,
                    });

                    if (!resolvedAgentName) {
                        return;
                    }

                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentVariant: state.currentVariant,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            defaultProviders: state.defaultProviders,
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentAgentName: resolvedAgentName,
                            ...(resolvedProviderId && resolvedModelId
                                ? {
                                    currentProviderId: resolvedProviderId,
                                    currentModelId: resolvedModelId,
                                    currentVariant: resolvedVariant,
                                    selectedProviderId: preserveAddProviderSelection(state.selectedProviderId, resolvedProviderId),
                                }
                                : {}),
                            selectionSource: "auto",
                        };

                        const nextState: Partial<ConfigStore> = {
                            currentAgentName: resolvedAgentName,
                            selectionSource: "auto",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };

                        if (resolvedProviderId && resolvedModelId) {
                            nextState.currentProviderId = resolvedProviderId;
                            nextState.currentModelId = resolvedModelId;
                            nextState.currentVariant = resolvedVariant;
                            nextState.selectedProviderId = preserveAddProviderSelection(state.selectedProviderId, resolvedProviderId);
                        }

                        return nextState;
                    });
                },

                applyRuntimeConfigDefaults: (directory, source = "syncConfig", config) => {
                    const eventDirectory = directory ?? fromDirectoryKey(get().activeDirectoryKey);
                    const directoryKey = toConfigDirectoryKey(eventDirectory);
                    const configDirectory = fromDirectoryKey(directoryKey);
                    const syncedConfig = config
                        ?? getSyncConfig(eventDirectory ?? undefined)
                        ?? getSyncConfig(configDirectory ?? undefined);
                    if (!syncedConfig) {
                        return;
                    }

                    const runtimeDefaultAgent = normalizeOptionalString(syncedConfig.default_agent);
                    const runtimeDefaultModel = normalizeOptionalString(syncedConfig.model);

                    set((state) => {
                        const snapshot = state.directoryScoped[directoryKey];
                        const isActive = state.activeDirectoryKey === directoryKey;
                        const providers = isActive ? state.providers : (snapshot?.providers ?? []);
                        const agents = isActive ? state.agents : (snapshot?.agents ?? []);
                        const baseSnapshot: DirectoryScopedConfig = snapshot ?? createEmptyDirectoryScopedConfig(providers, agents);
                        const defaultsChanged = baseSnapshot.runtimeDefaultAgent !== runtimeDefaultAgent
                            || baseSnapshot.runtimeDefaultModel !== runtimeDefaultModel
                            || (isActive && (
                                state.runtimeDefaultAgent !== runtimeDefaultAgent
                                || state.runtimeDefaultModel !== runtimeDefaultModel
                            ));
                        const defaultsSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            providers,
                            agents,
                            runtimeDefaultAgent,
                            runtimeDefaultModel,
                        };
                        const nextState: Partial<ConfigStore> = {
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: defaultsSnapshot,
                            },
                        };

                        if (isActive) {
                            nextState.runtimeDefaultAgent = runtimeDefaultAgent;
                            nextState.runtimeDefaultModel = runtimeDefaultModel;
                        }

                        const selectionSource = isActive ? state.selectionSource : (snapshot?.selectionSource ?? "auto");

                        if (providers.length === 0 || agents.length === 0) {
                            if (!defaultsChanged) {
                                return state;
                            }
                            return nextState;
                        }

                        const resolved = resolveDefaultAgentModelSelection({
                            agents,
                            providers,
                            settingsDefaultModel: state.settingsDefaultModel,
                            settingsDefaultVariant: state.settingsDefaultVariant,
                            runtimeDefaultAgent,
                            runtimeDefaultModel,
                        });

                        if (!resolved.agentName) {
                            if (!defaultsChanged) {
                                return state;
                            }
                            return nextState;
                        }

                        const currentAgentName = isActive ? state.currentAgentName : baseSnapshot.currentAgentName;
                        const currentProviderId = isActive ? state.currentProviderId : baseSnapshot.currentProviderId;
                        const currentModelId = isActive ? state.currentModelId : baseSnapshot.currentModelId;
                        const currentVariant = isActive ? state.currentVariant : baseSnapshot.currentVariant;
                        const currentSelectedProviderId = isActive ? state.selectedProviderId : baseSnapshot.selectedProviderId;
                        const nextSelection = resolveSelectionWithManualGuard({
                            agents,
                            providers,
                            currentAgentName,
                            currentProviderId,
                            currentModelId,
                            currentVariant,
                            selectionSource,
                            resolvedAgentName: resolved.agentName,
                            resolvedProviderId: resolved.providerId,
                            resolvedModelId: resolved.modelId,
                            resolvedVariant: resolved.variant,
                        });

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...defaultsSnapshot,
                            providers,
                            agents,
                            currentAgentName: nextSelection.agentName,
                            ...(nextSelection.providerId && nextSelection.modelId
                                ? {
                                    currentProviderId: nextSelection.providerId,
                                    currentModelId: nextSelection.modelId,
                                    currentVariant: nextSelection.variant,
                                    selectedProviderId: preserveAddProviderSelection(currentSelectedProviderId, nextSelection.providerId),
                                }
                                : {}),
                            selectionSource: nextSelection.selectionSource,
                        };

                        const selectionChanged = baseSnapshot.currentAgentName !== nextSnapshot.currentAgentName
                            || baseSnapshot.currentProviderId !== nextSnapshot.currentProviderId
                            || baseSnapshot.currentModelId !== nextSnapshot.currentModelId
                            || baseSnapshot.currentVariant !== nextSnapshot.currentVariant
                            || baseSnapshot.selectedProviderId !== nextSnapshot.selectedProviderId
                            || (baseSnapshot.selectionSource ?? "auto") !== nextSnapshot.selectionSource
                            || (isActive && (
                                state.currentAgentName !== nextSelection.agentName
                                || state.selectionSource !== nextSelection.selectionSource
                                || (nextSelection.providerId !== undefined && nextSelection.modelId !== undefined && (
                                    state.currentProviderId !== nextSelection.providerId
                                    || state.currentModelId !== nextSelection.modelId
                                    || state.currentVariant !== nextSelection.variant
                                    || state.selectedProviderId !== preserveAddProviderSelection(currentSelectedProviderId, nextSelection.providerId)
                                ))
                            ));

                        if (!defaultsChanged && !selectionChanged) {
                            return state;
                        }

                        nextState.directoryScoped = {
                            ...state.directoryScoped,
                            [directoryKey]: nextSnapshot,
                        };

                        if (isActive) {
                            nextState.currentAgentName = nextSelection.agentName;
                            nextState.selectionSource = nextSelection.selectionSource;
                            if (nextSelection.providerId && nextSelection.modelId) {
                                nextState.currentProviderId = nextSelection.providerId;
                                nextState.currentModelId = nextSelection.modelId;
                                nextState.currentVariant = nextSelection.variant;
                                nextState.selectedProviderId = preserveAddProviderSelection(currentSelectedProviderId, nextSelection.providerId);
                            }
                        }

                        markStartupTrace('loadAgents:runtimeConfigDefaultsApplied', { directoryKey, eventDirectory, source });
                        return nextState;
                    });
                },

                 setSettingsDefaultModel: (model: string | undefined) => {
                     set({ settingsDefaultModel: model });
                 },

                 setSettingsDefaultVariant: (variant: string | undefined) => {
                     set({ settingsDefaultVariant: variant });
                 },

                 setSettingsDefaultThinking: (thinking: string | undefined) => {
                     set({ settingsDefaultThinking: thinking });
                 },

                 setSettingsDefaultThinkingByModel: (map: Record<string, string>) => {
                     set({ settingsDefaultThinkingByModel: map });
                 },

                setSettingsAutoCreateWorktree: (enabled: boolean) => {
                    set({ settingsAutoCreateWorktree: enabled });
                },

                setSettingsGitmojiEnabled: (enabled: boolean) => {
                    set({ settingsGitmojiEnabled: enabled });
                },

                setSettingsDefaultFileViewerPreview: (enabled: boolean) => {
                    set({ settingsDefaultFileViewerPreview: enabled });
                },

                setSettingsZenModel: (model: string | undefined) => {
                    set({ settingsZenModel: model });
                },

                getResolvedGitGenerationModel: () => {
                    const state = get();
                    return resolveGitGenerationModelSelection({
                        providers: state.providers,
                        settingsZenModel: state.settingsZenModel,
                    });
                },

                probeConnection: async (options?: { timeoutMs?: number }) => {
                    const isHealthy = await probePiHealth(options?.timeoutMs);
                    if (isHealthy) {
                        set({ isConnected: true, hasEverConnected: true, connectionPhase: "connected" });
                        return true;
                    }

                    const state = get();
                    if (state.isConnected) {
                        return true;
                    }

                    set({
                        isConnected: false,
                        connectionPhase: state.hasEverConnected ? "reconnecting" : "connecting",
                        lastDisconnectReason: 'health_probe_unhealthy',
                    });
                    return false;
                },

                checkConnection: async () => {
                    markStartupTrace('checkConnection:start');
                    const maxAttempts = 5;
                    let attempt = 0;
                    let lastError: unknown = null;

                    while (attempt < maxAttempts) {
                        try {
                            markStartupTrace('checkConnection:attempt', { attempt: attempt + 1 });
                            const isHealthy = await measureStartupTrace(
                                'checkConnection:health',
                                () => checkPiHealth(),
                                { attempt: attempt + 1 },
                            );
                            if (!isHealthy && attempt < maxAttempts - 1) {
                                const hasEverConnected = get().hasEverConnected;
                                set({
                                    isConnected: false,
                                    connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
                                    lastDisconnectReason: 'health_check_unhealthy',
                                });
                                attempt += 1;
                                await sleep(400 * attempt);
                                continue;
                            }

                            const hasEverConnected = get().hasEverConnected;
                            set(isHealthy
                                ? { isConnected: true, hasEverConnected: true, connectionPhase: "connected" }
                                : {
                                    isConnected: false,
                                    connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
                                    lastDisconnectReason: 'health_check_unhealthy',
                                });
                            markStartupTrace('checkConnection:end', { healthy: isHealthy, attempts: attempt + 1 });
                            return isHealthy;
                        } catch (error) {
                            lastError = error;
                            attempt += 1;
                            const delay = 400 * attempt;
                            await sleep(delay);
                        }
                    }

                    if (lastError) {
                        console.warn("[ConfigStore] Failed to reach Pi after retrying:", lastError);
                    }
                    set({
                        isConnected: false,
                        connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                        lastDisconnectReason: 'health_check_failed',
                    });
                    markStartupTrace('checkConnection:end', { healthy: false, attempts: maxAttempts });
                    return false;
                },

                initializeApp: async () => {
                    if (_initializeAppInFlight) {
                        markStartupTrace('initializeApp:deduped');
                        return _initializeAppInFlight;
                    }

                    const run = (async () => {
                        const initStarted = typeof performance !== 'undefined' ? performance.now() : Date.now();
                        markStartupTrace('initializeApp:start');
                        try {
                            const debug = streamDebugEnabled();
                            if (debug) console.log("Starting app initialization...");

                            const isConnected = await get().checkConnection();
                            if (debug) console.log("Connection check result:", isConnected);

                            if (!isConnected) {
                                if (debug) console.log("Server not connected");
                                set({
                                    isConnected: false,
                                    connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                                });
                                return;
                            }

                            if (debug) console.log("Initializing app...");
                            markStartupTrace('initApp:skipped', { reason: 'checkConnection already verified health' });

                            const initialDirectory = useDirectoryStore.getState().currentDirectory
                                ?? fromDirectoryKey(get().activeDirectoryKey);
                            const resolvedProject = resolveProjectForSessionDirectory(
                                useProjectsStore.getState().projects,
                                null,
                                initialDirectory ?? null,
                            );
                            const resolvedInitialDirectory = resolveConfigDirectory(resolvedProject?.path ?? initialDirectory ?? null);
                            const configDirectory = resolvedInitialDirectory ?? getFallbackProjectDirectory();
                            if (!configDirectory) {
                                markStartupTrace('initializeApp:noProjectConfigDirectory');
                                set({ isInitialized: true, isConnected: true, hasEverConnected: true, connectionPhase: "connected" });
                                return;
                            }
                            if (!resolvedInitialDirectory && initialDirectory !== configDirectory) {
                                markStartupTrace('initializeApp:normalizedUnknownDirectoryToProject', {
                                    initialDirectory,
                                    configDirectory,
                                });
                                useDirectoryStore.getState().setDirectory(configDirectory, { showOverlay: false });
                            }
                            const configDirectoryKey = toDirectoryKey(configDirectory);
                            if (get().activeDirectoryKey !== configDirectoryKey) {
                                set({ activeDirectoryKey: configDirectoryKey });
                            }

                            if (debug) console.log("Loading providers and agents...");
                            await Promise.all([
                                get().loadProviders({ directory: configDirectory, source: 'initializeApp' }),
                                get().loadAgents({ directory: configDirectory, source: 'initializeApp' }),
                            ]);

                            set({ isInitialized: true, isConnected: true, hasEverConnected: true, connectionPhase: "connected" });
                            void get().prewarmProjectConfigs(configDirectory);
                            const initEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                            markStartupTrace('initializeApp:end', {
                                durationMs: Math.round(initEnded - initStarted),
                                providers: get().providers.length,
                                agents: get().agents.length,
                            });
                            if (debug) console.log("App initialized successfully");
                        } catch (error) {
                            console.error("Failed to initialize app:", error);
                            set({
                                isInitialized: false,
                                isConnected: false,
                                connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                                lastDisconnectReason: 'init_error',
                            });
                            markStartupTrace('initializeApp:error', { error: error instanceof Error ? error.message : String(error) });
                        }
                    })().finally(() => {
                        _initializeAppInFlight = null;
                    });

                    _initializeAppInFlight = run;
                    return run;
                },

                prewarmProjectConfigs: async (initialDirectory?: string | null) => {
                    if (!get().isConnected) {
                        return;
                    }

                    const initialKey = toConfigDirectoryKey(initialDirectory ?? fromDirectoryKey(get().activeDirectoryKey));
                    const projectDirectories = useProjectsStore.getState().projects
                        .map((project) => project.path)
                        .filter((path): path is string => typeof path === 'string' && path.trim().length > 0);
                    const seen = new Set<string>([initialKey]);
                    const queuedDirectories: string[] = [];

                    for (const directory of projectDirectories) {
                        const directoryKey = toConfigDirectoryKey(directory);
                        if (seen.has(directoryKey)) {
                            continue;
                        }
                        seen.add(directoryKey);

                        const snapshot = get().directoryScoped[directoryKey];
                        if (snapshot?.providers.length && snapshot.agents.length) {
                            continue;
                        }
                        const scopedDirectory = fromDirectoryKey(directoryKey);
                        if (scopedDirectory) {
                            queuedDirectories.push(scopedDirectory);
                        }
                    }

                    for (const directory of queuedDirectories) {
                        await sleep(PROJECT_CONFIG_PREWARM_DELAY_MS);
                        if (!get().isConnected) {
                            return;
                        }
                        const directoryKey = toConfigDirectoryKey(directory);
                        const snapshot = get().directoryScoped[directoryKey];
                        const tasks: Promise<unknown>[] = [];
                        if (!snapshot?.providers.length) {
                            tasks.push(get().loadProviders({ directory, source: 'projectConfigPrewarm' }));
                        }
                        if (!snapshot?.agents.length) {
                            tasks.push(get().loadAgents({ directory, source: 'projectConfigPrewarm' }));
                        }
                        if (tasks.length > 0) {
                            await Promise.allSettled(tasks);
                        }
                    }
                },

                getCurrentProvider: () => {
                    const { providers, currentProviderId } = get();
                    return providers.find((p) => p.id === currentProviderId);
                },

                getCurrentModel: () => {
                    const provider = get().getCurrentProvider();
                    const { currentModelId } = get();
                    if (!provider) {
                        return undefined;
                    }
                    return provider.models.find((model) => model.id === currentModelId);
                },

                getCurrentAgent: () => {
                    const { agents, currentAgentName } = get();
                    if (!currentAgentName) return undefined;
                    return agents.find((a) => a.name === currentAgentName);
                },
                getModelMetadata: (providerId: string, modelId: string) => {
                    const { modelsMetadata, providers } = get();
                    const model = providers
                        .find((provider) => provider.id === providerId)
                        ?.models.find((candidate) => candidate.id === modelId);
                    return resolveModelMetadata(modelsMetadata, providerId, modelId, model);
                },
                getVisibleAgents: () => {
                    const { agents } = get();
                    return agents;
                },
            }),
            {
                name: "config-store",
                storage: createDeferredSafeJSONStorage(),
                merge: (persistedState, currentState) =>
                    hydrateActiveDirectorySnapshot({
                        ...currentState,
                        ...(persistedState && typeof persistedState === 'object'
                            ? (persistedState as Partial<ConfigStore>)
                            : {}),
                    }),
                partialize: (state) => ({
                    activeDirectoryKey: state.activeDirectoryKey,
                    directoryScoped: Object.fromEntries(
                        Object.entries(state.directoryScoped).map(([directoryKey, snapshot]) => [
                            directoryKey,
                            {
                                ...snapshot,
                                selectedProviderId: sanitizePersistedSelectedProviderId(snapshot.selectedProviderId),
                            },
                        ]),
                    ),
                    providers: state.providers,
                    agents: state.agents,
                    currentProviderId: state.currentProviderId,
                    currentModelId: state.currentModelId,
                    currentVariant: state.currentVariant,
                    currentAgentName: state.currentAgentName,
                    selectedProviderId: sanitizePersistedSelectedProviderId(state.selectedProviderId),
                    agentModelSelections: state.agentModelSelections,
                    defaultProviders: state.defaultProviders,
                    settingsDefaultModel: state.settingsDefaultModel,
                    settingsDefaultVariant: state.settingsDefaultVariant,
                    settingsDefaultThinking: state.settingsDefaultThinking,
                    settingsDefaultThinkingByModel: state.settingsDefaultThinkingByModel,
                    settingsAutoCreateWorktree: state.settingsAutoCreateWorktree,
                    settingsGitmojiEnabled: state.settingsGitmojiEnabled,
                    settingsDefaultFileViewerPreview: state.settingsDefaultFileViewerPreview,
                    settingsZenModel: state.settingsZenModel,
                }),
             },
         ),
    ),
);

setupConfigStoreSubscribers(useConfigStore);
