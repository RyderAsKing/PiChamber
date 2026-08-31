import { normalizePath } from '@/lib/pathNormalization';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import type { PiSessionId } from '@/lib/pi/types';
import type { LiveSessionRecord, PiSessionCatalogState } from '@/sync/pi-session-catalog';

const STORAGE_KEY = 'pichamber.piSessionCatalog.v1';
const CACHE_VERSION = 1;
const DEFAULT_FLUSH_DELAY_MS = 250;
const MAX_RUNTIME_ENTRIES = 4;
const MAX_DIRECTORIES = 512;
const MAX_SESSIONS = 2_000;
const MAX_ID_LENGTH = 512;
const MAX_DIRECTORY_LENGTH = 8_192;
const MAX_TITLE_LENGTH = 4_096;
const MAX_PREVIEW_LENGTH = 16_384;

type CachedSession = {
  id: string;
  parentId: string | null;
  title: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  preview?: string;
  messageCount?: number;
};

type CachedDirectory = {
  directory: string;
  sessions: CachedSession[];
};

type CachedRuntimeSnapshot = {
  updatedAt: number;
  directories: CachedDirectory[];
};

type CachedEnvelope = {
  version: 1;
  runtimes: Record<string, CachedRuntimeSnapshot>;
};

type CacheOptions = {
  flushDelayMs?: number;
  registerLifecycleListeners?: boolean;
};

export interface PiSessionCatalogCache {
  read(runtimeKey: string): PiSessionCatalogState | null;
  schedule(runtimeKey: string, catalog: PiSessionCatalogState): void;
  flush(): void;
  dispose(): void;
}

const isBoundedString = (value: unknown, maxLength: number, allowEmpty = false): value is string => (
  typeof value === 'string'
  && value.length <= maxLength
  && (allowEmpty || value.length > 0)
);

const isFiniteTimestamp = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);

const decodeSnapshot = (value: unknown): PiSessionCatalogState | null => {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as Partial<CachedRuntimeSnapshot>;
  if (!isFiniteTimestamp(snapshot.updatedAt) || !Array.isArray(snapshot.directories)) return null;
  if (snapshot.directories.length > MAX_DIRECTORIES) return null;

  const byId = new Map<PiSessionId, LiveSessionRecord>();
  const byDirectory = new Map<string, readonly PiSessionId[]>();
  const listStatusByDirectory = new Map<string, 'idle'>();
  let sessionCount = 0;

  for (const candidate of snapshot.directories) {
    if (!candidate || typeof candidate !== 'object') return null;
    const directoryValue = (candidate as Partial<CachedDirectory>).directory;
    const sessionsValue = (candidate as Partial<CachedDirectory>).sessions;
    if (!isBoundedString(directoryValue, MAX_DIRECTORY_LENGTH) || !Array.isArray(sessionsValue)) return null;
    const directory = normalizePath(directoryValue);
    if (!directory || byDirectory.has(directory)) return null;
    sessionCount += sessionsValue.length;
    if (sessionCount > MAX_SESSIONS) return null;

    const ids: PiSessionId[] = [];
    for (const rawSession of sessionsValue) {
      if (!rawSession || typeof rawSession !== 'object') return null;
      const session = rawSession as Partial<CachedSession>;
      if (!isBoundedString(session.id, MAX_ID_LENGTH)) return null;
      if (session.parentId !== null && !isBoundedString(session.parentId, MAX_ID_LENGTH)) return null;
      if (!isBoundedString(session.title, MAX_TITLE_LENGTH, true)) return null;
      if (typeof session.archived !== 'boolean') return null;
      if (!isFiniteTimestamp(session.createdAt) || !isFiniteTimestamp(session.updatedAt)) return null;
      if (session.preview !== undefined && !isBoundedString(session.preview, MAX_PREVIEW_LENGTH, true)) return null;
      if (session.messageCount !== undefined && (!Number.isSafeInteger(session.messageCount) || session.messageCount < 0)) return null;
      if (byId.has(session.id)) return null;

      const id = session.id as PiSessionId;
      byId.set(id, {
        id,
        directory,
        parentId: session.parentId as PiSessionId | null,
        title: session.title,
        archived: session.archived,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        ...(session.preview !== undefined ? { preview: session.preview } : {}),
        ...(session.messageCount !== undefined ? { messageCount: session.messageCount } : {}),
        lifecycle: 'idle',
        hydrated: false,
      });
      ids.push(id);
    }
    byDirectory.set(directory, ids);
    // Cached data is startup continuity, never live authority. The feeder
    // revalidates every restored directory because its status remains idle.
    listStatusByDirectory.set(directory, 'idle');
  }

  return { byId, byDirectory, listStatusByDirectory };
};

const parseEnvelope = (raw: string | null): CachedEnvelope | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedEnvelope>;
    if (parsed.version !== CACHE_VERSION || !parsed.runtimes || typeof parsed.runtimes !== 'object' || Array.isArray(parsed.runtimes)) return null;
    const runtimeEntries = Object.entries(parsed.runtimes);
    if (runtimeEntries.length > MAX_RUNTIME_ENTRIES) return null;
    return { version: CACHE_VERSION, runtimes: Object.fromEntries(runtimeEntries) };
  } catch {
    return null;
  }
};

