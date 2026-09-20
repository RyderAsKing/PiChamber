/**
 * Custom provider form helpers. Validates and constructs Pi-native provider
 * requests so providers and their models can be defined from Settings.
 */

import {
  validateAddProviderModel,
  type AddProviderModelFieldErrors,
  type AddProviderModelFormInput,
  type AddProviderModelPayload,
} from './add-provider-model';

export const CUSTOM_PROVIDER_NPM = '@ai-sdk/openai-compatible';
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
export const BASE_URL_PATTERN = /^https?:\/\//;
export const ENV_KEY_PATTERN = /^\{env:([^}]+)\}$/;

export const CUSTOM_PROVIDER_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const;
export type CustomProviderApi = typeof CUSTOM_PROVIDER_APIS[number];

export function isCustomProviderApi(value: string): value is CustomProviderApi {
  return CUSTOM_PROVIDER_APIS.some((api) => api === value);
}

export type ModelRow = AddProviderModelFormInput & {
  row: string;
  advancedOpen: boolean;
};

export type HeaderRow = {
  row: string;
  key: string;
  value: string;
};

export type CustomProviderFormState = {
  providerID: string;
  name: string;
  baseURL: string;
  api: CustomProviderApi;
  apiKey: string;
  models: ModelRow[];
  headers: HeaderRow[];
};

export type FieldErrors = {
  providerID?: string;
  name?: string;
  baseURL?: string;
  apiKey?: string;
};

export type ModelFieldErrors = AddProviderModelFieldErrors;

export type HeaderFieldErrors = {
  key?: string;
  value?: string;
};

export type CustomProviderConfig = {
  npm: typeof CUSTOM_PROVIDER_NPM;
  name: string;
  api: CustomProviderApi;
  env?: string[];
  options: {
    baseURL: string;
    headers?: Record<string, string>;
  };
  models: Record<string, AddProviderModelPayload>;
};

export type CustomProviderPersistPlan = {
  providerID: string;
  name: string;
  /** Literal API key to send via auth.set; omitted when using {env:VAR} or empty. */
  apiKey?: string;
  config: CustomProviderConfig;
};

export type ValidateCustomProviderInput = {
  form: CustomProviderFormState;
  existingProviderIDs: ReadonlySet<string>;
  disabledProviders?: readonly string[];
  /** When editing this provider id, treat it as an allowed update target. */
  editingProviderID?: string;
  /**
   * When true, empty apiKey is allowed because auth.json already has a credential
   * (edit path). Still requires env or key when false.
   */
  allowExistingAuth?: boolean;
};

export type ValidateCustomProviderResult = {
  err: FieldErrors;
  models: ModelFieldErrors[];
  headers: HeaderFieldErrors[];
  result?: CustomProviderPersistPlan;
};

export type ProviderLikeForCustomForm = {
  id: string;
  name?: string;
  env?: string[];
  options?: Record<string, unknown> | null;
  api?: string;
  models?: Array<{
    id?: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    supportsThinking?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
    input?: Array<'text' | 'image'>;
  }> | Record<string, unknown>;
};

let rowCounter = 0;

const nextRow = (): string => `row-${rowCounter++}`;

export const createModelRow = (): ModelRow => ({
  row: nextRow(),
  advancedOpen: false,
  modelId: '',
  displayName: '',
  contextWindowText: '',
  maxTokensText: '',
  inputText: false,
  inputImage: false,
  supportsThinking: false,
  thinkingLevelMapText: '',
});

export const createHeaderRow = (): HeaderRow => ({
  row: nextRow(),
  key: '',
  value: '',
});

export const createEmptyCustomProviderForm = (): CustomProviderFormState => ({
  providerID: '',
  name: '',
  baseURL: '',
  api: 'openai-completions',
  apiKey: '',
  models: [createModelRow()],
  headers: [createHeaderRow()],
});

export function parseEnvApiKey(apiKey: string): { env?: string; key?: string } {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return {};
  }
  const envMatch = trimmed.match(ENV_KEY_PATTERN);
  const env = envMatch?.[1]?.trim();
  if (env) {
    return { env };
  }
  return { key: trimmed };
}

export function isCustomOpenAICompatibleProvider(provider: ProviderLikeForCustomForm): boolean {
  const options = provider.options && typeof provider.options === 'object' ? provider.options : null;
  const baseURL = typeof options?.baseURL === 'string' ? options.baseURL.trim() : '';
  if (baseURL && BASE_URL_PATTERN.test(baseURL)) {
    return true;
  }

  const models = Array.isArray(provider.models)
    ? provider.models
    : (provider.models && typeof provider.models === 'object'
      ? Object.values(provider.models)
      : []);

  return models.some((model) => {
    if (!model || typeof model !== 'object') {
      return false;
    }
    const api = 'api' in model && model.api && typeof model.api === 'object'
      ? model.api as { npm?: unknown }
      : null;
    return typeof api?.npm === 'string' && api.npm === CUSTOM_PROVIDER_NPM;
  });
}

