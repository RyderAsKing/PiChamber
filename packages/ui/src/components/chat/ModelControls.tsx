import React from 'react';
import { focusChatInput } from './composer/editor/dom';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { ModelPickerList, type ModelPickerEntry, type ModelPickerProvider } from '@/components/model-picker/ModelPickerList';
import { isDesktopShell } from '@/lib/desktop';
import { useDeviceInfo, useTabletLayout } from '@/lib/device';
import { mergeModelMetadataWithLiveModel } from '@/lib/modelMetadata';
import { getModelDisplayName as getSharedModelDisplayName } from '@/lib/modelDisplay';
import { cn } from '@/lib/utils';
import { useContextStore } from '@/stores/contextStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionMessages, useSessionRenderable } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { useUIStore } from '@/stores/useUIStore';
import { useModelLists } from '@/hooks/useModelLists';
import { useIsTextTruncated } from '@/hooks/useIsTextTruncated';
import { formatEffortLabel, type MobileControlsPanel } from './mobileControlsUtils';
import { ThinkingLevelControl, ThinkingLevelPicker } from './ThinkingLevelControl';
import { usePiReadiness } from '@/hooks/usePiReadiness';
import { markStartupTrace } from '@/lib/startupTrace';
import { findLatestUserModelChoice } from '@/lib/messages/userModelChoice';
import { getSyncParts } from '@/sync/sync-refs';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { applyComposerThinking } from '@/lib/pi/apply-composer-thinking';
import {
    catalogThinkingLevels,
    configurableThinkingLevels,
    cycleThinkingLevel,
    isPiThinkingLevel,
    modelHasConfigurableThinking,
    parsePiThinkingLevel,
    resolveComposerThinkingForModel,
    thinkingLevelLabel,
} from '@/lib/pi/thinking';
import type { PiThinkingLevel } from '@/lib/pi/types';
import { classifyAuthoritativeComposerSelection } from './model-selection-sync';
import { formatCost, formatDate, formatKnowledge, formatTokens, getCapabilityIcons, getModalityIcons } from './modelControlsMetadata';
import { IconBadge, ModelTooltipContent } from './controls/ModelTooltipContent';
import { MobileModelTooltipPanel } from './controls/MobileModelTooltipPanel';
import { MobileVariantPanel } from './controls/MobileVariantPanel';
import { MobileModelPickerPanel } from './controls/MobileModelPickerPanel';

type IconComponent = IconName;

type ProviderModel = Record<string, unknown> & { id?: string; name?: string };

const buildModelRefKey = (providerID: string, modelID: string) => `${providerID}:${modelID}`;

type ModelApplyResult = 'applied' | 'provider-missing' | 'model-missing';

const ADD_PROVIDER_ID = '__add_provider__';

interface ModelControlsProps {
    className?: string;
    /** Keep model/variant names visible even when the control is in a narrow flex slot. */
    keepLabels?: boolean;
    mobilePanel?: MobileControlsPanel;
    onMobilePanelChange?: (panel: MobileControlsPanel) => void;
}

