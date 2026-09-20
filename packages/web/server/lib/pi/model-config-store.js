import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { withCrossProcessLock } from '../server/cross-process-lock.js';
const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/;
const API_KEY_REFERENCE = /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
// Intentional four-API boundary: Pi's public models.json docs list exactly
// these four as safely representable custom APIs for manual models.
// Pi supports more internal transports, but manual additions stay within the
// documented set so unknown transports cannot be smuggled through.
const API_TYPES = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']);

// Pi accepts JSON-with-comments for models.json. Strip comments without
// touching quoted URL/header values before parsing the editable snapshot.
const stripJsonComments = (source) => {
  let output = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = '';
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      output += current;
      continue;
    }
    if (current === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    output += current;
  }
  return output;
};

const invalidModelConfig = () => {
  const error = new Error('Pi models configuration is invalid.');
  error.code = 'PI_MODEL_CONFIG_INVALID';
  return error;
};

const duplicateModelError = () => {
  const error = new Error('The model already exists for this provider.');
  error.code = 'PI_MODEL_DUPLICATE';
  return error;
};

const THINKING_LEVEL_KEYS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_MODEL_HEADERS = 50;

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const hasUnsafeKey = (value) => isPlainObject(value) && Object.keys(value).some((key) => UNSAFE_KEYS.has(key));

const validateThinkingLevelMap = (value) => {
  if (!isPlainObject(value) || hasUnsafeKey(value)) throw invalidModelConfig();
  const entries = Object.entries(value);
  if (entries.length > THINKING_LEVEL_KEYS.size) throw invalidModelConfig();
  for (const [key, mapped] of entries) {
    if (!THINKING_LEVEL_KEYS.has(key) || (mapped !== null && (typeof mapped !== 'string' || mapped.length > 512))) throw invalidModelConfig();
  }
  return structuredClone(value);
};

const validateInputModalities = (value) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) throw invalidModelConfig();
  const unique = new Set(value);
  if (unique.size !== value.length || [...unique].some((entry) => entry !== 'text' && entry !== 'image')) throw invalidModelConfig();
  return [...value];
};

const cloneRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidModelConfig();
  return structuredClone(value);
};

const validateHeaderMap = (headers) => {
  if (headers === undefined) return undefined;
  if (!isPlainObject(headers) || hasUnsafeKey(headers)) throw invalidModelConfig();
  const entries = Object.entries(headers);
  if (entries.length > MAX_MODEL_HEADERS) throw invalidModelConfig();
  if (entries.some(([key, value]) => !key || key.length > 256 || typeof value !== 'string' || value.length > 8_192)) throw invalidModelConfig();
  return structuredClone(headers);
};

