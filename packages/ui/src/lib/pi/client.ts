/**
 * Pi service facade for the shared UI.
 *
 * The facade wraps the public `/api/pi/` API contract. It is the only place
 * UI code calls into; lower-level transport helpers live next to it but are
 * not imported directly by consumers.
 *
 * The contract intentionally exposes only Pi-native operations:
 *
 * - Sessions, messages, and parts come from a small set of typed RPCs.
 * - Provider, resource, and attachment calls return `null`/throw on failure
 *   so the caller can distinguish fetch failure from authoritative empty.
 * - Streamed mutations flow through the event stream, not service calls.
 *
 * The facade is a plain class so consumers can use one per directory
 * A `piClient` singleton
 * is exported for global, non-directory-scoped calls.
 */

import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  type PiError,
  type PiProviderListResponse,
  type PiProviderLoginInput,
  type PiProviderLoginResponse,
  type PiProviderLogoutInput,
  type PiSettingsSnapshot,
  type PiSettingsUpdateInput,
  type PiChamberDefaultsUpdateInput,
  type PiProviderSetModelsInput,
  type PiProviderConfigResponse,
  type PiProviderStatusResponse,
  type PiResourceListResponse,
  type PiResourceUpdateInput,
  type PiPromptTemplateCreateInput,
  type PiRuntimeHealth,
  type PiProjectListResponse,
  type PiProjectSelectResponse,
  type PiSessionCreateInput,
  type PiSessionDetailResponse,
  type PiSessionListResponse,
  type PiSessionTreeResponse,
  type PiAttachmentCreateInput,
  type PiAttachmentCreateResponse,
  type PiPromptInput,
  type PiPromptResult,
  type PiSetModelInput,
  type PiSetThinkingInput,
  type PiCompactInput,
  type PiForkInput,
  type PiCloneInput,
  type PiRenameInput,
  type PiDeleteInput,
  type PiArchiveInput,
  type PiAbortInput,
} from './protocol';
import type {
  PiAttachment,
  PiModelRef,
  PiSessionId,
  PiThinkingLevel,
} from './types';
import { fetchPiRuntimeHealth } from './transport';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TRANSIENT_RETRIES = 1;
const TRANSIENT_RETRY_DELAY_MS = 300;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface JsonRequestInit<TBody> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: TBody;
  query?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
  runtimeKey?: string;
}

const jsonRequest = async <TBody, TResponse>(
  path: string,
  init: JsonRequestInit<TBody>,
): Promise<TResponse> => {
  const requestRuntimeKey = init.runtimeKey;
  if (requestRuntimeKey && requestRuntimeKey !== getRuntimeKey()) {
    throw new PiRequestError('DAEMON_UNAVAILABLE', 'Runtime changed during request');
  }
  const query = init.query
    ? `?${new URLSearchParams(
        Object.entries(init.query).map(([key, value]) => [key, String(value)]),
      ).toString()}`
    : '';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
    if (attempt > 0) {
      if (init.signal?.aborted) break;
      if (requestRuntimeKey && requestRuntimeKey !== getRuntimeKey()) {
        throw new PiRequestError('DAEMON_UNAVAILABLE', 'Runtime changed during request');
      }
      await wait(TRANSIENT_RETRY_DELAY_MS);
      if (init.signal?.aborted) break;
      if (requestRuntimeKey && requestRuntimeKey !== getRuntimeKey()) {
        throw new PiRequestError('DAEMON_UNAVAILABLE', 'Runtime changed during request');
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
    const externalSignal = init.signal;
    const onAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const response = await runtimeFetch(path + query, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as { error?: PiError } | null;
        const error: PiError = errorBody?.error ?? { code: 'DAEMON_REQUEST_FAILED' };
        const isTransient = response.status === 503 && (error.code === 'DAEMON_UNAVAILABLE' || error.code === 'DAEMON_TIMEOUT');
        if (isTransient && attempt < MAX_TRANSIENT_RETRIES && !externalSignal?.aborted) {
          lastError = new PiRequestError(error.code, error.message, response.status);
          continue;
        }
        throw new PiRequestError(error.code, error.message, response.status);
      }
      if (response.status === 204) {
        if (requestRuntimeKey && requestRuntimeKey !== getRuntimeKey()) {
          throw new PiRequestError('DAEMON_UNAVAILABLE', 'Runtime changed during request');
        }
        return undefined as TResponse;
      }
      const result = (await response.json()) as TResponse;
      if (requestRuntimeKey && requestRuntimeKey !== getRuntimeKey()) {
        throw new PiRequestError('DAEMON_UNAVAILABLE', 'Runtime changed during request');
      }
      return result;
    } catch (err) {
      lastError = err;
      if (err instanceof PiRequestError) {
        throw err;
      }
      const isAbort = externalSignal?.aborted || (err instanceof DOMException && err.name === 'AbortError');
      if (isAbort) {
        throw err;
      }
      if (attempt < MAX_TRANSIENT_RETRIES && !externalSignal?.aborted) {
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onAbort);
      }
    }
  }

  throw lastError;
};

