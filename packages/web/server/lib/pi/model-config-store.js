import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/;
const API_KEY_REFERENCE = /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
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

const cloneRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidModelConfig();
  return structuredClone(value);
};

const validateHeaderMap = (headers) => {
  if (headers === undefined) return undefined;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)
    || Object.entries(headers).some(([key, value]) => !key || key.length > 256 || typeof value !== 'string' || value.length > 8_192)) throw invalidModelConfig();
  return headers;
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
      ...(Number.isSafeInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
      ...(model.reasoning === true ? { supportsThinking: true } : {}),
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
    if (!model || typeof model !== 'object' || typeof model.id !== 'string' || model.id.trim().length === 0 || model.id.length > 512
      || (typeof model.label !== 'string' || model.label.trim().length === 0 || model.label.length > 512)
      || (model.contextWindow !== undefined && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0))
      || (model.supportsThinking !== undefined && typeof model.supportsThinking !== 'boolean')) throw invalidModelConfig();
    const id = model.id.trim();
    if (modelIds.has(id)) throw invalidModelConfig();
    modelIds.add(id);
    return {
      id,
      name: model.label.trim(),
      ...(Number.isSafeInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
      ...(model.supportsThinking === true ? { reasoning: true } : {}),
    };
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
    return publicProvider(providerId, config.providers[providerId]);
  };

  const update = async (input) => {
    const nextProvider = normalizeUpdate(input);
    const operation = writeChain.then(async () => {
      const config = await readConfig();
      const previous = config.providers[nextProvider.providerId];
      const provider = {
        ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
        name: nextProvider.name,
        baseUrl: nextProvider.baseUrl,
        api: nextProvider.api,
        models: nextProvider.models,
        ...(nextProvider.headers !== undefined ? { headers: nextProvider.headers } : {}),
        ...(nextProvider.apiKeyReference ? { apiKey: nextProvider.apiKeyReference } : {}),
      };
      config.providers[nextProvider.providerId] = provider;
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = join(dirname(file), `.${Date.now()}-${process.pid}-models.json.tmp`);
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file);
      return publicProvider(nextProvider.providerId, provider);
    });
    writeChain = operation.catch(() => {});
    return operation;
  };

  return { get, update };
};