export const ModelControls: React.FC<ModelControlsProps> = ({
    className,
    keepLabels = false,
    mobilePanel,
    onMobilePanelChange,
}) => {
    const { isReady, isUnavailable } = usePiReadiness();
    const readinessLabel = isUnavailable ? "Unavailable" : "Loading...";
    const providers = useConfigStore((state) => state.providers);
    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const currentVariant = useConfigStore((state) => state.currentVariant);
    const settingsDefaultThinking = useConfigStore((state) => state.settingsDefaultThinking);
    const settingsDefaultThinkingByModel = useConfigStore((state) => state.settingsDefaultThinkingByModel);
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const setAgent = useConfigStore((state) => state.setAgent);
    const setProvider = useConfigStore((state) => state.setProvider);
    const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
    const setModel = useConfigStore((state) => state.setModel);
    const setCurrentVariant = useConfigStore((state) => state.setCurrentVariant);
    const getCurrentModelVariants = useConfigStore((state) => state.getCurrentModelVariants);
    const getCurrentProvider = useConfigStore((state) => state.getCurrentProvider);
    const getModelMetadata = useConfigStore((state) => state.getModelMetadata);

    const tracedReadyRef = React.useRef(false);

    React.useEffect(() => {
        if (tracedReadyRef.current || !isReady) return;
        tracedReadyRef.current = true;
        markStartupTrace('ModelControls:ready', {
            providers: providers.length,
            currentProviderId,
            currentModelId,
        });
    }, [currentModelId, currentProviderId, isReady, providers.length]);

    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const getDirectoryForSession = useSessionUIStore((s) => s.getDirectoryForSession);
    const sync = useSync();

    const getSessionModelSelection = useSelectionStore((state) => state.getSessionModelSelection);
    const saveSessionModelSelection = useSelectionStore((state) => state.saveSessionModelSelection);

    const contextHydrated = useContextStore((state) => state.hasHydrated);

    const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
    const reorderFavoriteModel = useUIStore((state) => state.reorderFavoriteModel);
    const providerOrder = useUIStore((state) => state.providerOrder);
    const setProviderOrder = useUIStore((state) => state.setProviderOrder);
    const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
    const addRecentModel = useUIStore((state) => state.addRecentModel);
    const addRecentEffort = useUIStore((state) => state.addRecentEffort);
    const isModelSelectorOpen = useUIStore((state) => state.isModelSelectorOpen);
    const setModelSelectorOpen = useUIStore((state) => state.setModelSelectorOpen);
    const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
    const setSettingsPage = useUIStore((state) => state.setSettingsPage);
    const hiddenModels = useUIStore((state) => state.hiddenModels);

    const { favoriteModelsList, recentModelsList } = useModelLists();

    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const { enabled: isTabletLayout } = useTabletLayout();
    const uiIsMobile = useUIStore((state) => state.isMobile);
    const isMobile = (deviceIsMobile || uiIsMobile) && !isTabletLayout;
    const isDesktop = React.useMemo(() => isDesktopShell(), []);
    const isCompact = isMobile;
    const [localMobilePanel, setLocalMobilePanel] = React.useState<MobileControlsPanel>(null);
    const usingExternalMobilePanel = mobilePanel !== undefined && typeof onMobilePanelChange === 'function';
    const activeMobilePanel = usingExternalMobilePanel ? mobilePanel : localMobilePanel;
    const setActiveMobilePanel = usingExternalMobilePanel ? onMobilePanelChange : setLocalMobilePanel;
    const [mobileTooltipOpen, setMobileTooltipOpen] = React.useState<'model' | 'agent' | null>(null);
    const [mobileModelQuery, setMobileModelQuery] = React.useState('');
    const [expandedMobileModelKey, setExpandedMobileModelKey] = React.useState<string | null>(null);
    const manualVariantSelectionRef = React.useRef(false);
    const closeMobilePanel = React.useCallback(() => setActiveMobilePanel(null), [setActiveMobilePanel]);
    const closeMobileTooltip = React.useCallback(() => setMobileTooltipOpen(null), []);
    const longPressTimerRef = React.useRef<NodeJS.Timeout | undefined>(undefined);
    const [expandedMobileProviders, setExpandedMobileProviders] = React.useState<Set<string>>(() => {
        const initial = new Set<string>();
        if (currentProviderId) {
            initial.add(currentProviderId);
        }
        return initial;
    });
    const openAddProviderSettings = React.useCallback(() => {
        setSelectedProvider(ADD_PROVIDER_ID);
        setSettingsPage('providers');
        setSettingsDialogOpen(true);
        setModelSelectorOpen(false);
        closeMobilePanel();
    }, [setSelectedProvider, setSettingsPage, setSettingsDialogOpen, setModelSelectorOpen, closeMobilePanel]);
    const [desktopModelQuery, setDesktopModelQuery] = React.useState('');
    const keyboardOwnsModelSelectionRef = React.useRef(false);
    const lastModelPointerPositionRef = React.useRef<{ x: number; y: number } | null>(null);
    const activeModelPickerEntryRef = React.useRef<ModelPickerEntry | undefined>(undefined);
    const [pendingThinkingVariants, setPendingThinkingVariants] = React.useState<Map<string, string | undefined>>(new Map());
    const [adjustedThinkingModels, setAdjustedThinkingModels] = React.useState<Set<string>>(new Set());
    const [modelPickerRenderVersion, setModelPickerRenderVersion] = React.useState(0);

    React.useEffect(() => {
        if (activeMobilePanel === 'model') {
            setExpandedMobileProviders(() => {
                const initial = new Set<string>();
                if (currentProviderId) {
                    initial.add(currentProviderId);
                }
                return initial;
            });
        }
    }, [activeMobilePanel, currentProviderId]);

    React.useEffect(() => {
        if (activeMobilePanel === null) {
            setExpandedMobileModelKey(null);
        }
    }, [activeMobilePanel]);

    React.useEffect(() => {
        if (activeMobilePanel !== 'model') {
            setMobileModelQuery('');
            setExpandedMobileModelKey(null);
            // Mirror desktop cleanup: pending thinking selections are per-picker-session.
            // Clearing here prevents a stale pending variant from leaking into the next
            // mobile model pick after a cancelled drag or a variant-panel switch.
            setPendingThinkingVariants(new Map());
            setAdjustedThinkingModels(new Set());
        }
    }, [activeMobilePanel]);

    // Handle model selector close behavior (separate from agent selector)
    const prevModelSelectorOpenRef = React.useRef(isModelSelectorOpen);
    React.useEffect(() => {
        const wasOpen = prevModelSelectorOpenRef.current;
        prevModelSelectorOpenRef.current = isModelSelectorOpen;

        if (!isModelSelectorOpen) {
            setDesktopModelQuery('');
            keyboardOwnsModelSelectionRef.current = false;
            lastModelPointerPositionRef.current = null;
            setPendingThinkingVariants(new Map());
            setAdjustedThinkingModels(new Set());

            // Restore focus to chat input when model selector closes
            if (wasOpen && !isCompact) {
                requestAnimationFrame(focusChatInput);
            }
        }
    }, [isModelSelectorOpen, isCompact]);



    const sizeVariant: 'mobile' | 'default' = isMobile ? 'mobile' : 'default';
    const buttonHeight = sizeVariant === 'mobile' ? 'h-9' : 'h-7';
    const controlIconSize = 'size-3.5';
    const controlTextSize = 'typography-micro';
    const inlineGapClass = sizeVariant === 'mobile' ? 'gap-x-1' : 'gap-x-3';

    const currentProvider = getCurrentProvider();
    const models = Array.isArray(currentProvider?.models) ? currentProvider.models : [];

    const visibleProviders = React.useMemo(() => {
        const result: typeof providers = [];
        for (const provider of providers) {
            const providerModels = Array.isArray(provider.models) ? provider.models : [];
            const visibleModels = providerModels.filter((model: ProviderModel) => {
                const modelId = typeof model?.id === 'string' ? model.id : '';
                return !hiddenModels.some(
                    (item) => item.providerID === String(provider.id) && item.modelID === modelId
                );
            });
            if (visibleModels.length > 0) {
                result.push({ ...provider, models: visibleModels });
            }
        }
        return result;
    }, [providers, hiddenModels]);

    const normalizeModelSearchValue = React.useCallback((value: string) => {
        const lower = value.toLowerCase().trim();
        const compact = lower.replace(/[^a-z0-9]/g, '');
        const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
        return { lower, compact, tokens };
    }, []);

    const matchesModelSearch = React.useCallback((candidate: string, query: string) => {
        const normalizedQuery = normalizeModelSearchValue(query);
        if (!normalizedQuery.lower) {
            return true;
        }

        const normalizedCandidate = normalizeModelSearchValue(candidate);
        if (normalizedCandidate.lower.includes(normalizedQuery.lower)) {
            return true;
        }

        if (normalizedQuery.compact.length >= 2 && normalizedCandidate.compact.includes(normalizedQuery.compact)) {
            return true;
        }

        if (normalizedQuery.tokens.length === 0) {
            return false;
        }

        return normalizedQuery.tokens.every((queryToken) =>
            normalizedCandidate.tokens.some((candidateToken) =>
                candidateToken.startsWith(queryToken) || candidateToken.includes(queryToken)
            )
        );
    }, [normalizeModelSearchValue]);

    const currentModelForMetadata = currentModelId
        ? models.find((model: ProviderModel) => model.id === currentModelId)
        : undefined;
    const currentMetadata = currentProviderId && currentModelId && currentModelForMetadata
        ? mergeModelMetadataWithLiveModel(currentProviderId, currentModelForMetadata, getModelMetadata(currentProviderId, currentModelId))
        : currentProviderId && currentModelId
            ? getModelMetadata(currentProviderId, currentModelId)
            : undefined;
    const localizeMetaLabel = React.useCallback((label: string) => {
        if (label === 'Tool calling') return "Tool calling";
        if (label === 'Reasoning') return "Reasoning";
        if (label === 'Text') return "Text";
        if (label === 'Image') return "Image";
        if (label === 'Video') return "Video";
        if (label === 'Audio') return "Audio";
        if (label === 'PDF') return "PDF";
        return label;
    }, []);

    const currentCapabilityIcons = React.useMemo(
        () => getCapabilityIcons(currentMetadata).map((icon) => ({ ...icon, label: localizeMetaLabel(icon.label) })),
        [currentMetadata, localizeMetaLabel],
    );
    const inputModalityIcons = React.useMemo(
        () => getModalityIcons(currentMetadata, 'input').map((icon) => ({ ...icon, label: localizeMetaLabel(icon.label) })),
        [currentMetadata, localizeMetaLabel],
    );
    const outputModalityIcons = React.useMemo(
        () => getModalityIcons(currentMetadata, 'output').map((icon) => ({ ...icon, label: localizeMetaLabel(icon.label) })),
        [currentMetadata, localizeMetaLabel],
    );

    // Compute from current model each render to avoid stale variants
    // in draft/session transitions.
    const availableVariants = getCurrentModelVariants().filter(isPiThinkingLevel);
    const hasVariants = availableVariants.length > 0;

    const costRows = [
        { label: 'Input', value: formatCost(currentMetadata?.cost?.input) },
        { label: 'Output', value: formatCost(currentMetadata?.cost?.output) },
        { label: 'Cache read', value: formatCost(currentMetadata?.cost?.cache_read) },
        { label: 'Cache write', value: formatCost(currentMetadata?.cost?.cache_write) },
    ];

    const limitRows = [
        { label: 'Context', value: formatTokens(currentMetadata?.limit?.context) },
        { label: 'Output', value: formatTokens(currentMetadata?.limit?.output) },
    ];

    const existingSessionRestoreRef = React.useRef<string | null>(null);
    // Last authoritative model/thinking this component observed or applied.
    // Lets the sync effect below distinguish a genuinely new external change
    // (extension slash command, TUI, another tab) from the echo of our own
    // apply. `thinking: undefined` means "authoritative has no thinking".
    const lastObservedSessionModelRef = React.useRef<{
        providerId?: string;
        modelId?: string;
        thinking?: PiThinkingLevel;
    } | null>(null);

    const currentSessionDirectory = currentSessionId ? getDirectoryForSession(currentSessionId) : undefined;
    const hasRenderableCurrentSessionSnapshot = useSessionRenderable(
        currentSessionId ?? '',
        currentSessionDirectory ?? undefined,
    );
    const existingSessionSelection = usePiSessionSnapshot(
        (state) => {
            if (!currentSessionId) return null;
            const session = state.reducer.bySession.get(currentSessionId);
            if (!session) return null;
            return { model: session.model, thinking: session.thinking };
        },
        (previous, next) => {
            if (previous === next) return true;
            if (!previous || !next) return false;
            return previous.model?.providerId === next.model?.providerId
                && previous.model?.modelId === next.model?.modelId
                && previous.thinking === next.thinking;
        },
        currentSessionId ? `session:${currentSessionId}` : '*',
    );
    const currentSessionMessagesFromSync = useSessionMessages(currentSessionId ?? '', currentSessionDirectory ?? undefined);
    // Skip synthetic subagent-completion nudges — restoring from them resets a
    // manual model override back to the agent default (issue #2404).
    const latestLoadedUserChoice = React.useMemo(() => {
        return findLatestUserModelChoice(
            currentSessionMessagesFromSync,
            (messageId) => getSyncParts(messageId, currentSessionDirectory ?? undefined),
        );
    }, [currentSessionDirectory, currentSessionMessagesFromSync]);

    const tryApplyModelSelection = React.useCallback(
        (providerId: string, modelId: string): ModelApplyResult => {
            if (!providerId || !modelId) {
                return 'model-missing';
            }

            const provider = providers.find(p => p.id === providerId);
            if (!provider) {
                return 'provider-missing';
            }

            const providerModels = Array.isArray(provider.models) ? provider.models : [];
            const modelExists = providerModels.find((m: ProviderModel) => m.id === modelId);
            if (!modelExists) {
                return 'model-missing';
            }

            const providerMatches = currentProviderId === providerId;
            const modelMatches = currentModelId === modelId;
            if (providerMatches && modelMatches) {
                return 'applied';
            }

            setProvider(providerId);
            setModel(modelId);

            const nextThinking = resolveComposerThinkingForModel({
                providerId,
                modelId,
                thinkingLevels: modelExists.thinkingLevels,
                reasoning: modelExists.reasoning,
                supportsThinking: modelExists.supportsThinking,
                defaultThinkingByModel: settingsDefaultThinkingByModel,
                defaultThinking: settingsDefaultThinking,
                previousThinking: currentVariant,
            });
            setCurrentVariant(nextThinking);

            if (currentSessionId) {
                saveSessionModelSelection(currentSessionId, providerId, modelId);
            }

            return 'applied';
        },
        [providers, currentProviderId, currentModelId, currentVariant, setProvider, setModel, setCurrentVariant, currentSessionId, saveSessionModelSelection, settingsDefaultThinking, settingsDefaultThinkingByModel],
    );

    const getModelVariantOptions = React.useCallback((providerId: string, modelId: string) => {
        const provider = providers.find((entry) => entry.id === providerId);
        const model = (Array.isArray(provider?.models) ? provider.models : []).find((entry) => entry.id === modelId);
        return configurableThinkingLevels(model);
    }, [providers]);

    const applyLockedSessionComposerSelection = React.useCallback(
        (providerId: string, modelId: string, thinking: PiThinkingLevel | undefined): ModelApplyResult => {
            if (!providerId || !modelId) {
                return 'model-missing';
            }

            const provider = providers.find((entry) => entry.id === providerId);
            if (!provider) {
                return 'provider-missing';
            }

            const providerModels = Array.isArray(provider.models) ? provider.models : [];
            if (!providerModels.some((model: ProviderModel) => model.id === modelId)) {
                return 'model-missing';
            }

            if (currentProviderId !== providerId) {
                setProvider(providerId);
            }
            if (currentProviderId !== providerId || currentModelId !== modelId) {
                setModel(modelId);
            }
            if (currentSessionId) {
                saveSessionModelSelection(currentSessionId, providerId, modelId);
            }

            const levels = getModelVariantOptions(providerId, modelId);
            setCurrentVariant(thinking && levels.includes(thinking) ? thinking : undefined);
            lastObservedSessionModelRef.current = {
                ...(providerId ? { providerId } : {}),
                ...(modelId ? { modelId } : {}),
                ...(thinking ? { thinking } : {}),
            };
            return 'applied';
        },
        [
            currentModelId,
            currentProviderId,
            currentSessionId,
            getModelVariantOptions,
            providers,
            saveSessionModelSelection,
            setCurrentVariant,
            setModel,
            setProvider,
        ],
    );

    const resolveModelVariantSelection = React.useCallback((providerId: string, modelId: string) => {
        const variantOptions = getModelVariantOptions(providerId, modelId);
        if (variantOptions.length === 0) {
            return undefined;
        }

        if (currentProviderId === providerId && currentModelId === modelId && isPiThinkingLevel(currentVariant) && variantOptions.includes(currentVariant)) {
            return currentVariant;
        }

        if (!currentSessionId) {
            const provider = providers.find((entry) => entry.id === providerId);
            const model = (Array.isArray(provider?.models) ? provider.models : []).find((entry) => entry.id === modelId);
            return resolveComposerThinkingForModel({
                providerId,
                modelId,
                thinkingLevels: model?.thinkingLevels,
                reasoning: model?.reasoning,
                supportsThinking: model?.supportsThinking,
                defaultThinkingByModel: settingsDefaultThinkingByModel,
                defaultThinking: settingsDefaultThinking,
            });
        }

        return undefined;
    }, [
        currentModelId,
        currentProviderId,
        currentSessionId,
        currentVariant,
        getModelVariantOptions,
        providers,
        settingsDefaultThinking,
        settingsDefaultThinkingByModel,
    ]);

    const commitVariantSelectionForModel = React.useCallback((providerId: string, modelId: string, variant: string | undefined) => {
        const variantOptions = getModelVariantOptions(providerId, modelId);
        if (variantOptions.length === 0) {
            manualVariantSelectionRef.current = false;
            applyComposerThinking(undefined);
            return;
        }

        const next = isPiThinkingLevel(variant) && variantOptions.includes(variant)
            ? variant
            : undefined;
        manualVariantSelectionRef.current = true;
        applyComposerThinking(next);
        addRecentEffort(providerId, modelId, variant);
    }, [
        addRecentEffort,
        getModelVariantOptions,
    ]);

    const applyModelSelectionWithVariant = React.useCallback((providerId: string, modelId: string, variant: string | undefined) => {
        const result = tryApplyModelSelection(providerId, modelId);
        if (result !== 'applied') {
            return result;
        }

        addRecentModel(providerId, modelId);
        commitVariantSelectionForModel(providerId, modelId, variant);
        return 'applied';
    }, [addRecentModel, commitVariantSelectionForModel, tryApplyModelSelection]);

    React.useEffect(() => {
        if (!currentSessionId) {
            existingSessionRestoreRef.current = null;
            return;
        }

        if (!contextHydrated || providers.length === 0) {
            return;
        }

        if (!hasRenderableCurrentSessionSnapshot) {
            void sync.ensureSessionRenderable(currentSessionId);
            return;
        }

        if (existingSessionRestoreRef.current === currentSessionId) {
            return;
        }

        const lockThinking = (thinking: PiThinkingLevel | undefined) => {
            if (thinking && currentProviderId && currentModelId) {
                const levels = getModelVariantOptions(currentProviderId, currentModelId);
                setCurrentVariant(levels.includes(thinking) ? thinking : undefined);
                return;
            }
            setCurrentVariant(undefined);
        };

        const sessionModel = existingSessionSelection?.model;
        if (sessionModel) {
            const result = applyLockedSessionComposerSelection(
                sessionModel.providerId,
                sessionModel.modelId,
                existingSessionSelection?.thinking,
            );
            if (result === 'provider-missing') {
                return;
            }
            existingSessionRestoreRef.current = currentSessionId;
            return;
        }

        if (existingSessionSelection?.thinking) {
            lockThinking(existingSessionSelection.thinking);
            existingSessionRestoreRef.current = currentSessionId;
            return;
        }

        if (latestLoadedUserChoice?.providerID && latestLoadedUserChoice.modelID) {
            if (latestLoadedUserChoice.agent && currentAgentName !== latestLoadedUserChoice.agent) {
                setAgent(latestLoadedUserChoice.agent);
            }
            const historicalVariant = latestLoadedUserChoice.variant
                && isPiThinkingLevel(latestLoadedUserChoice.variant)
                && getModelVariantOptions(latestLoadedUserChoice.providerID, latestLoadedUserChoice.modelID).includes(latestLoadedUserChoice.variant)
                ? latestLoadedUserChoice.variant
                : undefined;
            const result = applyLockedSessionComposerSelection(
                latestLoadedUserChoice.providerID,
                latestLoadedUserChoice.modelID,
                historicalVariant,
            );
            if (result === 'provider-missing') {
                return;
            }
            existingSessionRestoreRef.current = currentSessionId;
            return;
        }

        const savedSessionModel = getSessionModelSelection(currentSessionId);
        if (savedSessionModel) {
            const result = applyLockedSessionComposerSelection(
                savedSessionModel.providerId,
                savedSessionModel.modelId,
                existingSessionSelection?.thinking,
            );
            if (result === 'provider-missing') {
                return;
            }
        }

        existingSessionRestoreRef.current = currentSessionId;
    }, [
        applyLockedSessionComposerSelection,
        contextHydrated,
        currentAgentName,
        currentModelId,
        currentProviderId,
        currentSessionId,
        existingSessionSelection,
        getModelVariantOptions,
        getSessionModelSelection,
        hasRenderableCurrentSessionSnapshot,
        latestLoadedUserChoice,
        providers.length,
        setAgent,
        setCurrentVariant,
        sync,
    ]);

    // Adopt authoritative model/thinking changes made OUTSIDE this composer —
    // extension slash commands (/balance, /juicer), the pi TUI, or another
    // tab. The one-shot restore above intentionally runs once per session, so
    // without this the composer keeps its stale selection and routeMessage
    // force-resets the daemon back to it on the next send, silently reverting
    // the external switch. Pending composer picks do not change the committed
    // session, so lastObservedSessionModelRef still matches and those edits
    // are ignored. A changed authoritative value that the composer does not
    // already reflect is adopted verbatim.
    React.useEffect(() => {
        if (!currentSessionId || !contextHydrated || providers.length === 0) {
            return;
        }
        if (!hasRenderableCurrentSessionSnapshot) {
            return;
        }
        if (existingSessionRestoreRef.current !== currentSessionId) {
            // Initial restore owns the first application for this session.
            return;
        }
        const authModel = existingSessionSelection?.model;
        const authThinking = existingSessionSelection?.thinking ?? undefined;
        if (!authModel?.providerId || !authModel?.modelId) {
            lastObservedSessionModelRef.current = null;
            return;
        }
        const action = classifyAuthoritativeComposerSelection({
            authoritative: {
                providerId: authModel.providerId,
                modelId: authModel.modelId,
                thinking: authThinking,
            },
            observed: lastObservedSessionModelRef.current,
            composer: {
                providerId: currentProviderId,
                modelId: currentModelId,
                thinking: parsePiThinkingLevel(currentVariant) ?? undefined,
            },
        });
        if (action === 'ignore') {
            return;
        }
        if (action === 'apply') {
            applyLockedSessionComposerSelection(authModel.providerId, authModel.modelId, authThinking);
            return;
        }
        lastObservedSessionModelRef.current = {
            providerId: authModel.providerId,
            modelId: authModel.modelId,
            ...(authThinking ? { thinking: authThinking } : {}),
        };
    }, [
        applyLockedSessionComposerSelection,
        contextHydrated,
        currentModelId,
        currentProviderId,
        currentSessionId,
        currentVariant,
        existingSessionSelection,
        hasRenderableCurrentSessionSnapshot,
        providers.length,
    ]);

    React.useEffect(() => {
        if (!contextHydrated) {
            manualVariantSelectionRef.current = false;
            setCurrentVariant(undefined);
            return;
        }

        if (!currentProviderId || !currentModelId) {
            manualVariantSelectionRef.current = false;
            setCurrentVariant(undefined);
            return;
        }

        const provider = providers.find((entry) => entry.id === currentProviderId);
        const model = (Array.isArray(provider?.models) ? provider.models : []).find((entry) => entry.id === currentModelId);
        const levels = catalogThinkingLevels(model);
        if (!modelHasConfigurableThinking(levels)) {
            if (currentVariant && isPiThinkingLevel(currentVariant)) {
                setCurrentVariant(undefined);
            }
            return;
        }

        if (!currentSessionId && !currentVariant && !manualVariantSelectionRef.current) {
            const desired = resolveComposerThinkingForModel({
                providerId: currentProviderId,
                modelId: currentModelId,
                thinkingLevels: model?.thinkingLevels,
                reasoning: model?.reasoning,
                supportsThinking: model?.supportsThinking,
                defaultThinkingByModel: settingsDefaultThinkingByModel,
                defaultThinking: settingsDefaultThinking,
            });
            if (desired) setCurrentVariant(desired);
            return;
        }

        if (currentVariant && isPiThinkingLevel(currentVariant) && !levels.includes(currentVariant)) {
            setCurrentVariant(resolveComposerThinkingForModel({
                providerId: currentProviderId,
                modelId: currentModelId,
                thinkingLevels: model?.thinkingLevels,
                reasoning: model?.reasoning,
                supportsThinking: model?.supportsThinking,
                defaultThinkingByModel: settingsDefaultThinkingByModel,
                defaultThinking: settingsDefaultThinking,
                previousThinking: currentVariant,
            }));
            return;
        }

        if (currentSessionId && !currentVariant && !manualVariantSelectionRef.current) {
            const sessionThinking = parsePiThinkingLevel(existingSessionSelection?.thinking);
            if (sessionThinking && levels.includes(sessionThinking)) {
                setCurrentVariant(sessionThinking);
            }
        }
    }, [
        contextHydrated,
        currentSessionId,
        currentProviderId,
        currentModelId,
        currentVariant,
        existingSessionSelection,
        providers,
        setCurrentVariant,
        settingsDefaultThinking,
        settingsDefaultThinkingByModel,
    ]);

    React.useEffect(() => {
        manualVariantSelectionRef.current = false;
    }, [currentProviderId, currentModelId]);

    const handleVariantSelect = React.useCallback((variant: PiThinkingLevel | undefined) => {
        if (currentProviderId && currentModelId) {
            commitVariantSelectionForModel(currentProviderId, currentModelId, variant);
        }
    }, [commitVariantSelectionForModel, currentModelId, currentProviderId]);

    const handleVariantLiveChange = React.useCallback((variant: PiThinkingLevel | undefined) => {
        if (!currentProviderId || !currentModelId) return;
        const variantOptions = getModelVariantOptions(currentProviderId, currentModelId);
        if (variantOptions.length === 0) {
            manualVariantSelectionRef.current = false;
            applyComposerThinking(undefined);
            return;
        }
        const next = isPiThinkingLevel(variant) && variantOptions.includes(variant) ? variant : undefined;
        manualVariantSelectionRef.current = true;
        applyComposerThinking(next);
    }, [currentProviderId, currentModelId, getModelVariantOptions]);

    const handleVariantCommit = React.useCallback((variant: PiThinkingLevel | undefined) => {
        if (variant !== currentVariant) {
            handleVariantLiveChange(variant);
        }
        if (currentProviderId && currentModelId) {
            addRecentEffort(currentProviderId, currentModelId, variant);
        }
    }, [handleVariantLiveChange, currentProviderId, currentModelId, currentVariant, addRecentEffort]);

    const handleProviderAndModelChange = (
        providerId: string,
        modelId: string,
        options?: { applyVariant?: boolean; variant?: string | undefined },
    ) => {
        try {
            const result = options?.applyVariant
                ? applyModelSelectionWithVariant(providerId, modelId, options.variant)
                : tryApplyModelSelection(providerId, modelId);
            if (result !== 'applied') {
                if (result === 'provider-missing') {
                    console.error('[ModelControls] Provider not available for selection:', providerId);
                } else if (result === 'model-missing') {
                    console.error('[ModelControls] Model not available for selection:', { providerId, modelId });
                }
                return;
            }
            if (!options?.applyVariant) {
                // Add to recent models on successful selection.
                addRecentModel(providerId, modelId);
            }
            setModelSelectorOpen(false);
            if (isCompact) {
                closeMobilePanel();
            }
            // Restore focus to chat input after model selection.
            requestAnimationFrame(focusChatInput);
        } catch (error) {
            console.error('[ModelControls] Handle model change error:', error);
        }
    };

    const getModelDisplayName = (model: ProviderModel | undefined, fallbackModelId?: string) => {
        return getSharedModelDisplayName(model, fallbackModelId, { maxLength: 40 });
    };

    const getProviderDisplayName = (): string => {
        const provider = providers.find(p => p.id === currentProviderId);
        return (provider?.name || currentProviderId || '') as string;
    };

    const getCurrentModelDisplayName = () => {
        if (!currentModelId) return "Select model";
        const currentModel = models.find((m: ProviderModel) => m.id === currentModelId);
        return getModelDisplayName(currentModel, currentModelId) || "Select model";
    };

    const truncateForMobile = React.useCallback((value: string, limit: number) => {
        if (!isMobile) return value;
        if (value.length <= limit) return value;
        return `${value.slice(0, limit)}...`;
    }, [isMobile]);

    const currentModelDisplayName = truncateForMobile(getCurrentModelDisplayName(), 16);
    const modelLabelRef = React.useRef<HTMLSpanElement>(null);
    const isModelLabelTruncated = useIsTextTruncated(modelLabelRef, [currentModelDisplayName, isCompact]);

    const toggleMobileProviderExpansion = React.useCallback((providerId: string) => {
        setExpandedMobileProviders((prev) => {
            const next = new Set(prev);
            if (next.has(providerId)) {
                next.delete(providerId);
            } else {
                next.add(providerId);
            }
            return next;
        });
    }, []);

    const handleLongPressStart = React.useCallback((type: 'model') => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
        }
        longPressTimerRef.current = setTimeout(() => {
            setMobileTooltipOpen(type);
        }, 500);
    }, []);

    const handleLongPressEnd = React.useCallback(() => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
        }
    }, []);

    React.useEffect(() => {
        return () => {
            if (longPressTimerRef.current) {
                clearTimeout(longPressTimerRef.current);
            }
        };
    }, []);

    const renderMobileModelTooltip = () => {
        if (!isCompact || mobileTooltipOpen !== 'model') return null;

        return (
            <MobileModelTooltipPanel
                open={true}
                onClose={closeMobileTooltip}
                title={currentMetadata?.name || getCurrentModelDisplayName()}
                providerDisplayName={getProviderDisplayName()}
                currentCapabilityIcons={currentCapabilityIcons}
                inputModalityIcons={inputModalityIcons}
                outputModalityIcons={outputModalityIcons}
                currentMetadata={currentMetadata}
            />
        );
    };

    const renderMobileModelPanel = () => {
        if (!isCompact) return null;

        const normalizedQuery = mobileModelQuery.trim();
        const filteredFavorites = favoriteModelsList.filter(({ model, providerID }) => {
            const provider = providers.find((entry) => entry.id === providerID);
            const providerName = provider?.name || providerID;
            const modelName = getModelDisplayName(model);
            return normalizedQuery.length === 0
                || matchesModelSearch(String(modelName || ''), normalizedQuery)
                || matchesModelSearch(String(providerName || ''), normalizedQuery);
        });

        const filteredRecents = recentModelsList.filter(({ model, providerID }) => {
            const provider = providers.find((entry) => entry.id === providerID);
            const providerName = provider?.name || providerID;
            const modelName = getModelDisplayName(model);
            return normalizedQuery.length === 0
                || matchesModelSearch(String(modelName || ''), normalizedQuery)
                || matchesModelSearch(String(providerName || ''), normalizedQuery);
        });

        const filteredProviders: {
            provider: (typeof visibleProviders)[number];
            providerModels: ProviderModel[];
            matchesProvider: boolean;
        }[] = [];
        for (const provider of visibleProviders) {
            const providerModels = Array.isArray(provider.models) ? provider.models : [];
            const matchesProvider = normalizedQuery.length === 0
                ? true
                : matchesModelSearch(String(provider.name || ''), normalizedQuery) || matchesModelSearch(String(provider.id || ''), normalizedQuery);
            const matchingModels = normalizedQuery.length === 0
                ? providerModels
                : providerModels.filter((model: ProviderModel) => {
                    const name = getModelDisplayName(model);
                    const id = typeof model.id === 'string' ? model.id : '';
                    return matchesModelSearch(String(name || ''), normalizedQuery) || matchesModelSearch(String(id || ''), normalizedQuery);
                });
            const resolvedModels = matchesProvider && normalizedQuery.length > 0 ? providerModels : matchingModels;
            if (matchesProvider || resolvedModels.length > 0) {
                filteredProviders.push({ provider, providerModels: resolvedModels, matchesProvider });
            }
        }

        const handleMobileModelApply = (providerId: string, modelId: string, variant: string | undefined) => {
            const result = applyModelSelectionWithVariant(providerId, modelId, variant);
            if (result !== 'applied') {
                if (result === 'provider-missing') {
                    console.error('[ModelControls] Provider not available for selection:', providerId);
                } else if (result === 'model-missing') {
                    console.error('[ModelControls] Model not available for selection:', { providerId, modelId });
                }
                return;
            }

            setExpandedMobileModelKey(null);
            closeMobilePanel();
            requestAnimationFrame(focusChatInput);
        };

        return (
            <MobileModelPickerPanel
                open={activeMobilePanel === 'model'}
                onClose={closeMobilePanel}
                mobileModelQuery={mobileModelQuery}
                onMobileModelQueryChange={setMobileModelQuery}
                filteredFavorites={filteredFavorites}
                filteredRecents={filteredRecents}
                filteredProviders={filteredProviders}
                expandedMobileProviders={expandedMobileProviders}
                onToggleMobileProviderExpansion={toggleMobileProviderExpansion}
                expandedMobileModelKey={expandedMobileModelKey}
                onToggleExpandedMobileModelKey={setExpandedMobileModelKey}
                currentProviderId={currentProviderId}
                currentModelId={currentModelId}
                getModelDisplayName={getModelDisplayName}
                getModelMetadata={getModelMetadata}
                getModelVariantOptions={getModelVariantOptions}
                resolveModelVariantSelection={resolveModelVariantSelection}
                pendingThinkingVariants={pendingThinkingVariants}
                onUpdatePendingThinkingVariant={(rowKey, next) => {
                    setPendingThinkingVariants((prev) => {
                        const nextMap = new Map(prev);
                        nextMap.set(rowKey, next);
                        return nextMap;
                    });
                    setAdjustedThinkingModels((prev) => {
                        const nextSet = new Set(prev);
                        nextSet.add(rowKey);
                        return nextSet;
                    });
                    setModelPickerRenderVersion((v) => v + 1);
                }}
                isFavoriteModel={isFavoriteModel}
                onToggleFavoriteModel={toggleFavoriteModel}
                onApplyModel={handleMobileModelApply}
            />
        );
    };

    const renderMobileVariantPanel = () => {
        if (!isCompact) return null;
        if (!currentProviderId || !currentModelId) return null;

        const targetVariants = getModelVariantOptions(currentProviderId, currentModelId);

        return (
            <MobileVariantPanel
                open={activeMobilePanel === 'variant'}
                onClose={closeMobilePanel}
                targetVariants={targetVariants}
                selectedVariant={currentVariant}
                onVariantLiveChange={handleVariantLiveChange}
                onVariantCommit={handleVariantCommit}
            />
        );
    };

    const renderModelTooltipContent = () => (
        <ModelTooltipContent
            currentMetadata={currentMetadata}
            modelDisplayName={getCurrentModelDisplayName()}
            providerDisplayName={getProviderDisplayName()}
            currentCapabilityIcons={currentCapabilityIcons}
            inputModalityIcons={inputModalityIcons}
            outputModalityIcons={outputModalityIcons}
            costRows={costRows}
            limitRows={limitRows}
        />
    );

    const renderModelSelector = () => {
        const handleThinkingVariantKey = (e: React.KeyboardEvent, selectedItem: ModelPickerEntry) => {
            keyboardOwnsModelSelectionRef.current = true;
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;

            const { providerID, modelID } = selectedItem;
            const variantKeys = getModelVariantOptions(providerID, modelID);
            if (variantKeys.length === 0) return false;

            e.preventDefault();
            e.stopPropagation();

            const mapKey = buildModelRefKey(providerID, modelID);
            const hasPendingVariant = pendingThinkingVariants.has(mapKey);
            const currentPending = pendingThinkingVariants.get(mapKey);
            const activeModelVariant = hasPendingVariant ? currentPending : (currentProviderId === providerID && currentModelId === modelID ? currentVariant : undefined);
            const nextVariant = cycleThinkingLevel(
                variantKeys,
                isPiThinkingLevel(activeModelVariant) ? activeModelVariant : undefined,
                e.key === 'ArrowRight' ? 1 : -1,
            );

            setPendingThinkingVariants((prev) => {
                const next = new Map(prev);
                next.set(mapKey, nextVariant);
                return next;
            });
            setAdjustedThinkingModels((prev) => {
                const next = new Set(prev);
                next.add(mapKey);
                return next;
            });
            setModelPickerRenderVersion((version) => version + 1);
            return true;
        };

        const handleModelPickerKeyDown = (e: React.KeyboardEvent, selectedItem: ModelPickerEntry | undefined) => {
            if (selectedItem) handleThinkingVariantKey(e, selectedItem);
        };

        const handleSharedModelSelect = (entry: ModelPickerEntry) => {
            const mapKey = buildModelRefKey(entry.providerID, entry.modelID);
            const pendingVariant = pendingThinkingVariants.get(mapKey);
            const wasAdjusted = adjustedThinkingModels.has(mapKey);

            handleProviderAndModelChange(entry.providerID, entry.modelID, wasAdjusted
                ? { applyVariant: true, variant: pendingVariant }
                : undefined);
        };

        const handleModelShortcutKeyDownCapture = (_e: React.KeyboardEvent) => {
            void _e;
        };

        const handleModelMenuOpenChange = (nextOpen: boolean) => {
            setModelSelectorOpen(nextOpen);
        };

        const modelPickerLabels = {
            searchPlaceholder: "Search models",
            noResults: "No models found",
            favorites: "Favorites",
            recent: "Recent",
            keyboardHint: "↑↓ navigate",
            favorite: "Favorite",
            unfavorite: "Unfavorite",
            capabilities: "Capabilities",
            capabilityToolCalling: "Tool calling",
            capabilityReasoning: "Reasoning",
            input: "Input",
            output: "Output",
            costPerMillion: "Cost ($/1M tokens)",
        };

        const renderThinkingSlot = (entry: ModelPickerEntry, { isHighlighted, isSelected }: { isHighlighted: boolean; isSelected: boolean }) => {
            const hasThinkingVariants = getModelVariantOptions(entry.providerID, entry.modelID).length > 0;
            const mapKey = buildModelRefKey(entry.providerID, entry.modelID);
            const wasAdjusted = adjustedThinkingModels.has(mapKey);
            if (!hasThinkingVariants || (!isHighlighted && !isSelected)) return null;

            const hasPendingVariant = pendingThinkingVariants.has(mapKey);
            const pendingVariant = pendingThinkingVariants.get(mapKey);
            const effectiveVariant = hasPendingVariant ? pendingVariant : (isSelected ? currentVariant : undefined);
            const displayLabel = thinkingLevelLabel(
                isPiThinkingLevel(effectiveVariant) ? effectiveVariant : undefined,
            );

            return (
                <span className={cn('typography-micro whitespace-nowrap', wasAdjusted ? 'text-foreground' : 'text-muted-foreground')}>
                    Thinking: {displayLabel}
                </span>
            );
        };

        return (
            <Tooltip delayDuration={600}>
                {!isCompact ? (
                    <DropdownMenu open={isReady && isModelSelectorOpen} onOpenChange={isReady ? handleModelMenuOpenChange : undefined}>
                        <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                                <button
                                    type="button"
                                    className={cn(
                                        'model-controls__model-trigger flex items-center gap-1.5 cursor-pointer hover:bg-transparent hover:opacity-70 min-w-0',
                                        buttonHeight
                                    )}
                                >
                                    {!isReady ? (
                                        <>
                                            <Icon name="loader-4" className={cn(controlIconSize, 'animate-spin text-muted-foreground flex-shrink-0')} />
                                            <span className={cn(
                                                'model-controls__model-label',
                                                controlTextSize,
                                                'font-normal whitespace-nowrap text-muted-foreground min-w-0'
                                            )}>
                                                {readinessLabel}
                                            </span>
                                        </>
                                    ) : currentProviderId ? (
                                        <>
                                            <ProviderLogo
                                                providerId={currentProviderId}
                                                className={cn(controlIconSize, 'flex-shrink-0')}
                                            />
                                            <Icon name="pencil-ai" className={cn(controlIconSize, 'text-primary/60 hidden')} />
                                        </>
                                    ) : (
                                        <Icon name="pencil-ai" className={cn(controlIconSize, 'text-muted-foreground')} />
                                    )}
                                    {isReady && (
                                        <span
                                            ref={modelLabelRef}
                                            key={`${currentProviderId}-${currentModelId}`}
                                            className={cn(
                                                'model-controls__model-label overflow-hidden',
                                                controlTextSize,
                                                'font-normal whitespace-nowrap text-foreground min-w-0',
                                                'max-w-[260px]'
                                            )}
                                        >
                                            <span className={cn('marquee-text', isModelLabelTruncated && 'marquee-text--active')}>
                                                {currentModelDisplayName}
                                            </span>
                                        </span>
                                    )}
                                    {isReady ? (
                                        <Icon name="arrow-down-s" className="size-3.5 shrink-0 text-muted-foreground" />
                                    ) : null}
                                </button>
                            </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <DropdownMenuContent
                            className="w-[min(380px,calc(100vw-2rem))] p-0 flex flex-col"
                            align="end"
                            alignOffset={-40}
                            onKeyDownCapture={handleModelShortcutKeyDownCapture}
                        >
                            <div className="p-1 border-b border-border/40">
                                <button
                                    type="button"
                                    onClick={openAddProviderSettings}
                                    className="typography-meta group flex w-full items-center gap-1 rounded-md px-2 py-1.5 cursor-pointer hover:bg-interactive-hover/50"
                                >
                                    <span className="flex size-4 items-center justify-center text-muted-foreground">
                                        <Icon name="add" className="size-4 -mr-0.5" />
                                    </span>
                                    <span className="font-medium text-foreground">{"Add new provider"}</span>
                                </button>
                            </div>
                            <ModelPickerList
                                providers={providers as ModelPickerProvider[]}
                                favoriteModels={favoriteModelsList}
                                recentModels={recentModelsList}
                                modelsMetadata={useConfigStore.getState().modelsMetadata}
                                searchQuery={desktopModelQuery}
                                onSearchQueryChange={setDesktopModelQuery}
                                onSelect={handleSharedModelSelect}
                                labels={modelPickerLabels}
                                selectedModel={currentProviderId && currentModelId ? { providerID: currentProviderId, modelID: currentModelId } : null}
                                hiddenModels={hiddenModels}
                                onActiveKeyDown={handleModelPickerKeyDown}
                                onActiveEntryChange={(entry) => { activeModelPickerEntryRef.current = entry; }}
                                onVariantKey={handleThinkingVariantKey}
                                isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
                                onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
                                renderRowEnd={renderThinkingSlot}
                                renderVersion={modelPickerRenderVersion}
                                onReorderFavorite={(active, over) => reorderFavoriteModel(
                                    active.providerID,
                                    active.modelID,
                                    over.providerID,
                                    over.modelID,
                                )}
                                reorderFavoriteAriaLabel={"Reorder favorite"}
                                reorderFavoriteTitle={"Drag to reorder favorite"}
                                providerOrder={providerOrder}
                                onReorderProvider={setProviderOrder}
                                reorderProviderTitle={"Drag to reorder provider"}
                                footerContent={(activeEntry) => {
                                    const activeHasThinkingVariants = activeEntry
                                        ? getModelVariantOptions(activeEntry.providerID, activeEntry.modelID).length > 0
                                        : false;

                                    return (
                                        <div className="flex items-center gap-x-2 whitespace-nowrap overflow-hidden">
                                            <span>{"↑↓ navigate"}</span>
                                            <span>{`${'Tab'} switch agent`}</span>
                                            {activeHasThinkingVariants ? <span>{"←→ thinking"}</span> : null}
                                        </div>
                                    );
                                }}
                                tooltipsEnabled={isModelSelectorOpen}
                                onEscape={() => setModelSelectorOpen(false)}
                            />
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : (
                    <button
                        type="button"
                        onClick={isReady ? () => setActiveMobilePanel('model') : undefined}
                        onTouchStart={isReady ? () => handleLongPressStart('model') : undefined}
                        onTouchEnd={isReady ? handleLongPressEnd : undefined}
                        onTouchCancel={isReady ? handleLongPressEnd : undefined}
                        disabled={!isReady}
                        className={cn(
                            'model-controls__model-trigger flex items-center gap-1.5 min-w-0 focus:outline-none',
                            isReady ? 'cursor-pointer hover:bg-transparent hover:opacity-70' : 'opacity-60 cursor-not-allowed',
                            buttonHeight
                        )}
                    >
                        {!isReady ? (
                            <>
                                <Icon name="loader-4" className={cn(controlIconSize, 'animate-spin text-muted-foreground flex-shrink-0')} />
                                <span className="typography-micro font-normal text-muted-foreground min-w-0">
                                    {readinessLabel}
                                </span>
                            </>
                        ) : (
                            <>
                                {currentProviderId ? (
                                    <ProviderLogo
                                        providerId={currentProviderId}
                                        className={cn(controlIconSize, 'flex-shrink-0')}
                                    />
                                ) : (
                                    <Icon name="pencil-ai" className={cn(controlIconSize, 'text-muted-foreground')} />
                                )}
                                <span
                                    ref={modelLabelRef}
                                    className={cn(
                                        'model-controls__model-label typography-micro font-normal overflow-hidden',
                                        keepLabels ? 'whitespace-nowrap' : 'min-w-0',
                                        !keepLabels && (isMobile ? 'max-w-[120px]' : 'max-w-[220px]'),
                                    )}
                                >
                                    <span className={cn('marquee-text', isModelLabelTruncated && 'marquee-text--active')}>
                                        {currentModelDisplayName}
                                    </span>
                                </span>
                                <Icon name="arrow-down-s" className="size-3.5 shrink-0 text-muted-foreground" />
                            </>
                        )}
                    </button>
                )}
                {renderModelTooltipContent()}
            </Tooltip>
        );
    };



    const renderVariantSelector = () => {
        if (!isReady || !hasVariants) {
            return null;
        }

        return (
            <ThinkingLevelControl
                levels={availableVariants}
                value={parsePiThinkingLevel(currentVariant) ?? undefined}
                onChange={handleVariantSelect}
                compact={isCompact}
                keepLabel={keepLabels}
                onCompactOpen={() => setActiveMobilePanel('variant')}
                buttonHeight={buttonHeight}
                iconSize={controlIconSize}
                textSize={controlTextSize}
                isMobile={isMobile}
                isDesktop={isDesktop}
            />
        );
    };



    const inlineClassName = cn(
        !keepLabels && '@container/model-controls',
        'flex items-center',
        keepLabels ? 'w-max shrink-0' : 'min-w-0',
        // Only force full-width + truncation behaviors on true mobile layouts.
        isMobile && !keepLabels && 'w-full',
        className,
    );

    return (
        <>
            <div className={inlineClassName}>
                <div
                    className={cn(
                        'flex items-center justify-start',
                        inlineGapClass,
                        keepLabels ? 'w-max shrink-0' : 'min-w-0',
                        isMobile && !keepLabels && 'overflow-hidden'
                    )}
                >
                    {renderModelSelector()}
                    {renderVariantSelector()}
                </div>
            </div>

            {renderMobileModelPanel()}
            {renderMobileVariantPanel()}
            {renderMobileModelTooltip()}
        </>
    );

};
