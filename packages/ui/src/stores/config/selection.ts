import type { Agent } from '@/lib/chat/types';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { configurableThinkingLevels, parsePiThinkingLevel } from '@/lib/pi/thinking';

export const ADD_PROVIDER_SENTINEL = "__add_provider__";
const GIT_UTILITY_PROVIDER_ID = "zen";
const GIT_UTILITY_PREFERRED_MODEL_ID = "big-pickle";

export const parseModelString = (modelString: string): { providerId: string; modelId: string } | null => {
    return parseModelIdentifier(modelString);
};

type ProviderModelCapabilitySet = {
    text: boolean;
    audio: boolean;
    image: boolean;
    video: boolean;
    pdf: boolean;
};

export type ProviderModel = {
    id: string;
    name?: string;
    providerID?: string;
    reasoning?: boolean;
    supportsThinking?: boolean;
    thinkingLevels?: string[];
    capabilities?: {
        toolcall?: boolean;
        reasoning?: boolean;
        temperature?: boolean;
        attachment?: boolean;
        input?: ProviderModelCapabilitySet;
        output?: ProviderModelCapabilitySet;
    };
    cost?: {
        input?: number;
        output?: number;
        cache?: { read?: number; write?: number };
    };
    limit?: { context?: number; output?: number };
    release_date?: string;
    [key: string]: unknown;
};

export type ProviderWithModelList = {
    id: string;
    name?: string;
    authenticated?: boolean;
    models: ProviderModel[];
    [key: string]: unknown;
};

type ConfigAgent = Agent & {
    name?: string;
    mode?: string;
    hidden?: boolean;
    model?: { providerID?: string; modelID?: string };
    variant?: string;
};

export const asConfigAgent = (agent: Agent | undefined): ConfigAgent | undefined => agent as ConfigAgent | undefined;

export const resolveThinkingVariant = (model: ProviderModel | undefined, variant: string | undefined): string | undefined => {
    const parsed = parsePiThinkingLevel(variant);
    return parsed && configurableThinkingLevels(model).includes(parsed) ? parsed : undefined;
};

type GitModelSelection = { providerId: string; modelId: string };
type ProviderModelSelection = { providerId: string; modelId: string; variant?: string } | null;

export const sanitizePersistedSelectedProviderId = (providerId: string | undefined): string => (
    providerId === ADD_PROVIDER_SENTINEL ? "" : (providerId ?? "")
);

export const preserveAddProviderSelection = (currentSelectedProviderId: string | undefined, nextProviderId: string): string => (
    currentSelectedProviderId === ADD_PROVIDER_SENTINEL ? ADD_PROVIDER_SENTINEL : nextProviderId
);

export const normalizeOptionalString = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

export const hasProviderModel = (
    providers: ProviderWithModelList[],
    providerId: string,
    modelId: string
): boolean => {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
        return false;
    }
    return provider.models.some((model) => model.id === modelId);
};

export const resolveProviderModelSelection = ({
    providers,
    currentProviderId,
    currentModelId,
    currentVariant,
    settingsDefaultModel,
    settingsDefaultVariant,
}: {
    providers: ProviderWithModelList[];
    currentProviderId?: string;
    currentModelId?: string;
    currentVariant?: string;
    settingsDefaultModel?: string;
    settingsDefaultVariant?: string;
}): ProviderModelSelection => {
    const resolveVariant = (providerId: string, modelId: string, variant?: string): string | undefined => {
        if (!variant) {
            return undefined;
        }

        const model = providers
            .find((provider) => provider.id === providerId)
            ?.models.find((entry) => entry.id === modelId);

        return resolveThinkingVariant(model, variant);
    };

    if (currentProviderId && currentModelId && hasProviderModel(providers, currentProviderId, currentModelId)) {
        return {
            providerId: currentProviderId,
            modelId: currentModelId,
            variant: resolveVariant(currentProviderId, currentModelId, currentVariant),
        };
    }

    if (settingsDefaultModel) {
        const parsed = parseModelString(settingsDefaultModel);
        if (parsed && hasProviderModel(providers, parsed.providerId, parsed.modelId)) {
            return {
                providerId: parsed.providerId,
                modelId: parsed.modelId,
                variant: resolveVariant(parsed.providerId, parsed.modelId, settingsDefaultVariant),
            };
        }
    }

    const firstProvider = providers.find((p) => p.authenticated && p.models.length > 0) || providers.find((p) => p.models.length > 0) || providers[0];
    const firstModel = firstProvider?.models[0];
    if (firstProvider && firstModel) {
        return { providerId: firstProvider.id, modelId: firstModel.id };
    }

    return null;
};

