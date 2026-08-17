import type { PiModelRef, PiThinkingLevel } from './types';

/** Pi thinking-level order. Keep in sync with `packages/web/server/lib/pi/thinking-levels.js`. */
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly PiThinkingLevel[];

export const PI_THINKING_LEVEL_LABELS: Record<PiThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export const isPiThinkingLevel = (value: unknown): value is PiThinkingLevel => (
  value === 'off' || value === 'minimal' || value === 'low' || value === 'medium'
  || value === 'high' || value === 'xhigh' || value === 'max'
);

export const parsePiThinkingLevel = (value: unknown): PiThinkingLevel | null => (
  isPiThinkingLevel(value) ? value : null
);

type ThinkingMapModel = {
  thinkingLevelMap?: Record<string, unknown> | null;
  reasoning?: unknown;
};

/**
 * Mirror of Pi `getSupportedThinkingLevels`.
 * `reasoning: false` → `['off']`. A `null` map entry hides that level.
 * `xhigh`/`max` are opt-in (must be present and non-null in the map).
 */
export const getSupportedThinkingLevels = (model: ThinkingMapModel | null | undefined): PiThinkingLevel[] => {
  if (!model || model.reasoning !== true) return ['off'];
  const map = model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object'
    ? model.thinkingLevelMap
    : undefined;
  const supported = PI_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
  return supported.length > 0 ? supported : ['off'];
};

/** If `requested` is missing, walk up the ordered list, then down. */
export const clampThinkingLevel = (supported: readonly string[], requested?: string): PiThinkingLevel => {
  const available = supported.filter(isPiThinkingLevel);
  const levels: PiThinkingLevel[] = available.length > 0 ? available : ['off'];
  if (requested && levels.includes(requested as PiThinkingLevel)) return requested as PiThinkingLevel;
  const requestedIndex = PI_THINKING_LEVELS.indexOf(requested as PiThinkingLevel);
  if (requestedIndex === -1) return levels[0];
  for (let index = requestedIndex + 1; index < PI_THINKING_LEVELS.length; index += 1) {
    if (levels.includes(PI_THINKING_LEVELS[index])) return PI_THINKING_LEVELS[index];
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    if (levels.includes(PI_THINKING_LEVELS[index])) return PI_THINKING_LEVELS[index];
  }
  return levels[0];
};

export const catalogThinkingLevels = (model: {
  thinkingLevels?: unknown;
  reasoning?: unknown;
  supportsThinking?: unknown;
} | null | undefined): PiThinkingLevel[] => {
  if (Array.isArray(model?.thinkingLevels) && model.thinkingLevels.length > 0) {
    const catalog = model.thinkingLevels;
    const levels = PI_THINKING_LEVELS.filter((level) => catalog.includes(level));
    return levels.length > 0 ? levels : ['off'];
  }
  if (model?.reasoning === true || model?.supportsThinking === true) {
    return PI_THINKING_LEVELS.filter((level) => level !== 'xhigh' && level !== 'max');
  }
  return ['off'];
};

export const modelHasConfigurableThinking = (levels: readonly string[]): boolean => (
  levels.some((level) => level !== 'off' && isPiThinkingLevel(level))
);

export const configurableThinkingLevels = (
  model: Parameters<typeof catalogThinkingLevels>[0],
): PiThinkingLevel[] => {
  const levels = catalogThinkingLevels(model);
  return modelHasConfigurableThinking(levels) ? levels : [];
};

