import React from 'react';
import { focusChatInput } from './composer/editor/dom';
import type { ModelMetadata } from '@/types';
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
import { toast } from '@/components/ui';
import { formatEffortLabel, type MobileControlsPanel } from './mobileControlsUtils';
import { ThinkingLevelControl, ThinkingLevelPicker } from './ThinkingLevelControl';
import { useOpenCodeReadiness } from '@/hooks/useOpenCodeReadiness';
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

type IconComponent = IconName;

type ProviderModel = Record<string, unknown> & { id?: string; name?: string };

const buildModelRefKey = (providerID: string, modelID: string) => `${providerID}:${modelID}`;

const notifyThinkingApplyFailed = () => {
    toast.error("Couldn't update thinking");
};


interface CapabilityDefinition {
    key: 'tool_call' | 'reasoning';
    icon: IconComponent;
    label: string;
    isActive: (metadata?: ModelMetadata) => boolean;
}

const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
    {
        key: 'tool_call',
        icon: "tools",
        label: 'Tool calling',
        isActive: (metadata) => metadata?.tool_call === true,
    },
    {
        key: 'reasoning',
        icon: "brain-ai-3",
        label: 'Reasoning',
        isActive: (metadata) => metadata?.reasoning === true,
    },
];

interface ModalityIconDefinition {
    icon: IconComponent;
    label: string;
}

type ModalityIcon = {
    key: string;
    icon: IconComponent;
    label: string;
};

type ModelApplyResult = 'applied' | 'provider-missing' | 'model-missing';

const MODALITY_ICON_MAP: Record<string, ModalityIconDefinition> = {
    text: { icon: "text", label: 'Text' },
    image: { icon: "file-image", label: 'Image' },
    video: { icon: "file-video", label: 'Video' },
    audio: { icon: "file-music", label: 'Audio' },
    pdf: { icon: "file-pdf", label: 'PDF' },
};

const normalizeModality = (value: string) => value.trim().toLowerCase();

const getModalityIcons = (metadata: ModelMetadata | undefined, direction: 'input' | 'output'): ModalityIcon[] => {
    const modalityList = direction === 'input' ? metadata?.modalities?.input : metadata?.modalities?.output;
    if (!Array.isArray(modalityList) || modalityList.length === 0) {
        return [];
    }

    const uniqueValues = Array.from(new Set(modalityList.map((item) => normalizeModality(item))));

    const result: ModalityIcon[] = [];
    for (const modality of uniqueValues) {
        const definition = MODALITY_ICON_MAP[modality];
        if (!definition) {
            continue;
        }
        result.push({
            key: modality,
            icon: definition.icon,
            label: definition.label,
        });
    }
    return result;
};

const formatCompactNumber = (value: number) => new Intl.NumberFormat('en-US', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
}).format(value);

const formatUsdCurrency = (value: number) => new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
    minimumFractionDigits: 2,
}).format(value);

const formatKnowledgeDate = (value: Date) => new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(value);

const formatReleaseDate = (value: Date) => new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
}).format(value);

const ADD_PROVIDER_ID = '__add_provider__';

const IconBadge: React.FC<{ iconName: IconComponent; label: string }> = ({ iconName, label }) => (
    <span
        className="flex size-5 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground"
        title={label}
        aria-label={label}
        role="img"
    >
        <Icon name={iconName} className="size-3.5" />
    </span>
);



const formatTokens = (value?: number | null) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return '—';
    }

    if (value === 0) {
        return '0';
    }

    const formatted = formatCompactNumber(value);
    return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

const formatCost = (value?: number | null) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '—';
    }

    return formatUsdCurrency(value);
};

const getCapabilityIcons = (metadata?: ModelMetadata) => {
    const result: { key: string; icon: IconComponent; label: string }[] = [];
    for (const definition of CAPABILITY_DEFINITIONS) {
        if (definition.isActive(metadata)) {
            result.push({ key: definition.key, icon: definition.icon, label: definition.label });
        }
    }
    return result;
};

const formatKnowledge = (knowledge?: string) => {
    if (!knowledge) {
        return '—';
    }

    const match = knowledge.match(/^(\d{4})-(\d{2})$/);
    if (match) {
        const year = Number.parseInt(match[1], 10);
        const monthIndex = Number.parseInt(match[2], 10) - 1;
        const knowledgeDate = new Date(Date.UTC(year, monthIndex, 1));
        if (!Number.isNaN(knowledgeDate.getTime())) {
            return formatKnowledgeDate(knowledgeDate);
        }
    }

    return knowledge;
};