type DefaultAgentModelSelection = {
    agentName: string | undefined;
    providerId?: string;
    modelId?: string;
    variant?: string;
};

// Shared default-selection cascade used both at startup (loadAgents) and when opening a
// fresh draft (applyDefaultModelAgentSelection), so the two paths stay identical.
//
//   Agent: settings.defaultAgent → Pi default_agent → build → first primary → first
//   Model: project.defaultModel → settings.defaultModel → resolved agent's pinned model+variant → Pi config.model
//          → Pi/big-pickle → first
//
// The Pi default_agent / default model (config fields on the Pi server) are honored
// only when our own settings have no valid default. Pi itself resolves a model the same way:
// an agent's pinned model wins, otherwise the global `model` config applies — so we check the
// agent's model before runtimeDefaultModel. When the agent supplies the model, its `variant` is
// carried through too (if the model actually exposes that variant).
export const resolveDefaultAgentModelSelection = ({
    agents,
    providers,
    projectDefaultModel,
    settingsDefaultModel,
    settingsDefaultVariant,
    runtimeDefaultAgent,
    runtimeDefaultModel,
}: {
    agents: Agent[];
    providers: ProviderWithModelList[];
    projectDefaultModel?: string;
    settingsDefaultModel?: string;
    settingsDefaultVariant?: string;
    runtimeDefaultAgent?: string;
    runtimeDefaultModel?: string;
}): DefaultAgentModelSelection => {
    if (agents.length === 0) {
        return { agentName: undefined };
    }

    const resolveVariant = (providerId: string, modelId: string, variant?: string): string | undefined => {
        if (!variant) {
            return undefined;
        }
        const model = providers
            .find((provider) => provider.id === providerId)
            ?.models.find((entry) => entry.id === modelId);
        return resolveThinkingVariant(model, variant);
    };

    // --- Agent cascade ---
    const primaryAgents = agents.filter((agent) => isPrimaryMode((agent as ConfigAgent).mode));

    let resolvedAgent: ConfigAgent | undefined;
    if (runtimeDefaultAgent) {
        const candidate = asConfigAgent(agents.find((agent) => agent.name === runtimeDefaultAgent));
        // Pi requires the default agent to be a visible primary agent.
        if (candidate && isPrimaryMode(candidate.mode) && candidate.hidden !== true) {
            resolvedAgent = candidate;
        }
    }
    if (!resolvedAgent) {
        resolvedAgent = asConfigAgent(primaryAgents.find((agent) => agent.name === "build") || primaryAgents[0] || agents[0]);
    }
    if (!resolvedAgent) {
        return { agentName: undefined };
    }

    // --- Model cascade ---
    let providerId: string | undefined;
    let modelId: string | undefined;
    let variant: string | undefined;

    const effectiveDefaultModel = projectDefaultModel || settingsDefaultModel;

    if (effectiveDefaultModel) {
        const parsed = parseModelString(effectiveDefaultModel);
        if (parsed && hasProviderModel(providers, parsed.providerId, parsed.modelId)) {
            providerId = parsed.providerId;
            modelId = parsed.modelId;
            variant = resolveVariant(providerId, modelId, projectDefaultModel ? undefined : settingsDefaultVariant);
        }
    }

    if (!providerId
        && resolvedAgent.model?.providerID
        && resolvedAgent.model?.modelID
        && hasProviderModel(providers, resolvedAgent.model.providerID, resolvedAgent.model.modelID)) {
        providerId = resolvedAgent.model.providerID;
        modelId = resolvedAgent.model.modelID;
        variant = resolveVariant(providerId, modelId, resolvedAgent.variant);
    }

    // Pi's global default model — used when neither our settings nor the agent pin a model.
    if (!providerId && runtimeDefaultModel) {
        const parsed = parseModelString(runtimeDefaultModel);
        if (parsed && hasProviderModel(providers, parsed.providerId, parsed.modelId)) {
            providerId = parsed.providerId;
            modelId = parsed.modelId;
        }
    }

    if (!providerId) {
        const firstProvider = providers.find((p) => p.authenticated && p.models.length > 0) || providers.find((p) => p.models.length > 0) || providers[0];
        const firstModel = firstProvider?.models[0];
        if (firstProvider && firstModel) {
            providerId = firstProvider.id;
            modelId = firstModel.id;
        }
    }

    return { agentName: resolvedAgent.name, providerId, modelId, variant };
};

