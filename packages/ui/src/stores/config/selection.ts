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

export const resolveThinkingVariant = (model: ProviderModel | undefined, variant: string | undefined): string | undefined => {
    const parsed = parsePiThinkingLevel(variant);
    return parsed && configurableThinkingLevels(model).includes(parsed) ? parsed : undefined;
};

type GitModelSelection = { providerId: string; modelId: string };
type ProviderModelSelection = { providerId: string; modelId: string; variant?: string } | null;

export const sanitizePersistedSelectedProviderId = (providerId: string | undefined): string => (
    providerId === ADD_PROVIDER_SENTINEL ? "" : (providerId ?? "")
);

export const normalizeOptionalString = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const hasProviderModel = (
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
