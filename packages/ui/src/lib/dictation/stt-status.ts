import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import i18n from '@/i18n';

export interface SttModelStatus {
  id: string;
  description: string;
  sizeBytes: number;
  installed: boolean;
  corrupt: boolean;
  downloading: boolean;
  downloadProgress: number | null;
  downloadError: string | null;
}

export interface SttPublicProvider {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
}

export interface SttConfigState {
  enabled: boolean;
  providerConfigId: string;
  language: string;
  localModelId: string;
  providers: SttPublicProvider[];
}

export interface SttStatus {
  config: SttConfigState;
  models: SttModelStatus[];
}

/**
 * Shared `GET /api/stt/status` reader.
 *
 * Both the composer dictation hook (which refreshes on every `ChatInput`
 * mount) and Dictation settings read this endpoint, so without sharing every
 * app start issues it twice. Callers share one runtime-scoped result:
 *
 * - Concurrent callers share the in-flight promise.
 * - Settled successes memoize by `getRuntimeKey()` for `STT_STATUS_TTL_MS`.
 * - Failure or a non-OK response never populates the memo and always throws,
 *   so the next caller retries against the network.
 * - `resetSttStatusCache()` (wired through the central runtime-endpoint reset)
 *   clears both entries on a runtime switch.
 * - `{ fresh: true }` bypasses both entries. Settings uses it after
 *   install/download actions and for its download-progress poll, where a
 *   memoized snapshot would freeze progress output.
 */
const STT_STATUS_TTL_MS = 30_000;

let cachedSttStatus: { key: string; status: SttStatus; expiresAt: number } | null = null;
let inflightSttStatus: { key: string; promise: Promise<SttStatus> } | null = null;

export const resetSttStatusCache = (): void => {
  cachedSttStatus = null;
  inflightSttStatus = null;
};

export const fetchSttStatus = async (options?: { fresh?: boolean }): Promise<SttStatus> => {
  const key = getRuntimeKey();
  if (!options?.fresh) {
    const cached = cachedSttStatus;
    if (cached && cached.key === key && Date.now() < cached.expiresAt) return cached.status;
    const inflight = inflightSttStatus;
    if (inflight && inflight.key === key) return inflight.promise;
  }
  const promise = (async (): Promise<SttStatus> => {
    const response = await runtimeFetch('/api/stt/status');
    if (!response.ok) throw new Error(i18n.t('Could not load dictation settings'));
    const status = (await response.json()) as SttStatus;
    // Explicit refreshes observe the server without replacing the shared
    // snapshot, so a post-action read cannot skew background consumers.
    if (!options?.fresh && getRuntimeKey() === key) {
      cachedSttStatus = { key, status, expiresAt: Date.now() + STT_STATUS_TTL_MS };
    }
    return status;
  })();
  if (!options?.fresh) inflightSttStatus = { key, promise };
  try {
    return await promise;
  } finally {
    if (inflightSttStatus?.promise === promise) inflightSttStatus = null;
  }
};