export const resolveGitGenerationModelSelection = ({
    providers,
    settingsZenModel,
}: {
    providers: ProviderWithModelList[];
    settingsZenModel?: string;
}): GitModelSelection | null => {
    const zenModel = normalizeOptionalString(settingsZenModel);

    if (!Array.isArray(providers) || providers.length === 0) {
        if (zenModel) {
            return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: zenModel };
        }
        return null;
    }

    if (zenModel && hasProviderModel(providers, GIT_UTILITY_PROVIDER_ID, zenModel)) {
        return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: zenModel };
    }

    if (hasProviderModel(providers, GIT_UTILITY_PROVIDER_ID, GIT_UTILITY_PREFERRED_MODEL_ID)) {
        return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: GIT_UTILITY_PREFERRED_MODEL_ID };
    }

    const zenProvider = providers.find((provider) => provider.id === GIT_UTILITY_PROVIDER_ID);
    if (zenProvider?.models.length) {
        const randomIndex = Math.floor(Math.random() * zenProvider.models.length);
        const randomModelId = normalizeOptionalString(zenProvider.models[randomIndex]?.id);
        if (randomModelId) {
            return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: randomModelId };
        }
    }

    return null;
};

const hasValidVariant = (
    providers: ProviderWithModelList[],
    providerId: string,
    modelId: string,
    variant: string | undefined,
): boolean => {
    if (!variant) return true;
    const model = providers
        .find((provider) => provider.id === providerId)
        ?.models.find((entry) => entry.id === modelId);
    return resolveThinkingVariant(model, variant) !== undefined;
};

export const resolveSelectionWithManualGuard = ({
    agents,
    providers,
    currentAgentName,
    currentProviderId,
    currentModelId,
    currentVariant,
    selectionSource,
    resolvedAgentName,
    resolvedProviderId,
    resolvedModelId,
    resolvedVariant,
}: {
    agents: Agent[];
    providers: ProviderWithModelList[];
    currentAgentName: string | undefined;
    currentProviderId: string;
    currentModelId: string;
    currentVariant: string | undefined;
    selectionSource: "auto" | "manual";
    resolvedAgentName: string | undefined;
    resolvedProviderId: string | undefined;
    resolvedModelId: string | undefined;
    resolvedVariant: string | undefined;
}) => {
    const manualAgentName = currentAgentName && agents.some((agent) => agent.name === currentAgentName)
        ? currentAgentName
        : undefined;
    const manualModelValid = !!currentProviderId
        && !!currentModelId
        && hasProviderModel(providers, currentProviderId, currentModelId)
        && hasValidVariant(providers, currentProviderId, currentModelId, currentVariant);
    const preserveManual = selectionSource === "manual" && (!!manualAgentName || manualModelValid);

    return {
        agentName: preserveManual ? (manualAgentName ?? resolvedAgentName) : resolvedAgentName,
        providerId: preserveManual && manualModelValid ? currentProviderId : resolvedProviderId,
        modelId: preserveManual && manualModelValid ? currentModelId : resolvedModelId,
        variant: preserveManual && manualModelValid ? currentVariant : resolvedVariant,
        selectionSource: preserveManual ? "manual" as const : "auto" as const,
    };
};
