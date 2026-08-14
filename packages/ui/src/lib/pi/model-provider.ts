/**
 * Pi model / provider helpers.
 *
 * The Pi runtime owns the authoritative model catalog. The helpers here are
 * the pure UI-side layer:
 *
 * - Sorting and grouping providers/models for the picker.
 * - Comparing `PiModelRef` values.
 * - Resolving the new-session model/thinking using the agreed precedence.
 * - Building the new-session selection from PiChamber settings + Pi fallback.
 *
 * The helpers do not call the network; the bootstrap owner (`pi-bootstrap.ts`)
 * feeds them the data they need.
 */

import type { PiModel, PiModelRef, PiProvider, PiThinkingLevel } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const compareModelRefs = (a: PiModelRef | undefined, b: PiModelRef | undefined): boolean => {
  if (!a || !b) return false;
  return a.providerId === b.providerId && a.modelId === b.modelId;
};

export const modelRefKey = (model: PiModelRef | undefined): string | undefined => {
  if (!model) return undefined;
  return `${model.providerId}/${model.modelId}`;
};

/** Return the models of a provider, sorted by label/id. */
export const listProviderModels = (provider: PiProvider): PiModel[] => {
  return [...provider.models].sort((a, b) => cmp(a.id, b.id));
};

/**
 * Build the picker-friendly flat list of models. The list preserves
 * provider ordering: all of provider A's models come before any of provider
 * B's. The ordering lets the sidebar display "by provider" without a second
 * pass.
 */
export const flattenProviderModels = (providers: PiProvider[]): PiModel[] => {
  const sortedProviders = [...providers].sort((a, b) => cmp(a.label ?? a.id, b.label ?? b.id));
  const result: PiModel[] = [];
  for (const provider of sortedProviders) {
    result.push(...listProviderModels(provider));
  }
  return result;
};

/** Look up a provider by id in the catalog. */
export const findProvider = (
  providers: PiProvider[],
  providerId: string,
): PiProvider | undefined => providers.find((provider) => provider.id === providerId);

/** Look up a model by provider+model id. */
export const findModel = (
  providers: PiProvider[],
  providerId: string,
  modelId: string,
): PiModel | undefined => findProvider(providers, providerId)?.models.find((model) => model.id === modelId);

/**
 * Build a stable "thinking allowed" lookup. Returns `true` for models that
 * have an empty or missing `thinkingLevels` array because PiChamber follows
 * Pi's default of allowing thinking when no list is provided.
 */
export const isThinkingAllowed = (
  model: PiModel | undefined,
  level: PiThinkingLevel | undefined,
): boolean => {
  if (!model || !level || level === 'off') return true;
  if (model.supportsThinking === false) return false;
  if (!model.thinkingLevels || model.thinkingLevels.length === 0) return true;
  return model.thinkingLevels.includes(level);
};

/** Default-thinking fallback order. The new-session UI uses this. */
export const DEFAULT_THINKING_ORDER: PiThinkingLevel[] = ['medium', 'low', 'high', 'xhigh', 'off'];

export const pickFallbackThinking = (
  model: PiModel | undefined,
  preferred: PiThinkingLevel | undefined,
): PiThinkingLevel | undefined => {
  if (!model) return preferred;
  if (preferred && isThinkingAllowed(model, preferred)) return preferred;
  for (const level of DEFAULT_THINKING_ORDER) {
    if (isThinkingAllowed(model, level)) return level;
  }
  return undefined;
};

/**
 * Resolve the new-session model selection using the precedence documented
 * in the migration plan: explicit UI selection beats PiChamber default,
 * PiChamber default beats Pi fallback.
 */
export interface ResolveNewSessionModelInput {
  providers: PiProvider[];
  explicit?: PiModelRef;
  configuredDefault?: PiModelRef;
  piFallback?: PiModelRef;
}

export const resolveNewSessionModel = (input: ResolveNewSessionModelInput): PiModelRef | undefined => {
  const sources: Array<PiModelRef | undefined> = [
    input.explicit,
    input.configuredDefault,
    input.piFallback,
  ];
  for (const candidate of sources) {
    if (!candidate) continue;
    if (findModel(input.providers, candidate.providerId, candidate.modelId)) {
      return candidate;
    }
  }
  // The first non-null candidate is still authoritative even if Pi does not
  // know about the model: the user picked it explicitly or PiChamber set it
  // as a default. The provider UI will surface the unknown status when
  // listing providers.
  for (const candidate of sources) {
    if (candidate) return candidate;
  }
  return undefined;
};

/** Same precedence as `resolveNewSessionModel` but for the thinking level. */
export const resolveNewSessionThinking = (params: {
  providers: PiProvider[];
  resolvedModel?: PiModelRef;
  explicit?: PiThinkingLevel;
  configuredDefault?: PiThinkingLevel;
  piFallback?: PiThinkingLevel;
}): PiThinkingLevel | undefined => {
  const candidate = params.explicit ?? params.configuredDefault ?? params.piFallback;
  if (!candidate) return undefined;
  if (candidate === 'off') return 'off';
  const model = params.resolvedModel
    ? findModel(params.providers, params.resolvedModel.providerId, params.resolvedModel.modelId)
    : undefined;
  return pickFallbackThinking(model, candidate);
};