export type ProviderConfigSourcesLike = {
  user?: { exists?: boolean };
  project?: { exists?: boolean };
  custom?: { exists?: boolean };
};

export type ProviderConfigScope = 'user' | 'project' | 'custom';

/**
 * True when a provider both looks OpenAI-compatible-custom and is defined in a
 * user/project/custom Pi configuration layer. Catalog-only providers often share
 * the same npm/baseURL signals and must not get Edit / config overrides.
 */
export function isConfigDefinedCustomProvider(
  provider: ProviderLikeForCustomForm,
  sources: ProviderConfigSourcesLike | null | undefined,
): boolean {
  if (!sources) {
    return false;
  }
  const inConfigLayer = Boolean(
    sources.user?.exists || sources.project?.exists || sources.custom?.exists,
  );
  return inConfigLayer && isCustomOpenAICompatibleProvider(provider);
}

/**
 * Effective writable configuration layer for a provider, matching Pi merge
 * precedence: custom > project > user.
 */
export function resolveProviderConfigScope(
  sources: ProviderConfigSourcesLike | null | undefined,
): ProviderConfigScope {
  if (sources?.custom?.exists) {
    return 'custom';
  }
  if (sources?.project?.exists) {
    return 'project';
  }
  return 'user';
}

export function providerToCustomFormState(provider: ProviderLikeForCustomForm): CustomProviderFormState {
  const options = provider.options && typeof provider.options === 'object' ? provider.options : {};
  const baseURL = typeof options.baseURL === 'string' ? options.baseURL : '';
  const headersRaw = options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)
    ? options.headers as Record<string, unknown>
    : {};
  const headerRows = Object.entries(headersRaw)
    .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
    .map(([key, value]) => ({ row: nextRow(), key, value }));

  const modelEntries = Array.isArray(provider.models)
    ? provider.models
    : (provider.models && typeof provider.models === 'object'
      ? Object.entries(provider.models).map(([id, value]) => ({
          id,
          name: value && typeof value === 'object' && 'name' in value && typeof (value as { name?: unknown }).name === 'string'
            ? (value as { name: string }).name
            : id,
        }))
      : []);

  const models = modelEntries.length > 0
    ? modelEntries.map((model) => ({
        ...createModelRow(),
        modelId: typeof model?.id === 'string' ? model.id : '',
        displayName: typeof model?.name === 'string' ? model.name : '',
        contextWindowText: model && 'contextWindow' in model && typeof model.contextWindow === 'number' ? String(model.contextWindow) : '',
        maxTokensText: model && 'maxTokens' in model && typeof model.maxTokens === 'number' ? String(model.maxTokens) : '',
        inputText: Boolean(model && 'input' in model && Array.isArray(model.input) && model.input.includes('text')),
        inputImage: Boolean(model && 'input' in model && Array.isArray(model.input) && model.input.includes('image')),
        supportsThinking: Boolean(model && (
          ('supportsThinking' in model && model.supportsThinking === true)
          || ('reasoning' in model && model.reasoning === true)
        )),
        thinkingLevelMapText: model && 'thinkingLevelMap' in model && model.thinkingLevelMap
          ? Object.entries(model.thinkingLevelMap)
              .map(([key, value]) => `${key}=${value === null ? 'null' : JSON.stringify(value)}`)
              .join('\n')
          : '',
      }))
    : [createModelRow()];

  const envName = Array.isArray(provider.env)
    ? provider.env.find((entry) => typeof entry === 'string' && entry.trim().length > 0)?.trim()
    : undefined;

  const api = typeof provider.api === 'string' && isCustomProviderApi(provider.api)
    ? provider.api
    : 'openai-completions';

  return {
    providerID: provider.id,
    name: typeof provider.name === 'string' && provider.name.trim() ? provider.name : provider.id,
    baseURL,
    api,
    apiKey: envName ? `{env:${envName}}` : '',
    models,
    headers: headerRows.length > 0 ? headerRows : [createHeaderRow()],
  };
}

/**
 * Validates form input and builds Pi auth and provider configuration payloads.
 */