const formatDate = (value?: string) => {
    if (!value) {
        return '—';
    }

    const parsedDate = new Date(value);
    if (Number.isNaN(parsedDate.getTime())) {
        return value;
    }

    return formatReleaseDate(parsedDate);
};

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
    const { isReady, isUnavailable } = useOpenCodeReadiness();
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
            void applyComposerThinking(undefined).catch(notifyThinkingApplyFailed);
            return;
        }

        const next = isPiThinkingLevel(variant) && variantOptions.includes(variant)
            ? variant
            : undefined;
        manualVariantSelectionRef.current = true;
        void applyComposerThinking(next).catch(notifyThinkingApplyFailed);
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
    // the external switch. Echoes of our own applies are recognized via
    // lastObservedSessionModelRef and ignored; a changed authoritative value
    // that the composer does not already reflect is adopted verbatim.
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
            void applyComposerThinking(undefined).catch(notifyThinkingApplyFailed);
            return;
        }
        const next = isPiThinkingLevel(variant) && variantOptions.includes(variant) ? variant : undefined;
        manualVariantSelectionRef.current = true;
        void applyComposerThinking(next).catch(notifyThinkingApplyFailed);
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
            <MobileOverlayPanel
                open={true}
                onClose={closeMobileTooltip}
                title={currentMetadata?.name || getCurrentModelDisplayName()}
            >
                <div className="flex flex-col gap-1.5">
                    {}
                    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="typography-micro text-muted-foreground mb-0.5">{"Provider"}</div>
                        <div className="typography-meta text-foreground font-medium">{getProviderDisplayName()}</div>
                    </div>

                    {}
                    {currentCapabilityIcons.length > 0 && (
                        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="typography-micro text-muted-foreground mb-1">{"Capabilities"}</div>
                            <div className="flex flex-wrap gap-1.5">
                                {currentCapabilityIcons.map(({ key, icon, label }) => (
                                    <div key={key} className="flex items-center gap-1.5">
                                        <IconBadge key={`cap-${key}`} iconName={icon} label={label} />
                                        <span className="typography-meta text-foreground">{label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {}
                    {(inputModalityIcons.length > 0 || outputModalityIcons.length > 0) && (
                        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="typography-micro text-muted-foreground mb-1">{"Modalities"}</div>
                            <div className="flex flex-col gap-1">
                                {inputModalityIcons.length > 0 && (
                                    <div className="flex items-center gap-2">
                                        <span className="typography-meta text-muted-foreground/80 w-12">{"Input"}</span>
                                        <div className="flex gap-1">
                                            {inputModalityIcons.map(({ key, icon, label }) => <IconBadge key={`input-${key}`} iconName={icon} label={`${label} input`} />)}
                                        </div>
                                    </div>
                                )}
                                {outputModalityIcons.length > 0 && (
                                    <div className="flex items-center gap-2">
                                        <span className="typography-meta text-muted-foreground/80 w-12">{"Output"}</span>
                                        <div className="flex gap-1">
                                            {outputModalityIcons.map(({ key, icon, label }) => <IconBadge key={`output-${key}`} iconName={icon} label={`${label} output`} />)}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {}
                    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                        <div className="typography-micro text-muted-foreground mb-1">{"Limits"}</div>
                        <div className="flex flex-col gap-0.5">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{"Context"}</span>
                                <span className="typography-meta font-medium text-foreground">{formatTokens(currentMetadata?.limit?.context)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{"Output"}</span>
                                <span className="typography-meta font-medium text-foreground">{formatTokens(currentMetadata?.limit?.output)}</span>
                            </div>
                        </div>
                    </div>

                    {}
                    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                        <div className="typography-micro text-muted-foreground mb-1">{"Metadata"}</div>
                        <div className="flex flex-col gap-0.5">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{"Knowledge"}</span>
                                <span className="typography-meta font-medium text-foreground">{formatKnowledge(currentMetadata?.knowledge)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{"Release"}</span>
                                <span className="typography-meta font-medium text-foreground">{formatDate(currentMetadata?.release_date)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </MobileOverlayPanel>
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

        const renderMobileModelRow = ({
            model,
            providerId,
            modelId,
            showProviderLogo,
        }: {
            model: ProviderModel;
            providerId: string;
            modelId: string;
            showProviderLogo: boolean;
        }) => {
            const rowKey = buildModelRefKey(providerId, modelId);
            const isSelected = providerId === currentProviderId && modelId === currentModelId;
            const metadata = mergeModelMetadataWithLiveModel(providerId, model, getModelMetadata(providerId, modelId));
            const variantOptions = getModelVariantOptions(providerId, modelId);
            const hasVariants = variantOptions.length > 0;
            const resolvedVariant = resolveModelVariantSelection(providerId, modelId);
            const pendingVariant = pendingThinkingVariants.get(rowKey);
            const hasPendingForRow = pendingThinkingVariants.has(rowKey);
            const effectiveVariant = hasPendingForRow ? pendingVariant : resolvedVariant;
            const variantLabel = hasVariants ? formatEffortLabel(effectiveVariant) : null;
            const isExpanded = expandedMobileModelKey === rowKey;
            const capabilityIcons = getCapabilityIcons(metadata).map((icon) => ({
                ...icon,
                label: localizeMetaLabel(icon.label),
            }));
            const modalityIcons = [
                ...getModalityIcons(metadata, 'input').map((icon) => ({ ...icon, label: localizeMetaLabel(icon.label) })),
                ...getModalityIcons(metadata, 'output').map((icon) => ({ ...icon, label: localizeMetaLabel(icon.label) })),
            ];
            const indicatorIcons = Array.from(
                new Map([...capabilityIcons, ...modalityIcons].map((icon) => [icon.key, icon])).values()
            );
            const contextText = metadata?.limit?.context ? `${formatTokens(metadata.limit.context)} ctx` : null;

            return (
                <div
                    key={`mobile-model-${providerId}-${modelId}`}
                    className={cn(
                        'border-b border-border/30 last:border-b-0',
                        isSelected && 'bg-interactive-selection/15 text-interactive-selection-foreground'
                    )}
                >
                    <div className="flex items-center gap-2 px-2 py-1.5">
                        <button
                            type="button"
                            onClick={() => handleMobileModelApply(providerId, modelId, effectiveVariant)}
                            className={cn(
                                'flex flex-1 min-w-0 items-start gap-2 text-left',
                                'focus:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded-lg'
                            )}
                        >
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <div className="flex min-w-0 items-center gap-1.5">
                                    {showProviderLogo ? (
                                        <ProviderLogo providerId={providerId} className="size-3.5 flex-shrink-0" />
                                    ) : null}
                                    <span className="typography-meta font-medium text-foreground truncate">
                                        {getModelDisplayName(model)}
                                    </span>
                                    {isSelected ? <Icon name="check" className="size-4 flex-shrink-0 text-primary" /> : null}
                                </div>
                                {contextText || indicatorIcons.length > 0 ? (
                                    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden typography-micro text-muted-foreground">
                                        {contextText ? (
                                            <span className="whitespace-nowrap flex-shrink-0">
                                                {contextText}
                                            </span>
                                        ) : null}
                                        {contextText && indicatorIcons.length > 0 ? (
                                            <span aria-hidden="true" className="h-3 w-px flex-shrink-0 bg-border/50" />
                                        ) : null}
                                        {indicatorIcons.length > 0 ? (
                                            <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap pl-0.5">
                                                {indicatorIcons.map(({ key, icon: iconName, label }) => (
                                                <span
                                                    key={`meta-${providerId}-${modelId}-${key}`}
                                                    className="flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground"
                                                    title={label}
                                                    aria-label={label}
                                                >
                                                    <Icon name={iconName} className="size-3" />
                                                </span>
                                            ))}
                                            </div>
                                        ) : null}
                                    </div>
                                ) : null}
                            </div>
                        </button>
                        {hasVariants ? (
                            <button
                                type="button"
                                onClick={() => setExpandedMobileModelKey((prev) => prev === rowKey ? null : rowKey)}
                                className="flex items-center gap-0.5 typography-micro font-medium text-muted-foreground hover:text-foreground flex-shrink-0"
                                aria-expanded={isExpanded}
                                aria-label={isExpanded ? "Hide thinking modes" : "Show thinking modes"}
                            >
                                <span className="whitespace-nowrap">{variantLabel}</span>
                                {isExpanded ? <Icon name="arrow-down-s" className="size-3.5" /> : <Icon name="arrow-right-s" className="size-3.5" />}
                            </button>
                        ) : null}
                        <div className="flex flex-shrink-0 items-center gap-1.5">
                            <button
                                type="button"
                                onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    toggleFavoriteModel(providerId, modelId);
                                }}
                                className={cn(
                                    'model-favorite-button flex size-5 items-center justify-center hover:text-primary/80 flex-shrink-0',
                                    isFavoriteModel(providerId, modelId) ? 'text-primary' : 'text-muted-foreground'
                                )}
                                aria-label={isFavoriteModel(providerId, modelId)
                                    ? "Unfavorite"
                                    : "Favorite"}
                                title={isFavoriteModel(providerId, modelId)
                                    ? "Remove from favorites"
                                    : "Add to favorites"}
                            >
                                {isFavoriteModel(providerId, modelId) ? (
                                    <Icon name="star-fill" className="size-4" />
                                ) : (
                                    <Icon name="star" className="size-4" />
                                )}
                            </button>
                        </div>
                    </div>
                    {isExpanded && hasVariants ? (
                        <div className="border-t border-border/30 px-1 py-1" data-no-drawer-swipe="true">
                            <ThinkingLevelPicker
                                levels={variantOptions}
                                value={parsePiThinkingLevel(effectiveVariant) ?? undefined}
                                onChange={() => {}}
                                onCommit={(next) => {
                                    setPendingThinkingVariants((prev) => {
                                        const nextMap = new Map(prev);
                                        nextMap.set(rowKey, next as string | undefined);
                                        return nextMap;
                                    });
                                    setAdjustedThinkingModels((prev) => {
                                        const nextSet = new Set(prev);
                                        nextSet.add(rowKey);
                                        return nextSet;
                                    });
                                    setModelPickerRenderVersion((v) => v + 1);
                                }}
                            />
                        </div>
                    ) : null}
                </div>
            );
        };

        const hasResults = filteredFavorites.length > 0 || filteredRecents.length > 0 || filteredProviders.length > 0;

        return (
            <MobileOverlayPanel
                open={activeMobilePanel === 'model'}
                onClose={closeMobilePanel}
                title={"Select model"}
            >
                <div className="flex flex-col gap-2">
                    <div>
                        <div className="relative">
                            <Icon name="search" className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                            <Input
                                value={mobileModelQuery}
                                onChange={(event) => {
                                    setMobileModelQuery(event.target.value);
                                    setExpandedMobileModelKey(null);
                                }}
                                        placeholder={"Search providers or models"}
                                className="pl-7 h-9 rounded-xl border-border/40 bg-[var(--surface-elevated)] typography-meta"
                            />
                            {mobileModelQuery && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setMobileModelQuery('');
                                        setExpandedMobileModelKey(null);
                                    }}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                    aria-label={"Clear search"}
                                >
                                    <Icon name="close-circle" className="size-4" />
                                </button>
                            )}
                        </div>
                    </div>

                    {!hasResults && (
                        <div className="px-3 py-8 text-center typography-meta text-muted-foreground">
                            {"No providers or models match your search."}
                        </div>
                    )}

                    {/* Favorites Section for Mobile */}
                    {filteredFavorites.length > 0 && (
                        <div className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] overflow-hidden">
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                <Icon name="star-fill" className="size-3 inline-block mr-1.5 text-primary" />
                                {"Favorites"}
                            </div>
                            <div className="flex flex-col border-t border-border/30">
                                {filteredFavorites.map(({ model, providerID, modelID }) => renderMobileModelRow({
                                    model,
                                    providerId: providerID,
                                    modelId: modelID,
                                    showProviderLogo: true,
                                }))}
                            </div>
                        </div>
                    )}

                    {/* Recent Section for Mobile */}
                    {filteredRecents.length > 0 && (
                        <div className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] overflow-hidden">
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                <Icon name="time" className="size-3 inline-block mr-1.5" />
                                {"Recent"}
                            </div>
                            <div className="flex flex-col border-t border-border/30">
                                {filteredRecents.map(({ model, providerID, modelID }) => renderMobileModelRow({
                                    model,
                                    providerId: providerID,
                                    modelId: modelID,
                                    showProviderLogo: true,
                                }))}
                            </div>
                        </div>
                    )}

                    {filteredProviders.map(({ provider, providerModels }) => {
                        if (providerModels.length === 0) {
                            return null;
                        }

                        const providerId = String(provider.id || '');
                        const providerName = String(provider.name || providerId);
                        const isActiveProvider = providerId === currentProviderId;
                        const isExpanded = expandedMobileProviders.has(providerId) || normalizedQuery.length > 0;

                         return (
                             <div key={providerId} className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (normalizedQuery.length > 0) {
                                            return;
                                        }
                                        toggleMobileProviderExpansion(providerId);
                                    }}
                                    className="flex w-full items-center justify-between gap-1.5 px-2 py-1.5 text-left"
                                    aria-expanded={isExpanded}
                                >
                                    <div className="flex items-center gap-2">
                                        <ProviderLogo
                                            providerId={providerId}
                                            className="size-3.5"
                                        />
                                        <span className="typography-meta font-medium text-foreground">
                                            {providerName}
                                        </span>
                                        {isActiveProvider && (
                                            <span className="typography-micro text-primary/80">{"Current"}</span>
                                        )}
                                    </div>
                                    {isExpanded ? (
                                        <Icon name="arrow-down-s" className="size-3 text-muted-foreground" />
                                    ) : (
                                        <Icon name="arrow-right-s" className="size-3 text-muted-foreground" />
                                    )}
                                </button>

                                {isExpanded && providerModels.length > 0 && (
                                    <div className="flex flex-col border-t border-border/30">
                                        {providerModels.map((model: ProviderModel) => renderMobileModelRow({
                                            model,
                                            providerId: provider.id as string,
                                            modelId: model.id as string,
                                            showProviderLogo: false,
                                        }))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderMobileVariantPanel = () => {
        if (!isCompact) return null;
        if (!currentProviderId || !currentModelId) return null;

        const targetVariants = getModelVariantOptions(currentProviderId, currentModelId);
        if (targetVariants.length === 0) return null;

        // Use the live composer variant directly so dragging to Default (undefined)
        // stays on Default while dragging. The resolver would snap Default back to
        // the model's configured default for new sessions, which caused the
        // right-to-left glitch where the thumb jumped to the highest level.
        const selectedVariant = currentVariant;

        return (
            <MobileOverlayPanel
                open={activeMobilePanel === 'variant'}
                onClose={closeMobilePanel}
                title={"Thinking"}
            >
                <ThinkingLevelPicker
                    levels={targetVariants}
                    value={parsePiThinkingLevel(selectedVariant) ?? undefined}
                    onChange={handleVariantLiveChange}
                    onCommit={handleVariantCommit}
                />
            </MobileOverlayPanel>
        );
    };



    const renderModelTooltipContent = () => (
        <TooltipContent align="start" sideOffset={8} className="max-w-[320px]">
            {currentMetadata ? (
                <div className="flex min-w-[240px] flex-col gap-3">
                    <div className="flex flex-col gap-0.5">
                        <span className="typography-micro font-semibold text-foreground">
                            {currentMetadata.name || getCurrentModelDisplayName()}
                        </span>
                        <span className="typography-meta text-muted-foreground">{getProviderDisplayName()}</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{"Capabilities"}</span>
                        <div className="flex flex-wrap items-center gap-1.5">
                            {currentCapabilityIcons.length > 0 ? (
                                currentCapabilityIcons.map(({ key, icon, label }) =>
                                    <IconBadge key={`cap-${key}`} iconName={icon} label={label} />
                                )
                            ) : (
                                <span className="typography-meta text-muted-foreground">{"—"}</span>
                            )}
                        </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{"Modalities"}</span>
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{"Input"}</span>
                                <div className="flex items-center gap-1.5">
                                    {inputModalityIcons.length > 0
                                        ? inputModalityIcons.map(({ key, icon, label }) =>
                                              <IconBadge key={`input-${key}`} iconName={icon} label={`${label} input`} />
                                          )
                                        : <span className="typography-meta text-muted-foreground">-</span>}
                                </div>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{"Output"}</span>
                                <div className="flex items-center gap-1.5">
                                    {outputModalityIcons.length > 0
                                        ? outputModalityIcons.map(({ key, icon, label }) =>
                                              <IconBadge key={`output-${key}`} iconName={icon} label={`${label} output`} />
                                          )
                                        : <span className="typography-meta text-muted-foreground">-</span>}
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{"Cost ($/1M tokens)"}</span>
                        {costRows.map((row) => (
                            <div key={row.label} className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{row.label}</span>
                                <span className="typography-meta font-medium text-foreground">{row.value}</span>
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{"Limits"}</span>
                        {limitRows.map((row) => (
                            <div key={row.label} className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{row.label}</span>
                                <span className="typography-meta font-medium text-foreground">{row.value}</span>
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{"Metadata"}</span>
                        <div className="flex items-center justify-between gap-3">
                            <span className="typography-meta font-medium text-muted-foreground/80">{"Knowledge"}</span>
                            <span className="typography-meta font-medium text-foreground">{formatKnowledge(currentMetadata.knowledge)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span className="typography-meta font-medium text-muted-foreground/80">{"Release"}</span>
                            <span className="typography-meta font-medium text-foreground">{formatDate(currentMetadata.release_date)}</span>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="min-w-[200px] typography-meta text-muted-foreground">{"Model metadata unavailable."}</div>
            )}
        </TooltipContent>
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
