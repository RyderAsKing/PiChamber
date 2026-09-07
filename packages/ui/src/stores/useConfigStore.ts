import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { ModelMetadata } from "@/types";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
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
    normalizeOptionalString,
    parseModelString,
    resolveGitGenerationModelSelection,
    resolveProviderModelSelection,
    resolveThinkingVariant,
    sanitizePersistedSelectedProviderId,
} from "./config/selection";
import {
    type ConfigStore,
    type DirectoryScopedConfig,
    hydrateActiveDirectorySnapshot,
    _providersLoadedAt,
    isConfigFresh,
    PROJECT_CONFIG_PREWARM_DELAY_MS,
} from "./config/configTypes";
import { checkPiHealth, probePiHealth } from "./config/configConnection";
import { setupConfigStoreSubscribers } from "./config/configSubscribers";
import { fetchAndProcessProviders } from "./config/configLoaders";
import { markStartupTrace, measureStartupTrace } from "@/lib/startupTrace";

export type { ConfigStore, DirectoryScopedConfig };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// In-flight dedup: prevent concurrent duplicate loadProviders calls for the same directory
const _inFlightProviders = new Map<string, Promise<void>>();
let _initializeAppInFlight: Promise<void> | null = null;

export const useConfigStore = create<ConfigStore>()(
    devtools(
        persist(
            (set, get) => ({

                activeDirectoryKey: resolveInitialDirectoryKey(),
                directoryScoped: {},

                providers: [],
                currentProviderId: "",
                currentModelId: "",
                currentVariant: undefined,
                selectedProviderId: "",
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
                settingsAutoCreateWorktree: false,
                settingsGitmojiEnabled: false,
                settingsZenModel: undefined,

                activateDirectory: async (directory) => {
                    const configDirectory = resolveConfigDirectory(directory);
                    const hasRequestedDirectory = typeof directory === 'string' && directory.trim().length > 0;
                    if (!configDirectory && hasRequestedDirectory) {
                        markStartupTrace('activateDirectory:skippedUnknownDirectory', { directory });
                        return;
                    }
                    const directoryKey = toDirectoryKey(configDirectory);
                    let snapshotHadProviders = false;

                    set((state) => {
                        const snapshot = state.directoryScoped[directoryKey];
                        if (snapshot) {
                            snapshotHadProviders = snapshot.providers.length > 0;
                            return {
                                activeDirectoryKey: directoryKey,
                                providers: snapshot.providers,
                                currentProviderId: snapshot.currentProviderId,
                                currentModelId: snapshot.currentModelId,
                                currentVariant: snapshot.currentVariant,
                                selectedProviderId: snapshot.selectedProviderId,
                                defaultProviders: snapshot.defaultProviders,
                                selectionSource: snapshot.selectionSource ?? "auto",
                            };
                        }

                        return {
                            activeDirectoryKey: directoryKey,
                            providers: [],
                            currentProviderId: "",
                            currentModelId: "",
                            selectedProviderId: "",
                            defaultProviders: {},
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
                    const hasRequestedDirectory = typeof requestedDirectory === 'string' && requestedDirectory.trim().length > 0;
                    if (!configDirectory && hasRequestedDirectory) {
                        markStartupTrace('loadProviders:skippedUnknownDirectory', { requestedDirectory, source: options?.source ?? 'unknown' });
                        return;
                    }
                    const effectiveDirectory = configDirectory ?? null;
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
                                    currentProviderId: "",
                                    currentModelId: "",
                                    selectedProviderId: "",
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
                            currentProviderId: "",
                            currentModelId: "",
                            selectedProviderId: "",
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
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentVariant: state.currentVariant,
                            selectedProviderId: state.selectedProviderId,
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
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentVariant: state.currentVariant,
                            selectedProviderId: state.selectedProviderId,
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
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentVariant: state.currentVariant,
                            selectedProviderId: state.selectedProviderId,
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
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            selectedProviderId: state.selectedProviderId,
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

                invalidateModelMetadataCache: () => {
                    invalidateModelMetadataLoad();
                    set({ modelsMetadata: new Map<string, ModelMetadata>() });
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
                                markStartupTrace('initializeApp:globalConfigScope');
                            }
                            if (configDirectory && !resolvedInitialDirectory && initialDirectory !== configDirectory) {
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

                            if (debug) console.log("Loading providers...");
                            await get().loadProviders({ directory: configDirectory, source: 'initializeApp' });

                            // PiChamber settings defaults (global sidecar) were previously
                            // applied inside the removed generic-agent loader. They are
                            // provider/model preferences, not agent state: apply them here
                            // once providers are known so model selection is unchanged.
                            const openChamberDefaults = await fetchPiChamberDefaults();
                            const providers = get().providers;
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
                            set({
                                settingsDefaultModel: openChamberDefaults.defaultModel,
                                settingsDefaultVariant: openChamberDefaults.defaultVariant,
                                settingsDefaultThinking: openChamberDefaults.defaultThinking,
                                settingsDefaultThinkingByModel: openChamberDefaults.defaultThinkingByModel ?? {},
                                settingsAutoCreateWorktree: openChamberDefaults.autoCreateWorktree ?? false,
                                settingsGitmojiEnabled: openChamberDefaults.gitmojiEnabled ?? false,
                                settingsZenModel: resolvedZenModel,
                            });
                            if (resolvedZenModel && resolvedZenModel !== defaultZenModel) {
                                updateDesktopSettings({
                                    zenModel: resolvedZenModel,
                                    gitProviderId: '',
                                    gitModelId: '',
                                }).catch(() => {});
                            }

                            set({ isInitialized: true, isConnected: true, hasEverConnected: true, connectionPhase: "connected" });
                            void get().prewarmProjectConfigs(configDirectory);
                            const initEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                            markStartupTrace('initializeApp:end', {
                                durationMs: Math.round(initEnded - initStarted),
                                providers: get().providers.length,
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
                        if (snapshot?.providers.length) {
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

                getModelMetadata: (providerId: string, modelId: string) => {
                    const { modelsMetadata, providers } = get();
                    const model = providers
                        .find((provider) => provider.id === providerId)
                        ?.models.find((candidate) => candidate.id === modelId);
                    return resolveModelMetadata(modelsMetadata, providerId, modelId, model);
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
                    currentProviderId: state.currentProviderId,
                    currentModelId: state.currentModelId,
                    currentVariant: state.currentVariant,
                    selectedProviderId: sanitizePersistedSelectedProviderId(state.selectedProviderId),
                    defaultProviders: state.defaultProviders,
                    settingsDefaultModel: state.settingsDefaultModel,
                    settingsDefaultVariant: state.settingsDefaultVariant,
                    settingsDefaultThinking: state.settingsDefaultThinking,
                    settingsDefaultThinkingByModel: state.settingsDefaultThinkingByModel,
                    settingsAutoCreateWorktree: state.settingsAutoCreateWorktree,
                    settingsGitmojiEnabled: state.settingsGitmojiEnabled,
                    settingsZenModel: state.settingsZenModel,
                }),
             },
         ),
    ),
);

setupConfigStoreSubscribers(useConfigStore);