export class PiRequestError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message?: string, status?: number) {
    super(message ?? `Pi request failed: ${code}`);
    this.name = 'PiRequestError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** Per-call directory scope. */
export interface PiClientScope {
  /** Canonical directory the session belongs to. */
  directory?: string;
  /** Runtime key captured at call time so a runtime switch can reject stale work. */
  runtimeKey?: string;
}

const assertRuntimeUnchanged = (scope?: PiClientScope): void => {
  if (!scope?.runtimeKey) return;
  if (scope.runtimeKey !== getRuntimeKey()) {
    throw new PiRequestError('DAEMON_UNAVAILABLE', 'Runtime changed during request');
  }
};

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class PiService {
  private currentDirectory: string | undefined;

  /** Set the directory context for non-scoped calls. */
  setDirectory(directory: string | undefined): void {
    this.currentDirectory = directory;
  }

  getDirectory(): string | undefined {
    return this.currentDirectory;
  }

  /** Runtime health — ready vs unavailable, never a synthetic idle state. */
  async health(scope?: PiClientScope): Promise<PiRuntimeHealth> {
    assertRuntimeUnchanged(scope);
    const health = await fetchPiRuntimeHealth(undefined, scope?.runtimeKey);
    if (health.state === 'ready') {
      return {
        protocolVersion: health.protocolVersion,
        state: 'ready',
        capabilities: health.capabilities,
      };
    }
    return {
      protocolVersion: health.protocolVersion,
      state: 'unavailable',
      capabilities: health.capabilities,
      ...(health.error ? { error: health.error as PiError } : {}),
    };
  }

  // ----- Projects ---------------------------------------------------------

  async listProjects(scope?: PiClientScope): Promise<PiProjectListResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<undefined, PiProjectListResponse>('/api/pi/projects', {
      method: 'GET',
      ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
    });
  }