const publicProvider = (providerId, value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidModelConfig();
  if (!Array.isArray(value.models)) return null;
  const models = value.models.map((model) => {
    if (!model || typeof model !== 'object' || typeof model.id !== 'string' || model.id.length === 0) throw invalidModelConfig();
    return {
      id: model.id,
      providerId,
      ...(typeof model.name === 'string' ? { label: model.name } : {}),
      ...(model.reasoning === true ? { supportsThinking: true } : {}),
      ...(isPlainObject(model.thinkingLevelMap) ? { thinkingLevelMap: structuredClone(model.thinkingLevelMap) } : {}),
      ...(Array.isArray(model.input) ? { input: structuredClone(model.input) } : {}),
      ...(Number.isSafeInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
      ...(Number.isSafeInteger(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
    };
  });
  return {
    providerId,
    ...(typeof value.name === 'string' ? { label: value.name } : {}),
    ...(typeof value.baseUrl === 'string' ? { baseUrl: value.baseUrl } : {}),
    ...(typeof value.api === 'string' ? { api: value.api } : {}),
    models,
  };
};

const normalizeUpdate = (input) => {
  if (!input || typeof input !== 'object' || typeof input.providerId !== 'string' || !PROVIDER_ID.test(input.providerId)
    || typeof input.label !== 'string' || input.label.trim().length === 0 || input.label.length > 256
    || typeof input.baseUrl !== 'string' || !/^https?:\/\//.test(input.baseUrl) || input.baseUrl.length > 8_192
    || !API_TYPES.has(input.api ?? 'openai-completions') || !Array.isArray(input.models) || input.models.length === 0 || input.models.length > 256
    || (input.apiKeyReference !== undefined && (typeof input.apiKeyReference !== 'string' || !API_KEY_REFERENCE.test(input.apiKeyReference)))) throw invalidModelConfig();
  const modelIds = new Set();
  const models = input.models.map((model) => {
    const normalized = normalizeAddModel({ providerId: input.providerId, model }).model;
    if (modelIds.has(normalized.id)) throw invalidModelConfig();
    modelIds.add(normalized.id);
    return normalized;
  });
  return {
    providerId: input.providerId,
    name: input.label.trim(),
    baseUrl: input.baseUrl.trim(),
    api: input.api ?? 'openai-completions',
    models,
    ...(input.headers !== undefined ? { headers: validateHeaderMap(input.headers) } : {}),
    ...(input.apiKeyReference ? { apiKeyReference: input.apiKeyReference } : {}),
  };
};

const normalizeAddModel = (input) => {
  if (!input || typeof input !== 'object' || typeof input.providerId !== 'string' || !PROVIDER_ID.test(input.providerId)) throw invalidModelConfig();
  const model = input.model;
  if (!isPlainObject(model) || typeof model.id !== 'string' || model.id.trim().length === 0 || model.id.length > 512) throw invalidModelConfig();
  if (model.name !== undefined && (typeof model.name !== 'string' || model.name.trim().length === 0 || model.name.length > 512)) throw invalidModelConfig();
  if (model.reasoning !== undefined && typeof model.reasoning !== 'boolean') throw invalidModelConfig();
  if (model.contextWindow !== undefined && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0)) throw invalidModelConfig();
  if (model.maxTokens !== undefined && (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0)) throw invalidModelConfig();

  const thinkingLevelMap = model.thinkingLevelMap === undefined
    ? undefined
    : validateThinkingLevelMap(model.thinkingLevelMap);
  const normalizedModel = {
    id: model.id.trim(),
    ...(model.name !== undefined ? { name: model.name.trim() } : {}),
    ...(model.reasoning === true ? { reasoning: true } : {}),
    ...(thinkingLevelMap && Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
    ...(model.input !== undefined ? { input: validateInputModalities(model.input) } : {}),
    ...(Number.isSafeInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
    ...(Number.isSafeInteger(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
  };
  let seed;
  if (input.seed !== undefined) {
    const candidate = input.seed;
    if (!isPlainObject(candidate) || typeof candidate.label !== 'string' || candidate.label.trim().length === 0 || candidate.label.length > 256
      || typeof candidate.baseUrl !== 'string' || !/^https?:\/\//.test(candidate.baseUrl) || candidate.baseUrl.length > 8_192
      || !API_TYPES.has(candidate.api)) throw invalidModelConfig();
    seed = { name: candidate.label.trim(), baseUrl: candidate.baseUrl.trim(), api: candidate.api };
  }
  return { providerId: input.providerId, model: normalizedModel, ...(seed ? { seed } : {}) };
};

/**
 * Owns atomic updates to Pi's credential-blind models.json. Credentials are
 * deliberately excluded: literal keys use Pi's auth flow, and only validated
 * `{env:NAME}` references may be persisted with a provider configuration.
 */
export const createPiModelConfigStore = ({ file }) => {
  if (typeof file !== 'string' || file.length === 0) throw invalidModelConfig();
  let writeChain = Promise.resolve();

  const readConfig = async () => {
    try {
      const parsed = JSON.parse(stripJsonComments(await readFile(file, 'utf8')));
      const config = cloneRecord(parsed);
      if (!config.providers || typeof config.providers !== 'object' || Array.isArray(config.providers)) throw invalidModelConfig();
      return config;
    } catch (error) {
      if (error?.code === 'ENOENT') return { providers: {} };
      if (error?.code === 'PI_MODEL_CONFIG_INVALID') throw error;
      throw invalidModelConfig();
    }
  };

  const get = async (providerId) => {
    if (typeof providerId !== 'string' || !PROVIDER_ID.test(providerId)) throw invalidModelConfig();
    const config = await readConfig();
    if (!Object.hasOwn(config.providers, providerId)) return null;
    return publicProvider(providerId, config.providers[providerId]);
  };

  const update = async (input) => {
    const nextProvider = normalizeUpdate(input);
    // models.json lives under the shared Pi agent directory, so concurrent
    // daemons serialize here rather than in-process only.
    const operation = writeChain.then(() => withCrossProcessLock(`${file}.lock`, async () => {
      const config = await readConfig();
      const previous = config.providers[nextProvider.providerId];
      const previousModels = previous && typeof previous === 'object' && !Array.isArray(previous) && Array.isArray(previous.models)
        ? new Map(previous.models.filter((model) => model && typeof model === 'object' && typeof model.id === 'string').map((model) => [model.id, model]))
        : new Map();
      // The UI edits only supported fields. Preserve every unexposed field on
      // existing models so credential-blind edits do not erase Pi metadata.
      const models = nextProvider.models.map((model) => {
        const prior = previousModels.get(model.id);
        if (!isPlainObject(prior)) return model;
        const { id, name, reasoning, thinkingLevelMap, input, contextWindow, maxTokens, ...unexposed } = prior;
        return { ...unexposed, ...model };
      });
      const provider = {
        ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
        name: nextProvider.name,
        baseUrl: nextProvider.baseUrl,
        api: nextProvider.api,
        models,
        ...(nextProvider.headers !== undefined ? { headers: nextProvider.headers } : {}),
        ...(nextProvider.apiKeyReference ? { apiKey: nextProvider.apiKeyReference } : {}),
      };
      config.providers[nextProvider.providerId] = provider;
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = join(dirname(file), `.${Date.now()}-${process.pid}-models.json.tmp`);
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file);
      return publicProvider(nextProvider.providerId, provider);
    }));
    writeChain = operation.catch(() => {});
    return operation;
  };

  const addModel = async (input) => {
    const next = normalizeAddModel(input);
    // Same cross-process serialization as update: models.json is shared
    // across daemons, and the append must not lose concurrent writers.
    const operation = writeChain.then(() => withCrossProcessLock(`${file}.lock`, async () => {
      const config = await readConfig();
      const previous = config.providers[next.providerId];
      if (previous !== undefined && (typeof previous !== 'object' || Array.isArray(previous))) throw invalidModelConfig();
      if (previous !== undefined && !Array.isArray(previous.models)) throw invalidModelConfig();
      if (Array.isArray(previous?.models)) {
        const seen = new Set();
        for (const entry of previous.models) {
          if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') throw invalidModelConfig();
          seen.add(entry.id.trim());
        }
        if (seen.has(next.model.id)) throw duplicateModelError();
        const provider = {
          ...previous,
          models: [...previous.models, next.model],
        };
        config.providers[next.providerId] = provider;
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = join(dirname(file), `.${Date.now()}-${process.pid}-models.json.tmp`);
        await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, file);
        return publicProvider(next.providerId, provider);
      }
      if (!next.seed) throw invalidModelConfig();
      const provider = {
        name: next.seed.name,
        baseUrl: next.seed.baseUrl,
        api: next.seed.api,
        models: [next.model],
      };
      config.providers[next.providerId] = provider;
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = join(dirname(file), `.${Date.now()}-${process.pid}-models.json.tmp`);
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file);
      return publicProvider(next.providerId, provider);
    }));
    writeChain = operation.catch(() => {});
    return operation;
  };

  return { get, update, addModel };
};
