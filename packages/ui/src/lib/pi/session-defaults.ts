import { parseModelIdentifier } from '@/lib/modelIdentifier';
import type { PiChamberDefaultsUpdateInput } from './protocol';
import type { PiModelRef } from './types';

export { parsePiThinkingLevel } from './thinking';

type LegacyUiModelDefaults = {
  defaultModel?: unknown;
  smallModelUseDefault?: unknown;
  smallModelOverride?: unknown;
  walkthroughModelOverride?: unknown;
};

export const formatPiModelRef = (model?: PiModelRef | null): string | undefined => {
  if (!model) return undefined;
  const providerId = model.providerId.trim();
  const modelId = model.modelId.trim();
  if (!providerId || !modelId) return undefined;
  return `${providerId}/${modelId}`;
};

export const parsePiModelRef = (value: string | undefined | null): PiModelRef | null => {
  const parsed = parseModelIdentifier(value ?? undefined);
  if (!parsed) return null;
  return { providerId: parsed.providerId, modelId: parsed.modelId };
};

/** Copy leftover UI/desktop model strings into sidecar fields that are still unset. */
export const legacyUiModelDefaultsPatch = (
  uiSettings: LegacyUiModelDefaults | null | undefined,
  current: { defaultModel?: PiModelRef; smallModel?: PiModelRef; walkthroughModel?: PiModelRef } = {},
): PiChamberDefaultsUpdateInput => {
  if (!uiSettings) return {};
  const patch: PiChamberDefaultsUpdateInput = {};
  if (!current.defaultModel) {
    const model = parsePiModelRef(typeof uiSettings.defaultModel === 'string' ? uiSettings.defaultModel : undefined);
    if (model) patch.defaultModel = model;
  }
  if (!current.smallModel && uiSettings.smallModelUseDefault === false) {
    const small = parsePiModelRef(typeof uiSettings.smallModelOverride === 'string' ? uiSettings.smallModelOverride : undefined);
    if (small) patch.smallModel = small;
  }
  if (!current.walkthroughModel) {
    const walkthrough = parsePiModelRef(
      typeof uiSettings.walkthroughModelOverride === 'string' ? uiSettings.walkthroughModelOverride : undefined,
    );
    if (walkthrough) patch.walkthroughModel = walkthrough;
  }
  return patch;
};

export const hasLegacyUiModelDefaultsPatch = (patch: PiChamberDefaultsUpdateInput): boolean => (
  Boolean(patch.defaultModel || patch.smallModel || patch.walkthroughModel)
);
