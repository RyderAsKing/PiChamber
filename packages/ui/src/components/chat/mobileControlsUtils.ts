import { getProviderModelDisplayName, type DisplayProvider } from '@/lib/modelDisplay';
import { thinkingLevelLabel } from '@/lib/pi/thinking';

export type MobileControlsPanel = 'model' | 'variant' | null;

export const getModelDisplayName = (
    provider: DisplayProvider,
    modelId: string | undefined,
    fallbackLabel = '',
) => {
    return getProviderModelDisplayName(provider, modelId, { fallbackLabel });
};

export const formatEffortLabel = (variant?: string) => {
    if (!variant || variant.trim().length === 0) {
        return thinkingLevelLabel(undefined);
    }
    const trimmed = variant.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        return trimmed;
    }
    return thinkingLevelLabel(trimmed);
};
