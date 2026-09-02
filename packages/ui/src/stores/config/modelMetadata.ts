import type { ModelMetadata } from '@/types';
import { markStartupTrace, measureStartupTrace } from '@/lib/startupTrace';

const MODELS_DEV_API_URL = 'https://models.dev/api.json';

type CapabilitySet = {
  text: boolean;
  audio: boolean;
  image: boolean;
  video: boolean;
  pdf: boolean;
};

type ProviderModelLike = {
  id: string;
  name?: string;
  capabilities?: {
    toolcall?: boolean;
    reasoning?: boolean;
    temperature?: boolean;
    attachment?: boolean;
    input?: CapabilitySet;
    output?: CapabilitySet;
  };
  cost?: {
    input?: number;
    output?: number;
    cache?: { read?: number; write?: number };
  };
  limit?: { context?: number; output?: number };
  release_date?: string;
};

type ModelsDevModelEntry = {
  id?: string;
  name?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  structured_output?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  cost?: ModelMetadata['cost'];
  limit?: ModelMetadata['limit'];
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
};

type ModelsDevProviderEntry = {
  id?: string;
  models?: Record<string, ModelsDevModelEntry | undefined>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

const isStringArray = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every((item) => typeof item === 'string')
);

const isModelsDevModelEntry = (value: unknown): value is ModelsDevModelEntry => {
  if (!isRecord(value)) return false;
  const candidate = value as ModelsDevModelEntry;
  if (!candidate.modalities) return true;
  const { input, output } = candidate.modalities;
  return (!input || isStringArray(input)) && (!output || isStringArray(output));
};

const isModelsDevProviderEntry = (value: unknown): value is ModelsDevProviderEntry => {
  if (!isRecord(value)) return false;
  const candidate = value as ModelsDevProviderEntry;
  return candidate.models === undefined || isRecord(candidate.models);
};

const buildKey = (providerId: string, modelId: string): string => {
  const normalizedProvider = providerId?.toLowerCase?.() ?? '';
  if (!normalizedProvider || !modelId) return '';
  return `${normalizedProvider}/${modelId}`;
};

const mapModalities = (cap: CapabilitySet | undefined): string[] => {
  if (!cap) return [];
  const result: string[] = [];
  if (cap.text) result.push('text');
  if (cap.audio) result.push('audio');
  if (cap.image) result.push('image');
  if (cap.video) result.push('video');
  if (cap.pdf) result.push('pdf');
  return result;
};

const deriveModelMetadata = (providerId: string, model: ProviderModelLike): ModelMetadata => ({
  id: model.id,
  providerId,
  name: model.name,
  tool_call: model.capabilities?.toolcall,
  reasoning: model.capabilities?.reasoning,
  temperature: model.capabilities?.temperature,
  attachment: model.capabilities?.attachment,
  modalities: model.capabilities ? {
    input: mapModalities(model.capabilities.input),
    output: mapModalities(model.capabilities.output),
  } : undefined,
  cost: model.cost ? {
    input: model.cost.input,
    output: model.cost.output,
    cache_read: model.cost.cache?.read,
    cache_write: model.cost.cache?.write,
  } : undefined,
  limit: model.limit,
  release_date: model.release_date,
});

const transformModelsDevResponse = (payload: unknown): Map<string, ModelMetadata> => {
  const metadata = new Map<string, ModelMetadata>();
  if (!isRecord(payload)) return metadata;

  for (const [providerKey, providerValue] of Object.entries(payload)) {
    if (!isModelsDevProviderEntry(providerValue)) continue;
    const providerId = typeof providerValue.id === 'string' && providerValue.id.length > 0
      ? providerValue.id
      : providerKey;
    const models = providerValue.models;
    if (!models || !isRecord(models)) continue;

    for (const [modelKey, modelValue] of Object.entries(models)) {
      if (!isModelsDevModelEntry(modelValue)) continue;
      const modelId = modelKey || modelValue.id;
      if (!modelId) continue;
      const key = buildKey(providerId, modelId);
      if (!key) continue;
      metadata.set(key, {
        id: typeof modelValue.id === 'string' && modelValue.id.length > 0 ? modelValue.id : modelId,
        providerId,
        name: typeof modelValue.name === 'string' ? modelValue.name : undefined,
        tool_call: typeof modelValue.tool_call === 'boolean' ? modelValue.tool_call : undefined,
        reasoning: typeof modelValue.reasoning === 'boolean' ? modelValue.reasoning : undefined,
        temperature: typeof modelValue.temperature === 'boolean' ? modelValue.temperature : undefined,
        attachment: typeof modelValue.attachment === 'boolean' ? modelValue.attachment : undefined,
        structured_output: typeof modelValue.structured_output === 'boolean' ? modelValue.structured_output : undefined,
        modalities: modelValue.modalities ? {
          input: isStringArray(modelValue.modalities.input) ? modelValue.modalities.input : undefined,
          output: isStringArray(modelValue.modalities.output) ? modelValue.modalities.output : undefined,
        } : undefined,
        cost: modelValue.cost,
        limit: modelValue.limit,
        knowledge: typeof modelValue.knowledge === 'string' ? modelValue.knowledge : undefined,
        release_date: typeof modelValue.release_date === 'string' ? modelValue.release_date : undefined,
        last_updated: typeof modelValue.last_updated === 'string' ? modelValue.last_updated : undefined,
      });
    }
  }

  return metadata;
};

const fetchModelsDevMetadata = async (): Promise<Map<string, ModelMetadata>> => {
  if (typeof fetch !== 'function') return new Map();

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), 8000) : undefined;
  try {
    const response = await fetch(MODELS_DEV_API_URL, {
      signal: controller?.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      mode: 'cors',
    });
    if (!response.ok) {
      throw new Error(`Metadata request to ${MODELS_DEV_API_URL} returned status ${response.status}`);
    }
    return transformModelsDevResponse(await response.json());
  } catch (error: unknown) {
    if ((error as Error)?.name === 'AbortError') {
      console.warn(`Model metadata request aborted (${MODELS_DEV_API_URL})`);
    } else {
      console.warn(`Failed to fetch model metadata from ${MODELS_DEV_API_URL}:`, error);
    }
    return new Map();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

let inFlight: Promise<Map<string, ModelMetadata>> | null = null;

export const ensureModelMetadataLoaded = (
  getMetadata: () => Map<string, ModelMetadata>,
  setMetadata: (metadata: Map<string, ModelMetadata>) => void,
): void => {
  if (getMetadata().size > 0 || inFlight) return;
  markStartupTrace('modelsMetadata:queued');
  inFlight = measureStartupTrace('modelsMetadata', fetchModelsDevMetadata)
    .then((metadata) => {
      if (metadata.size > 0) {
        markStartupTrace('modelsMetadata:set', { entries: metadata.size });
        setMetadata(metadata);
      }
      return metadata;
    })
    .catch(() => new Map<string, ModelMetadata>())
    .finally(() => {
      inFlight = null;
    });
};

export const invalidateModelMetadataLoad = (): void => {
  inFlight = null;
};

export const resolveModelMetadata = (
  metadata: Map<string, ModelMetadata>,
  providerId: string,
  modelId: string,
  model?: ProviderModelLike,
): ModelMetadata | undefined => {
  const key = buildKey(providerId, modelId);
  if (!key) return undefined;
  return metadata.get(key) ?? (model ? deriveModelMetadata(providerId, model) : undefined);
};