  async selectProject(directory: string, scope?: PiClientScope): Promise<PiProjectSelectResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<{ directory: string }, PiProjectSelectResponse>('/api/pi/projects/select', {
      method: 'POST',
      body: { directory },
      ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
    });
  }

  // ----- Sessions ---------------------------------------------------------

  async listSessions(scope?: PiClientScope): Promise<PiSessionListResponse> {
    assertRuntimeUnchanged(scope);
    const directory = scope?.directory ?? this.currentDirectory;
    return jsonRequest<undefined, PiSessionListResponse>('/api/pi/sessions', {
      method: 'GET',
      ...(directory ? { query: { directory } } : {}),
      ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
    });
  }

  async createSession(input: PiSessionCreateInput, scope?: PiClientScope): Promise<PiSessionDetailResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<PiSessionCreateInput, PiSessionDetailResponse>('/api/pi/sessions', {
      method: 'POST',
      body: input,
      ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
    });
  }

  async getSession(sessionId: PiSessionId, scope?: PiClientScope): Promise<PiSessionDetailResponse> {
    assertRuntimeUnchanged(scope);
    const directory = scope?.directory ?? this.currentDirectory;
    return jsonRequest<undefined, PiSessionDetailResponse>(
      `/api/pi/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'GET',
        ...(directory ? { query: { directory } } : {}),
        ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
      },
    );
  }

  async renameSession(input: PiRenameInput, scope?: PiClientScope): Promise<void> {
    assertRuntimeUnchanged(scope);
    await jsonRequest<{ title: string; sessionId: PiSessionId }, undefined>(
      `/api/pi/sessions/${encodeURIComponent(input.sessionId)}`,
      {
        method: 'PATCH',
        body: { sessionId: input.sessionId, title: input.title },
        ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
      },
    );
  }

  async deleteSession(input: PiDeleteInput, scope?: PiClientScope): Promise<boolean> {
    assertRuntimeUnchanged(scope);
    try {
      await jsonRequest<undefined, undefined>(
        `/api/pi/sessions/${encodeURIComponent(input.sessionId)}`,
        { method: 'DELETE', ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
      );
      return true;
    } catch (error) {
      if (error instanceof PiRequestError && error.status === 404) {
        // Already deleted is success.
        return true;
      }
      throw error;
    }
  }

  async archiveSession(input: PiArchiveInput, scope?: PiClientScope): Promise<void> {
    assertRuntimeUnchanged(scope);
    await jsonRequest<{ sessionId: PiSessionId; archived: boolean }, undefined>(
      `/api/pi/sessions/${encodeURIComponent(input.sessionId)}/archive`,
      {
        method: 'POST',
        body: { sessionId: input.sessionId, archived: input.archived },
        ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
      },
    );
  }

  async getSessionTree(sessionId: PiSessionId, scope?: PiClientScope): Promise<PiSessionTreeResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<undefined, PiSessionTreeResponse>(
      `/api/pi/sessions/${encodeURIComponent(sessionId)}/tree`,
      { method: 'GET', ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async navigateSession(
    sessionId: PiSessionId,
    messageId: string,
    scope?: PiClientScope,
  ): Promise<PiSessionDetailResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<{ messageId: string }, PiSessionDetailResponse>(
      `/api/pi/sessions/${encodeURIComponent(sessionId)}/navigate`,
      { method: 'POST', body: { messageId }, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async forkSession(input: PiForkInput, scope?: PiClientScope): Promise<PiSessionDetailResponse> {
    assertRuntimeUnchanged(scope);
    // The daemon protocol nests the message id under the request; we keep
    // the wire body aligned with the daemon IPC.
    return jsonRequest<{ sessionId: PiSessionId; messageId?: string }, PiSessionDetailResponse>(
      `/api/pi/sessions/${encodeURIComponent(input.sessionId)}/fork`,
      {
        method: 'POST',
        body: {
          sessionId: input.sessionId,
          ...(input.messageId ? { messageId: input.messageId } : {}),
        },
        ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
      },
    );
  }

  async cloneSession(input: PiCloneInput, scope?: PiClientScope): Promise<PiSessionDetailResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<PiCloneInput, PiSessionDetailResponse>(
      `/api/pi/sessions/${encodeURIComponent(input.sessionId)}/clone`,
      { method: 'POST', body: input, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  // ----- Session operations ----------------------------------------------

  async sendPrompt(input: PiPromptInput, scope?: PiClientScope): Promise<PiPromptResult> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<PiPromptInput, PiPromptResult>(
      `/api/pi/sessions/${encodeURIComponent(input.sessionId)}/prompt`,
      { method: 'POST', body: input, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async sendSteer(input: PiPromptInput, scope?: PiClientScope): Promise<PiPromptResult> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<PiPromptInput, PiPromptResult>(
      `/api/pi/sessions/${encodeURIComponent(input.sessionId)}/steer`,
      { method: 'POST', body: input, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async sendFollowUp(input: PiPromptInput, scope?: PiClientScope): Promise<PiPromptResult> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<PiPromptInput, PiPromptResult>(
      `/api/pi/sessions/${encodeURIComponent(input.sessionId)}/follow-up`,
      { method: 'POST', body: input, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async abortSession(input: PiAbortInput, scope?: PiClientScope): Promise<void> {
    assertRuntimeUnchanged(scope);
    await jsonRequest<undefined, undefined>(
      `/api/pi/sessions/${encodeURIComponent(input.sessionId)}/abort`,
      { method: 'POST', ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async setSessionModel(input: PiSetModelInput, scope?: PiClientScope): Promise<void> {
    assertRuntimeUnchanged(scope);
    await jsonRequest<{ sessionId: PiSessionId; model: PiModelRef }, undefined>(
      `/api/pi/sessions/${encodeURIComponent(input.sessionId)}/model`,
      { method: 'POST', body: { sessionId: input.sessionId, model: input.model }, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async setSessionThinking(input: PiSetThinkingInput, scope?: PiClientScope): Promise<void> {
    assertRuntimeUnchanged(scope);
    await jsonRequest<{ sessionId: PiSessionId; thinking: PiThinkingLevel }, undefined>(
      `/api/pi/sessions/${encodeURIComponent(input.sessionId)}/thinking`,
      { method: 'POST', body: { sessionId: input.sessionId, thinking: input.thinking }, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async compactSession(input: PiCompactInput, scope?: PiClientScope): Promise<void> {
    assertRuntimeUnchanged(scope);
    await jsonRequest<PiCompactInput, undefined>(
      `/api/pi/sessions/${encodeURIComponent(input.sessionId)}/compact`,
      { method: 'POST', body: input, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  // ----- Providers --------------------------------------------------------

  async listProviders(scope?: PiClientScope): Promise<PiProviderListResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<undefined, PiProviderListResponse>('/api/pi/providers', { method: 'GET', ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) });
  }

  async getProviderStatus(providerId: string, scope?: PiClientScope): Promise<PiProviderStatusResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<undefined, PiProviderStatusResponse>(
      `/api/pi/providers/${encodeURIComponent(providerId)}/status`,
      { method: 'GET', ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async loginProvider(input: PiProviderLoginInput, scope?: PiClientScope): Promise<PiProviderLoginResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<PiProviderLoginInput, PiProviderLoginResponse>(
      `/api/pi/providers/${encodeURIComponent(input.providerId)}/login`,
      { method: 'POST', body: input, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async getProviderLogin(providerId: string, loginId: string, scope?: PiClientScope): Promise<PiProviderLoginResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<undefined, PiProviderLoginResponse>(
      `/api/pi/providers/${encodeURIComponent(providerId)}/login/${encodeURIComponent(loginId)}`,
      { method: 'GET', ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async respondProviderLogin(providerId: string, loginId: string, value: string, scope?: PiClientScope): Promise<PiProviderLoginResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<{ value: string }, PiProviderLoginResponse>(
      `/api/pi/providers/${encodeURIComponent(providerId)}/login/${encodeURIComponent(loginId)}/respond`,
      { method: 'POST', body: { value }, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async logoutProvider(input: PiProviderLogoutInput, scope?: PiClientScope): Promise<void> {
    assertRuntimeUnchanged(scope);
    await jsonRequest<PiProviderLogoutInput, undefined>(
      `/api/pi/providers/${encodeURIComponent(input.providerId)}/logout`,
      { method: 'POST', body: input, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async getProviderConfig(providerId: string, scope?: PiClientScope): Promise<PiProviderConfigResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<undefined, PiProviderConfigResponse>(
      `/api/pi/providers/${encodeURIComponent(providerId)}/config`,
      { method: 'GET', ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  async setProviderModels(input: PiProviderSetModelsInput, scope?: PiClientScope): Promise<PiProviderConfigResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<PiProviderSetModelsInput, PiProviderConfigResponse>(
      `/api/pi/providers/${encodeURIComponent(input.providerId)}/models`,
      { method: 'PUT', body: input, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
  }

  // ----- Pi settings ------------------------------------------------------

  async getSettings(scope?: PiClientScope): Promise<PiSettingsSnapshot> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<undefined, PiSettingsSnapshot>('/api/pi/settings', {
      method: 'GET', ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
    });
  }

  async setPiSettings(input: PiSettingsUpdateInput, scope?: PiClientScope): Promise<Pick<PiSettingsSnapshot, 'pi'>> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<PiSettingsUpdateInput, Pick<PiSettingsSnapshot, 'pi'>>('/api/pi/settings/pi', {
      method: 'PUT', body: input, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
    });
  }

  async setPiChamberDefaults(input: PiChamberDefaultsUpdateInput, scope?: PiClientScope): Promise<Pick<PiSettingsSnapshot, 'pichamber'>> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<PiChamberDefaultsUpdateInput, Pick<PiSettingsSnapshot, 'pichamber'>>('/api/pi/settings/defaults', {
      method: 'PUT', body: input, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
    });
  }

  // ----- Resources --------------------------------------------------------

  async listResources(scope?: PiClientScope): Promise<PiResourceListResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<undefined, PiResourceListResponse>('/api/pi/resources', {
      method: 'GET',
      ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
    });
  }

  async updateResource(input: PiResourceUpdateInput, scope?: PiClientScope): Promise<PiResourceListResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<PiResourceUpdateInput, PiResourceListResponse>(`/api/pi/resources/${encodeURIComponent(input.resourceId)}`, {
      method: 'PUT', body: input, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
    });
  }

  async createPromptTemplate(input: PiPromptTemplateCreateInput, scope?: PiClientScope): Promise<PiResourceListResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<PiPromptTemplateCreateInput, PiResourceListResponse>('/api/pi/resources/prompts', {
      method: 'POST', body: input, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
    });
  }

  async deletePromptTemplate(resourceId: string, scope?: PiClientScope): Promise<PiResourceListResponse> {
    assertRuntimeUnchanged(scope);
    return jsonRequest<undefined, PiResourceListResponse>(`/api/pi/resources/prompts/${encodeURIComponent(resourceId)}`, {
      method: 'DELETE', ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}),
    });
  }

  // ----- Attachments ------------------------------------------------------

  async createAttachment(
    input: PiAttachmentCreateInput,
    scope?: PiClientScope,
  ): Promise<PiAttachment> {
    assertRuntimeUnchanged(scope);
    const response = await jsonRequest<PiAttachmentCreateInput, PiAttachmentCreateResponse>(
      '/api/pi/attachments',
      { method: 'POST', body: input, ...(scope?.runtimeKey ? { runtimeKey: scope.runtimeKey } : {}) },
    );
    return response.attachment;
  }
}

// ---------------------------------------------------------------------------
// Singleton + scoping helpers
// ---------------------------------------------------------------------------

/** Global, non-directory-scoped service. */
export const piClient = new PiService();

/** Build a scoped service bound to a directory for direct calls. */
export const createScopedPiClient = (directory: string): PiService => {
  const scoped = new PiService();
  scoped.setDirectory(directory);
  return scoped;
};