export const thinkingLevelLabel = (level: string | undefined): string => {
  if (!level) return 'Default';
  if (isPiThinkingLevel(level)) return PI_THINKING_LEVEL_LABELS[level];
  return `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
};

/** Snap a 0–1 track ratio onto a discrete tick. */
export const nearestDiscreteIndex = (ratio: number, count: number): number => {
  if (count <= 1) return 0;
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
};

/**
 * Cycle Default plus the model's thinking levels.
 * Unknown/unset current values start at Default.
 */
export const cycleThinkingLevel = (
  levels: readonly string[],
  current: string | undefined,
  direction: 1 | -1,
): PiThinkingLevel | undefined => {
  const available = levels.filter(isPiThinkingLevel);
  if (!modelHasConfigurableThinking(available)) return undefined;
  const options: Array<PiThinkingLevel | undefined> = [undefined, ...available];
  const currentLevel = isPiThinkingLevel(current) && available.includes(current) ? current : undefined;
  const index = options.indexOf(currentLevel);
  return options[(index + direction + options.length) % options.length];
};

export const thinkingModelKey = (model?: PiModelRef | null): string | undefined => {
  if (!model) return undefined;
  const providerId = model.providerId.trim();
  const modelId = model.modelId.trim();
  if (!providerId || !modelId) return undefined;
  return `${providerId}/${modelId}`;
};

const thinkingFromMap = (
  map: Record<string, string> | undefined,
  key: string | undefined,
): PiThinkingLevel | undefined => {
  if (!key || !map) return undefined;
  return parsePiThinkingLevel(map[key]) ?? undefined;
};

export const resolveCreateThinking = (options: {
  thinking?: PiThinkingLevel;
  model?: PiModelRef | null;
  defaultThinkingByModel?: Record<string, string>;
  defaultThinking?: string;
}): PiThinkingLevel | undefined => {
  if (options.thinking) return options.thinking;
  const key = thinkingModelKey(options.model);
  return thinkingFromMap(options.defaultThinkingByModel, key)
    ?? parsePiThinkingLevel(options.defaultThinking)
    ?? undefined;
};

export const resolveComposerThinkingForModel = (options: {
  providerId: string;
  modelId: string;
  thinkingLevels?: unknown;
  reasoning?: unknown;
  supportsThinking?: unknown;
  defaultThinkingByModel?: Record<string, string>;
  defaultThinking?: string;
  previousThinking?: string;
}): PiThinkingLevel | undefined => {
  const levels = catalogThinkingLevels(options);
  if (!modelHasConfigurableThinking(levels)) return undefined;
  const key = thinkingModelKey({ providerId: options.providerId, modelId: options.modelId });
  const requested = thinkingFromMap(options.defaultThinkingByModel, key)
    ?? (isPiThinkingLevel(options.previousThinking) ? options.previousThinking : undefined)
    ?? parsePiThinkingLevel(options.defaultThinking)
    ?? undefined;
  if (!requested) return undefined;
  return clampThinkingLevel(levels, requested);
};

const asModelRef = (model?: PiModelRef | null): PiModelRef | undefined => {
  if (!model) return undefined;
  const providerId = model.providerId.trim();
  const modelId = model.modelId.trim();
  if (!providerId || !modelId) return undefined;
  return { providerId, modelId };
};

/**
 * Last model/thinking actually used inside an existing Pi session.
 * The latest assistant turn wins over live session fields so a globally
 * last-selected default cannot clobber an older chat's cache identity.
 * Live `session.model` / `session.thinking` fill gaps when the transcript
 * does not carry them.
 */
export const resolveExistingSessionComposerSelection = (session: {
  model?: PiModelRef | null;
  thinking?: unknown;
  messages?: Iterable<{
    role?: string;
    createdAt?: number;
    model?: PiModelRef | null;
    thinkingLevel?: unknown;
  }>;
}): { model?: PiModelRef; thinking?: PiThinkingLevel } => {
  let lastAssistant: {
    createdAt: number;
    model?: PiModelRef;
    thinkingLevel?: PiThinkingLevel;
  } | undefined;
  if (session.messages) {
    for (const message of session.messages) {
      if (message.role !== 'assistant') continue;
      const model = asModelRef(message.model);
      const thinkingLevel = parsePiThinkingLevel(message.thinkingLevel) ?? undefined;
      if (!model && !thinkingLevel) continue;
      const createdAt = typeof message.createdAt === 'number' && Number.isFinite(message.createdAt)
        ? message.createdAt
        : 0;
      if (!lastAssistant || createdAt >= lastAssistant.createdAt) {
        lastAssistant = { createdAt, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
      }
    }
  }
  const model = lastAssistant?.model ?? asModelRef(session.model);
  const thinking = lastAssistant?.thinkingLevel ?? parsePiThinkingLevel(session.thinking) ?? undefined;
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
};