const serializeCatalog = (catalog: PiSessionCatalogState, updatedAt: number): CachedRuntimeSnapshot => {
  const directories: CachedDirectory[] = [];
  let sessionCount = 0;
  const directoryKeys = new Set([
    ...catalog.byDirectory.keys(),
    ...catalog.listStatusByDirectory.keys(),
  ]);
  for (const rawDirectory of directoryKeys) {
    if (directories.length >= MAX_DIRECTORIES || sessionCount >= MAX_SESSIONS) break;
    const directory = normalizePath(rawDirectory);
    if (!directory) continue;
    const sessions: CachedSession[] = [];
    for (const id of catalog.byDirectory.get(rawDirectory) ?? []) {
      if (sessionCount >= MAX_SESSIONS) break;
      const record = catalog.byId.get(id);
      if (!record || normalizePath(record.directory) !== directory) continue;
      sessions.push({
        id: record.id,
        parentId: record.parentId,
        title: record.title,
        archived: record.archived,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.preview !== undefined ? { preview: record.preview } : {}),
        ...(record.messageCount !== undefined ? { messageCount: record.messageCount } : {}),
      });
      sessionCount += 1;
    }
    directories.push({ directory, sessions });
  }
  return { updatedAt, directories };
};

export const createPiSessionCatalogCache = (
  storage: Storage = getDeferredSafeStorage(),
  options: CacheOptions = {},
): PiSessionCatalogCache => {
  const flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
  const pending = new Map<string, PiSessionCatalogState>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const read = (runtimeKey: string): PiSessionCatalogState | null => {
    if (!runtimeKey) return null;
    try {
      const envelope = parseEnvelope(storage.getItem(STORAGE_KEY));
      if (!envelope || !Object.prototype.hasOwnProperty.call(envelope.runtimes, runtimeKey)) return null;
      return decodeSnapshot(envelope.runtimes[runtimeKey]);
    } catch {
      return null;
    }
  };

  const flush = () => {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    if (pending.size === 0) return;

    let envelope: CachedEnvelope = { version: CACHE_VERSION, runtimes: {} };
    try {
      const parsed = parseEnvelope(storage.getItem(STORAGE_KEY));
      if (parsed) envelope = parsed;
    } catch {
      // A blocked read leaves only the pending runtime snapshots to write.
    }

    const runtimeSnapshots = new Map(Object.entries(envelope.runtimes));
    let monotonicUpdatedAt = [...runtimeSnapshots.values()].reduce(
      (latest, snapshot) => isFiniteTimestamp(snapshot?.updatedAt) ? Math.max(latest, snapshot.updatedAt) : latest,
      0,
    );
    for (const [runtimeKey, catalog] of pending) {
      monotonicUpdatedAt = Math.max(Date.now(), monotonicUpdatedAt + 1);
      runtimeSnapshots.set(runtimeKey, serializeCatalog(catalog, monotonicUpdatedAt));
    }
    pending.clear();

    const retained = [...runtimeSnapshots.entries()]
      .filter(([, snapshot]) => decodeSnapshot(snapshot) !== null)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_RUNTIME_ENTRIES);
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({
        version: CACHE_VERSION,
        runtimes: Object.fromEntries(retained),
      } satisfies CachedEnvelope));
    } catch {
      // Best-effort startup cache. Authoritative network loading is unchanged.
    }
  };

  const schedule = (runtimeKey: string, catalog: PiSessionCatalogState) => {
    if (disposed || !runtimeKey) return;
    pending.set(runtimeKey, catalog);
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, Math.max(0, flushDelayMs));
  };

  const lifecycleFlush = () => flush();
  const visibilityFlush = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  if (options.registerLifecycleListeners && typeof window !== 'undefined') {
    window.addEventListener('pagehide', lifecycleFlush, { capture: true });
    window.addEventListener('beforeunload', lifecycleFlush, { capture: true });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', visibilityFlush);
      document.addEventListener('freeze', lifecycleFlush);
    }
  }

  return {
    read,
    schedule,
    flush,
    dispose: () => {
      if (disposed) return;
      flush();
      disposed = true;
      if (options.registerLifecycleListeners && typeof window !== 'undefined') {
        window.removeEventListener('pagehide', lifecycleFlush, { capture: true });
        window.removeEventListener('beforeunload', lifecycleFlush, { capture: true });
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', visibilityFlush);
          document.removeEventListener('freeze', lifecycleFlush);
        }
      }
    },
  };
};

const noOpCache: PiSessionCatalogCache = {
  read: () => null,
  schedule: () => undefined,
  flush: () => undefined,
  dispose: () => undefined,
};

let defaultCache: PiSessionCatalogCache | null = null;

export const getPiSessionCatalogCache = (): PiSessionCatalogCache => {
  if (typeof window === 'undefined') return noOpCache;
  defaultCache ??= createPiSessionCatalogCache(getDeferredSafeStorage(), { registerLifecycleListeners: true });
  return defaultCache;
};