export function validateCustomProvider(input: ValidateCustomProviderInput): ValidateCustomProviderResult {
  const providerID = input.form.providerID.trim();
  const name = input.form.name.trim();
  const baseURL = input.form.baseURL.trim();
  const { env, key } = parseEnvApiKey(input.form.apiKey);
  const disabledProviders = input.disabledProviders ?? [];
  const editingProviderID = input.editingProviderID?.trim();

  const idError = !providerID
    ? "Provider ID is required"
    : !PROVIDER_ID_PATTERN.test(providerID)
      ? "Use lowercase letters, numbers, hyphens, or underscores"
      : undefined;

  const nameError = !name
    ? "Display name is required"
    : undefined;

  const urlError = !baseURL
    ? "Base URL is required"
    : !BASE_URL_PATTERN.test(baseURL)
      ? "Base URL must start with http:// or https://"
      : undefined;

  const credentialsSatisfied = Boolean(env || key || (editingProviderID && input.allowExistingAuth && editingProviderID === providerID));
  const apiKeyError = credentialsSatisfied
    ? undefined
    : "API key or {env:VAR_NAME} is required";

  const disabled = disabledProviders.includes(providerID);
  const isSelfEdit = Boolean(editingProviderID && editingProviderID === providerID);
  const existsError = idError || isSelfEdit
    ? undefined
    : input.existingProviderIDs.has(providerID) && !disabled
      ? "A provider with this ID is already connected"
      : undefined;

  const seenModels = new Set<string>();
  const validatedModels = input.form.models.map((model) => {
    const validated = validateAddProviderModel(model);
    const id = model.modelId.trim();
    if (id && seenModels.has(id)) {
      return { errors: { ...validated.errors, modelId: 'Duplicate' } };
    }
    if (id) seenModels.add(id);
    return validated;
  });
  const modelErrors = validatedModels.map((entry) => entry.errors);
  const modelsValid = validatedModels.every((entry) => entry.result !== undefined);
  const modelConfig = Object.fromEntries(
    validatedModels.flatMap((entry) => entry.result ? [[entry.result.id, entry.result]] : []),
  );

  const seenHeaders = new Set<string>();
  const headerErrors = input.form.headers.map((header) => {
    const headerKey = header.key.trim();
    const headerValue = header.value.trim();
    if (!headerKey && !headerValue) {
      return {};
    }
    const keyError = !headerKey
      ? "Required"
      : seenHeaders.has(headerKey.toLowerCase())
        ? "Duplicate"
        : (() => {
            seenHeaders.add(headerKey.toLowerCase());
            return undefined;
          })();
    const valueError = !headerValue
      ? "Required"
      : undefined;
    return { key: keyError, value: valueError };
  });

  const headersValid = headerErrors.every((entry) => !entry.key && !entry.value);
  const headerConfig = Object.fromEntries(
    input.form.headers
      .map((header) => ({ key: header.key.trim(), value: header.value.trim() }))
      .filter((header) => header.key && header.value)
      .map((header) => [header.key, header.value]),
  );

  const err: FieldErrors = {
    providerID: idError ?? existsError,
    name: nameError,
    baseURL: urlError,
    apiKey: apiKeyError,
  };

  const ok = !idError && !existsError && !nameError && !urlError && !apiKeyError && modelsValid && headersValid;
  if (!ok) {
    return { err, models: modelErrors, headers: headerErrors };
  }

  return {
    err,
    models: modelErrors,
    headers: headerErrors,
    result: {
      providerID,
      name,
      apiKey: key,
      config: {
        npm: CUSTOM_PROVIDER_NPM,
        name,
        api: input.form.api,
        ...(env ? { env: [env] } : {}),
        options: {
          baseURL,
          ...(Object.keys(headerConfig).length > 0 ? { headers: headerConfig } : {}),
        },
        models: modelConfig,
      },
    },
  };
}

/**
 * Builds the Pi auth request body when a literal API key is present.
 */
export function buildAuthSetRequest(plan: CustomProviderPersistPlan): {
  providerID: string;
  auth: { type: 'api'; key: string };
} | null {
  if (!plan.apiKey) {
    return null;
  }
  return {
    providerID: plan.providerID,
    auth: { type: 'api', key: plan.apiKey },
  };
}

/**
 * Builds the PiChamber provider upsert request body (config persistence).
 * `scope` selects the Pi configuration layer (user/project/custom). Create
 * defaults to user; edit must pass the provider's effective existing layer.
 */
export function buildProviderUpsertRequest(
  plan: CustomProviderPersistPlan,
  options?: { scope?: ProviderConfigScope },
): {
  providerID: string;
  config: CustomProviderConfig;
  scope: ProviderConfigScope;
} {
  return {
    providerID: plan.providerID,
    config: plan.config,
    scope: options?.scope ?? 'user',
  };
}
