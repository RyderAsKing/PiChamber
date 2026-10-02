import type { DesktopSettings } from '@/lib/desktop';
import { sanitizeStarterRefs } from './draftStarters';
import { useUIStore } from '@/stores/useUIStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  getRuntimeKey,
  subscribeRuntimeEndpointChanged,
  subscribeRuntimeEndpointWillChange,
} from '@/lib/runtime-switch';
import {
  getSettingsSaveState,
  subscribeToSettingsSaveState,
  reportSettingsSaveState,
  dispatchSettingsSaveState,
} from './persistence/settingsSaveState';
import {
  applyPersistedHomeDirectoryToWindow,
  getRuntimeSettingsMirrorStorageKey,
  persistToLocalStorage,
  dispatchSettingsSynced,
} from './persistence/settingsMirror';
import {
  materializeAuthoritativeUiSettings,
  sanitizeWebSettings,
} from './persistence/settingsSanitizers';
import {
  applyDesktopUiPreferences,
  isUiAuthenticationError,
} from './persistence/settingsStoreSync';

export {
  applyPersistedHomeDirectoryToWindow,
  getRuntimeSettingsMirrorStorageKey,
  getSettingsSaveState,
  subscribeToSettingsSaveState,
  reportSettingsSaveState,
};

type PersistApi = {
  hasHydrated?: () => boolean;
  onFinishHydration?: (callback: () => void) => (() => void) | undefined;
};

const getPersistApi = (): PersistApi | undefined => {
  const candidate = (useUIStore as unknown as { persist?: PersistApi }).persist;
  if (candidate && typeof candidate === 'object') {
    return candidate;
  }
  return undefined;
};

const getRuntimeSettingsAPI = () => getRegisteredRuntimeAPIs()?.settings ?? null;

type SettingsRuntimeContext = { runtimeKey: string; generation: number };

// Short-lived cache + in-flight dedup for settings fetches to avoid repeated GET calls during startup
let _settingsRuntimeGeneration = 0;
let _settingsCache: {
  value: DesktopSettings | null;
  at: number;
  context: SettingsRuntimeContext;
} | null = null;
// Raw document behind `_settingsCache`, always written and cleared with it.
// Readers that need fields the sanitizer does not keep (e.g. config
// defaults) share the same GET through `loadSharedSettingsDocument`.
let _settingsRawCache: {
  value: Record<string, unknown> | null;
  context: SettingsRuntimeContext;
} | null = null;
let _settingsInflight: {
  promise: Promise<DesktopSettings | null>;
  context: SettingsRuntimeContext;
} | null = null;
let _pendingSettingsChanges: Partial<DesktopSettings> | null = null;
let _pendingSettingsContext: SettingsRuntimeContext | null = null;
let _settingsFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _settingsFlushWaiters: Array<() => void> = [];
let _settingsLifecycleInitialized = false;
// Settled successful GETs stay valid until a PUT from this client replaces
// them with its full-document response (or invalidates them when that
// response is missing/invalid) or a runtime endpoint change clears them.
// The TTL only caps staleness
// against other clients/processes writing the same files. Failures (null)
// are never cached. `invalidateSettingsCache()` remains the explicit
// force-refresh path (call it before a settings surface needs fresh values).
const SETTINGS_CACHE_TTL = 30_000; // 30 seconds — covers the startup burst
const SETTINGS_DEBOUNCE_MS = 200;
// Floor between resume refreshes (`refreshDesktopSettings`), so a burst of
// focus/visibility/online signals costs one GET.
const SETTINGS_REFRESH_MIN_INTERVAL_MS = 5_000;

// Stale-load guards. Another client can change the shared document at any
// time, so settings are re-read after boot (`refreshDesktopSettings`), and a
// re-read can overlap a local write:
//
// - `_settingsMutationRevision` counts local `updateDesktopSettings` calls. A
//   refresh captures it before its GET and drops the result when it moved, so
//   a response that predates a local edit never reverts the edit in the UI.
// - `_settingsFlushesInFlight` counts flushes that have not settled. A refresh
//   does not start while one is running: the PUT response already carries the
//   full merged document.
// - `_settingsResponseRevision` counts adopted PUT responses. A GET that
//   started before a response was adopted may hold the older document, so it
//   must not replace the cache or the no-op suppression image.
let _settingsMutationRevision = 0;
let _settingsFlushesInFlight = 0;
let _settingsResponseRevision = 0;

// Authoritative "last synced" image for no-op write suppression.
//
// Contract: the image is the last successfully fetched settings document —
// or the full document returned by a successful PUT — for the current
// runtime. It is updated only on success: a failed GET leaves it unknown
// (null) and a failed PUT leaves it untouched so a retry still sends. Two
// mechanisms keep startup traffic minimal:
//
// - Initial-load gating. A flush with no image first awaits one authoritative
//   load through the shared `fetchWebSettings` path, reusing the in-flight
//   boot GET when there is one and starting it early when none has run yet
//   (that GET would happen at boot anyway). Pending writes are snapshotted
//   only after the wait, so the diff covers everything that arrived while
//   waiting and a runtime switch mid-wait strands nothing. Boot-time echoes
//   of server state therefore send zero PUTs. A failed or timed-out load
//   (3 s cap) falls through and sends the patch exactly as before — unknown
//   state never suppresses. The endpoint-change drain skips the gate so
//   departing-runtime writes still complete against their captured owner.
//   The wait never runs for `syncDesktopSettings` itself (it already holds
//   the load result) and never blocks on a load started synchronously from
//   inside the flush.
// - PUT-response adoption. The server (`write()` in
//   `packages/web/server/lib/pi/ui-settings-store.js`, served at
//   `PUT /api/pi/ui-settings`) and the web `save()` transport both return the
//   full merged settings document. A successful PUT therefore adopts its
//   response as the new image and as a fresh GET cache entry (same TTL), so
//   the next sync needs no refetch. A missing/invalid response falls back to
//   merging the acknowledged patch into the image and invalidating the cache.
//
// Before sending a debounced PUT, pending keys deep-equal to the image are
// no-ops: when nothing remains the flush is skipped but callers still resolve
// and observe the same `saved` state as a successful save. Write ordering for
// changed keys is unchanged — a partially changed patch is still sent whole,
// matching the existing PUT contract. The image (and the
// initial-load-succeeded marker below) reset on runtime endpoint change
// alongside the GET cache, so one runtime's state never suppresses another's
// writes; `invalidateSettingsCache()` still forces the next write out.
//
// Equality is strict per the server merge in
// `packages/web/server/lib/pi/ui-settings-store.js` (`write()` spreads the
// patch over the stored record and rewrites both JSON files): `undefined`
// and `null` differ. `undefined` values are dropped by `JSON.stringify`, so
// they delete the key on the next read, while `null` persists as a value. A
// pending `null` against an absent key is therefore a real change and is
// sent; a pending `undefined` against an absent key is already absent and is
// a no-op.
//
// The image lags a PUT that has been sent but not settled, so a key carried
// by an outstanding patch (`_settingsPatchesInFlight`) is never a no-op: a
// write restoring the image value while that PUT is in flight is a real
// rollback and must follow it to the server.
let _lastSyncedSettings: DesktopSettings | null = null;
let _settingsPatchesInFlight: Array<Partial<DesktopSettings>> = [];

// True once a settings load has succeeded in the current runtime generation.
// Separate from `_lastSyncedSettings` (which `invalidateSettingsCache()`
// clears to force the next write out): a forced refresh must not trigger a
// reload-and-suppress cycle in the next flush. Reset on runtime endpoint
// change alongside the GET cache and the image.
let _settingsInitialLoadSucceeded = false;

// How long a flush with no synced image waits for the initial settings load
// before giving up and sending the patch unsuppressed. Bounded so a hung GET
// can delay but never deadlock a write; kept under the UI suite's per-test
// timeout so the timeout path stays covered by tests.
const SETTINGS_INITIAL_LOAD_TIMEOUT_MS = 3_000;

// Synchronous reentrancy guard around the in-flight slot assignment in
// `fetchWebSettings`. The load promise executor starts running before
// `_settingsInflight` is assigned, so a flush triggered synchronously from
// inside the load path must not wait on the load it is helping to start — it
// sends as if no image existed.
let _isStartingSettingsLoad = false;

const isSettingsRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const areSettingsValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((entry, index) => areSettingsValuesEqual(entry, right[index]))
    );
  }
  if (isSettingsRecord(left) || isSettingsRecord(right)) {
    if (!isSettingsRecord(left) || !isSettingsRecord(right)) return false;
    // Match the JSON-file merge: keys with `undefined` values serialize away,
    // so treat them as absent on both sides.
    const leftEntries = Object.entries(left).filter(([, value]) => value !== undefined);
    const rightEntries = Object.entries(right).filter(([, value]) => value !== undefined);
    return (
      leftEntries.length === rightEntries.length &&
      leftEntries.every(([key, value]) => {
        if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
        const other = right[key];
        return other !== undefined && areSettingsValuesEqual(value, other);
      })
    );
  }
  return false;
};

const cloneSettingsSnapshot = (settings: DesktopSettings): DesktopSettings =>
  JSON.parse(JSON.stringify(settings)) as DesktopSettings;

const recordAcknowledgedSettings = (changes: Partial<DesktopSettings>): void => {
  // Merge exactly what the server acknowledged into the image so a later
  // identical write suppresses. Keys explicitly sent as `undefined` delete
  // the stored key (see the JSON-file merge above), so drop them from the
  // image too; everything else is cloned so later caller-side mutation of
  // nested values cannot corrupt the baseline.
  const merged: Record<string, unknown> = { ...(_lastSyncedSettings ?? {}) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      const serialized = JSON.stringify(value);
      merged[key] = serialized === undefined ? value : (JSON.parse(serialized) as unknown);
    }
  }
  _lastSyncedSettings = merged as DesktopSettings;
};

const isPendingSettingsNoop = (changes: Partial<DesktopSettings>): boolean => {
  if (!_lastSyncedSettings) return false;
  const baseline = _lastSyncedSettings as Record<string, unknown>;
  return Object.entries(changes).every(([key, value]) => {
    if (_settingsPatchesInFlight.some((patch) => Object.prototype.hasOwnProperty.call(patch, key))) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(baseline, key)) {
      // Absent baseline key: only `undefined` (already absent after the
      // JSON-file merge) is a no-op. `null` persists as a value — send it.
      return value === undefined;
    }
    return areSettingsValuesEqual(value, baseline[key]);
  });
};

const captureSettingsRuntimeContext = (): SettingsRuntimeContext => ({
  runtimeKey: getRuntimeKey(),
  generation: _settingsRuntimeGeneration,
});

const isSameSettingsRuntimeContext = (
  left: SettingsRuntimeContext,
  right: SettingsRuntimeContext
): boolean =>
  left.runtimeKey === right.runtimeKey && left.generation === right.generation;

const isSettingsRuntimeContextCurrent = (
  context: SettingsRuntimeContext
): boolean =>
  context.generation === _settingsRuntimeGeneration &&
  context.runtimeKey === getRuntimeKey();

const ensureSettingsRuntimeLifecycle = (): void => {
  if (_settingsLifecycleInitialized || typeof window === 'undefined') return;
  _settingsLifecycleInitialized = true;

  subscribeRuntimeEndpointWillChange((detail) => {
    if (detail.runtimeKey === detail.previousRuntimeKey) return;
    if (_settingsFlushTimer) clearTimeout(_settingsFlushTimer);
    // Drain against the captured (departing) owner: skip initial-load gating
    // so the write completes instead of parking on a load the switch is
    // about to invalidate.
    if (_pendingSettingsChanges) void _flushSettingsUpdate({ skipInitialLoadGate: true });
  });
  subscribeRuntimeEndpointChanged((detail) => {
    if (detail.runtimeKey === detail.previousRuntimeKey) return;
    _settingsRuntimeGeneration += 1;
    _settingsCache = null;
    _settingsRawCache = null;
    _settingsInflight = null;
    _lastSyncedSettings = null;
    _settingsInitialLoadSucceeded = false;
  });
};

const toRawSettingsDocument = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const fetchWebSettings = async (
  context = captureSettingsRuntimeContext()
): Promise<DesktopSettings | null> => {
  ensureSettingsRuntimeLifecycle();
  if (
    _settingsCache &&
    isSameSettingsRuntimeContext(_settingsCache.context, context) &&
    Date.now() - _settingsCache.at < SETTINGS_CACHE_TTL
  ) {
    return _settingsCache.value;
  }

  if (
    _settingsInflight &&
    isSameSettingsRuntimeContext(_settingsInflight.context, context)
  )
    return _settingsInflight.promise;

  // See `_isStartingSettingsLoad`: mark the creation window before the
  // promise executor below starts running.
  _isStartingSettingsLoad = true;
  const responseRevision = _settingsResponseRevision;
  const adoptLoadedSettings = (settings: DesktopSettings | null, raw: unknown): void => {
    _settingsInitialLoadSucceeded = true;
    // A PUT response adopted while this GET was in flight is newer.
    if (responseRevision !== _settingsResponseRevision) return;
    _settingsCache = { value: settings, at: Date.now(), context };
    _settingsRawCache = { value: toRawSettingsDocument(raw), context };
    if (settings) _lastSyncedSettings = cloneSettingsSnapshot(settings);
  };
  const inflight = {
    context,
    promise: (async (): Promise<DesktopSettings | null> => {
      const runtimeSettings = getRuntimeSettingsAPI();
      if (runtimeSettings) {
        try {
          const result = await runtimeSettings.load();
          if (!isSettingsRuntimeContextCurrent(context)) return null;
          const settings = sanitizeWebSettings(result.settings);
          adoptLoadedSettings(settings, result.settings);
          return settings;
        } catch (error) {
          if (!isSettingsRuntimeContextCurrent(context)) return null;
          if (isUiAuthenticationError(error)) return null;
          console.warn(
            'Failed to load shared settings from runtime settings API:',
            error
          );
        }
      }

      if (!isSettingsRuntimeContextCurrent(context)) return null;
      try {
        const response = await runtimeFetch('/api/pi/ui-settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!isSettingsRuntimeContextCurrent(context)) return null;
        if (!response.ok) {
          return null;
        }
        const data = await response.json().catch(() => null);
        if (!isSettingsRuntimeContextCurrent(context)) return null;
        const settings = sanitizeWebSettings(data);
        adoptLoadedSettings(settings, data);
        return settings;
      } catch (error) {
        if (!isSettingsRuntimeContextCurrent(context)) return null;
        console.warn('Failed to load shared settings from server:', error);
        return null;
      }
    })(),
  };
  _settingsInflight = inflight;
  _isStartingSettingsLoad = false;
  void inflight.promise.finally(() => {
    if (_settingsInflight === inflight) _settingsInflight = null;
  });

  return inflight.promise;
};

/**
 * Raw settings document from the shared startup GET (cache + in-flight
 * dedupe, same runtime scoping as `syncDesktopSettings`). Returns null when
 * the load failed; callers keep their own fallback. The returned object is
 * shared — treat it as read-only.
 */
export const loadSharedSettingsDocument = async (): Promise<Record<string, unknown> | null> => {
  const context = captureSettingsRuntimeContext();
  const settings = await fetchWebSettings(context);
  if (!settings) return null;
  if (_settingsRawCache && isSameSettingsRuntimeContext(_settingsRawCache.context, context)) {
    return _settingsRawCache.value;
  }
  return null;
};

/** Invalidate cached settings (call after a successful PUT) */
export const invalidateSettingsCache = (): void => {
  _settingsCache = null;
  _settingsRawCache = null;
  // Force-refresh path: the next write must go out even if it echoes the
  // last synced image, so drop the no-op suppression baseline too.
  _lastSyncedSettings = null;
};

export const buildDraftStarterMigrationPatch = (
  settings: DesktopSettings,
): Partial<DesktopSettings> => {
  const shouldPersistScheduleTaskMigration =
    settings.draftStartersScheduleTaskAdded !== true;
  const shouldMigrateLegacyStarters =
    Array.isArray(settings.draftStarters) &&
    (settings.draftStarters as unknown[]).some((starter) => {
      if (!starter || typeof starter !== 'object') return false;
      const type = (starter as Record<string, unknown>).type;
      return type !== 'prompt' && type !== 'text';
    });
  if (!shouldPersistScheduleTaskMigration && !shouldMigrateLegacyStarters) {
    return {};
  }
  return {
    ...(Array.isArray(settings.draftStarters)
      ? { draftStarters: sanitizeStarterRefs(settings.draftStarters) }
      : {}),
    draftStartersScheduleTaskAdded: true,
  };
};

const runSettingsSync = async (mode: 'load' | 'refresh'): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }
  ensureSettingsRuntimeLifecycle();
  const context = captureSettingsRuntimeContext();
  const mutationRevision = _settingsMutationRevision;
  // A refresh result is only usable when no local edit was made since it was
  // requested; the pending write (and its full-document response) wins.
  const isSupersededByLocalWrite = (): boolean =>
    mode === 'refresh' &&
    (mutationRevision !== _settingsMutationRevision || _pendingSettingsChanges !== null);

  const persistApi = getPersistApi();

  const waitForHydration = (): Promise<void> => {
    if (!persistApi?.hasHydrated || persistApi.hasHydrated()) {
      return Promise.resolve();
    }
    if (!persistApi.onFinishHydration) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const unsubscribe = persistApi.onFinishHydration!(() => {
        unsubscribe?.();
        finish();
      });
      if (persistApi.hasHydrated?.()) finish();
    });
  };

  const applySettings = async (settings: DesktopSettings) => {
    if (!isSettingsRuntimeContextCurrent(context)) return;
    if (isSupersededByLocalWrite()) return;
    const shouldSeedAutoSaveEnabled =
      typeof settings.autoSaveEnabled !== 'boolean';
    const shouldMigrateLocalAutoDeleteEnabled =
      context.runtimeKey === 'local' && typeof settings.autoDeleteEnabled !== 'boolean';
    const shouldMigrateLocalAutoDeleteAfterDays =
      context.runtimeKey === 'local' && typeof settings.autoDeleteAfterDays !== 'number';
    const shouldMigrateLocalSessionRetentionAction =
      context.runtimeKey === 'local'
      && settings.sessionRetentionAction !== 'archive'
      && settings.sessionRetentionAction !== 'delete';
    const authoritativeSettings =
      materializeAuthoritativeUiSettings(settings);
    if (mode === 'refresh') {
      // Which folder is open is this client's own navigation state once it
      // has booted. A refresh adopts shared preferences and the folder list,
      // never the folder another client last opened, so the pointer is left
      // out of the applied document and the boot mirror is not rewritten.
      delete authoritativeSettings.activeProjectId;
    } else {
      try {
        persistToLocalStorage(settings);
      } catch (error) {
        console.warn('persistToLocalStorage failed:', error);
      }
    }
    await waitForHydration();
    if (!isSettingsRuntimeContextCurrent(context)) return;
    if (isSupersededByLocalWrite()) return;
    const hydratedUiSettings = useUIStore.getState();
    if (shouldSeedAutoSaveEnabled) {
      authoritativeSettings.autoSaveEnabled = hydratedUiSettings.autoSaveEnabled;
    }
    if (shouldMigrateLocalAutoDeleteEnabled) {
      authoritativeSettings.autoDeleteEnabled = hydratedUiSettings.autoDeleteEnabled;
    }
    if (shouldMigrateLocalAutoDeleteAfterDays) {
      authoritativeSettings.autoDeleteAfterDays = hydratedUiSettings.autoDeleteAfterDays;
    }
    if (shouldMigrateLocalSessionRetentionAction) {
      authoritativeSettings.sessionRetentionAction = hydratedUiSettings.sessionRetentionAction;
    }
    if (settings.draftStarters === undefined) {
      useUIStore.setState({ globalDraftStarters: null });
    }
    try {
      applyDesktopUiPreferences(authoritativeSettings);
    } catch (error) {
      console.warn('applyDesktopUiPreferences failed:', error);
    }
    // Preserve an absent starter list: `undefined` is the fresh-install
    // sentinel that lets the UI show its built-in starters.
    const migrationPatch = buildDraftStarterMigrationPatch(settings);
    if (shouldSeedAutoSaveEnabled) {
      migrationPatch.autoSaveEnabled = authoritativeSettings.autoSaveEnabled;
    }
    if (shouldMigrateLocalAutoDeleteEnabled) {
      migrationPatch.autoDeleteEnabled = authoritativeSettings.autoDeleteEnabled;
    }
    if (shouldMigrateLocalAutoDeleteAfterDays) {
      migrationPatch.autoDeleteAfterDays = authoritativeSettings.autoDeleteAfterDays;
    }
    if (shouldMigrateLocalSessionRetentionAction) {
      migrationPatch.sessionRetentionAction = authoritativeSettings.sessionRetentionAction;
    }
    if (Object.keys(migrationPatch).length > 0) {
      await updateDesktopSettings(migrationPatch);
      if (!isSettingsRuntimeContextCurrent(context)) return;
    }

    dispatchSettingsSynced(authoritativeSettings);
  };

  try {
    const webSettings = await fetchWebSettings(context);
    if (webSettings && isSettingsRuntimeContextCurrent(context)) {
      await applySettings(webSettings);
    }
  } catch (error) {
    console.warn('Failed to synchronise settings:', error);
  }
};

export const syncDesktopSettings = (): Promise<void> => runSettingsSync('load');

/**
 * Re-read the shared settings document after boot so changes made by another
 * client of the same server (sidebar view, folder order, appearance) reach
 * this one. Call it when the client may have missed changes: the page became
 * visible again, the network came back, or the Pi connection was
 * re-established. Uses the same GET, sanitizers, and store-apply path as
 * `syncDesktopSettings`.
 *
 * Never reverts local edits: it does not start while a write is pending or in
 * flight, and it drops its result when a local write was made meanwhile. A
 * failed GET changes nothing.
 */
export const refreshDesktopSettings = async (): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }
  if (_pendingSettingsChanges !== null || _settingsFlushesInFlight > 0) return;
  const context = captureSettingsRuntimeContext();
  if (
    _settingsCache &&
    isSameSettingsRuntimeContext(_settingsCache.context, context) &&
    Date.now() - _settingsCache.at < SETTINGS_REFRESH_MIN_INTERVAL_MS
  ) {
    return;
  }
  // Drop only the GET cache. The no-op suppression image stays: it is still
  // the last document this client synced, and the fresh GET replaces it.
  _settingsCache = null;
  _settingsRawCache = null;
  await runSettingsSync('refresh');
};

const isFullSettingsResponse = (value: unknown): value is DesktopSettings =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Adopt a successful PUT response as the new synced image and GET cache
// value. Both the server (`write()` in
// `packages/web/server/lib/pi/ui-settings-store.js`) and the web `save()`
// transport return the full merged settings document, so the next sync or
// flush needs no refetch. A missing/invalid body falls back to merging the
// acknowledged patch into the image and invalidating the cache.
const recordSuccessfulPutResponse = (
  updated: unknown,
  changes: Partial<DesktopSettings>,
  context: SettingsRuntimeContext
): void => {
  _settingsResponseRevision += 1;
  if (isFullSettingsResponse(updated)) {
    _lastSyncedSettings = cloneSettingsSnapshot(updated);
    _settingsCache = {
      value: sanitizeWebSettings(updated),
      at: Date.now(),
      context,
    };
    _settingsRawCache = { value: toRawSettingsDocument(updated), context };
    _settingsInitialLoadSucceeded = true;
    return;
  }
  recordAcknowledgedSettings(changes);
  _settingsCache = null;
  _settingsRawCache = null;
};

// Await one authoritative load for a flush that has no synced image to diff
// against. Goes through `fetchWebSettings` — never `syncDesktopSettings`,
// whose migration path can itself enqueue a flush — so the load cannot
// depend on this flush. Resolves (without throwing) when the load succeeds,
// fails, or hits the timeout cap; callers fall through and send on anything
// but a usable image.
const awaitInitialSettingsForFlush = async (
  context: SettingsRuntimeContext
): Promise<void> => {
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), SETTINGS_INITIAL_LOAD_TIMEOUT_MS);
  });
  await Promise.race([fetchWebSettings(context).then(() => undefined), timeout]);
};

// Coalesce rapid updateDesktopSettings calls into a single PUT
async function _flushSettingsUpdate(
  options: { skipInitialLoadGate?: boolean } = {}
): Promise<void> {
  _settingsFlushesInFlight += 1;
  try {
    await _runSettingsFlush(options);
  } finally {
    _settingsFlushesInFlight -= 1;
  }
}

async function _runSettingsFlush(
  options: { skipInitialLoadGate?: boolean }
): Promise<void> {
  // Initial-load gating (see the contract above): without a synced image a
  // pending patch cannot be distinguished from an echo of server state (the
  // startup double-PUT). Await one authoritative load first — reusing the
  // in-flight boot GET when there is one, starting it early when none has
  // run yet — then snapshot and diff against its image. Failure, timeout, or
  // a runtime switch while waiting falls through to sending as today.
  // Gating runs before snapshotting so a runtime switch while waiting
  // strands nothing: everything stays queued for the endpoint-change drain.
  if (
    !options.skipInitialLoadGate &&
    _pendingSettingsChanges &&
    Object.keys(_pendingSettingsChanges).length > 0 &&
    !_lastSyncedSettings &&
    !_isStartingSettingsLoad
  ) {
    const gateContext =
      _pendingSettingsContext ?? captureSettingsRuntimeContext();
    const inflightForContext =
      !!_settingsInflight &&
      isSameSettingsRuntimeContext(_settingsInflight.context, gateContext);
    if (
      isSettingsRuntimeContextCurrent(gateContext) &&
      (inflightForContext || !_settingsInitialLoadSucceeded)
    ) {
      await awaitInitialSettingsForFlush(gateContext);
    }
  }

  const snapshot = _pendingSettingsChanges;
  const context = _pendingSettingsContext;
  const waiters = _settingsFlushWaiters;
  _pendingSettingsChanges = null;
  _pendingSettingsContext = null;
  _settingsFlushTimer = null;
  _settingsFlushWaiters = [];
  let sentPatch: Partial<DesktopSettings> | null = null;
  try {
    if (
      !snapshot ||
      !context ||
      Object.keys(snapshot).length === 0 ||
      !isSettingsRuntimeContextCurrent(context)
    ) {
      dispatchSettingsSaveState('saved');
      return;
    }
    const changes: Partial<DesktopSettings> = snapshot;
    // Snapshotting after the initial-load wait already includes every patch
    // that arrived while waiting, preserving write order like the debounce
    // does — no separate merge step.

    // Drop the network round trip when the whole patch echoes the last
    // synced image, but resolve/dispatch exactly as a successful save would.
    if (isPendingSettingsNoop(changes)) {
      dispatchSettingsSaveState('saved');
      return;
    }

    sentPatch = changes;
    _settingsPatchesInFlight.push(changes);

    const runtimeSettings = getRuntimeSettingsAPI();
    if (runtimeSettings) {
      try {
        const updated = await runtimeSettings.save(changes);
        if (!isSettingsRuntimeContextCurrent(context)) return;
        if (updated) {
          // Snapshot the pristine response first: `applyDesktopUiPreferences`
          // mutates it in place (drops the starter-migration sentinel).
          recordSuccessfulPutResponse(updated, changes, context);
          applyDesktopUiPreferences(updated);
          dispatchSettingsSynced(updated);
        }
        dispatchSettingsSaveState(updated ? 'saved' : 'error');
        return;
      } catch (error) {
        if (!isSettingsRuntimeContextCurrent(context)) return;
        if (isUiAuthenticationError(error)) {
          dispatchSettingsSaveState('error');
          return;
        }
        console.warn(
          'Failed to update settings via runtime settings API:',
          error
        );
      }
    }

    if (!isSettingsRuntimeContextCurrent(context)) return;
    try {
      const response = await runtimeFetch('/api/pi/ui-settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(changes),
      });

      if (!isSettingsRuntimeContextCurrent(context)) return;
      if (!response.ok) {
        console.warn(
          'Failed to update shared settings via API:',
          response.status,
          response.statusText
        );
        dispatchSettingsSaveState('error');
        return;
      }

      const updated = (await response.json().catch(
        () => null
      )) as DesktopSettings | null;
      if (!isSettingsRuntimeContextCurrent(context)) return;
      if (updated) {
        // Snapshot the pristine response first: `applyDesktopUiPreferences`
        // mutates it in place (drops the starter-migration sentinel).
        recordSuccessfulPutResponse(updated, changes, context);
        applyDesktopUiPreferences(updated);
        dispatchSettingsSynced(updated);
        dispatchSettingsSaveState('saved');
      } else {
        // The write succeeded (HTTP 200) but the body is missing: merge the
        // acknowledged patch and force a refetch, matching the
        // invalid-body fallback. Dispatch stays 'error' as before.
        recordSuccessfulPutResponse(updated, changes, context);
        dispatchSettingsSaveState('error');
      }
    } catch (error) {
      if (isSettingsRuntimeContextCurrent(context)) {
        console.warn('Failed to update shared settings via API:', error);
        dispatchSettingsSaveState('error');
      }
    }
  } finally {
    if (sentPatch) {
      _settingsPatchesInFlight = _settingsPatchesInFlight.filter((patch) => patch !== sentPatch);
    }
    waiters.forEach((resolve) => resolve());
  }
}

export const updateDesktopSettings = async (
  changes: Partial<DesktopSettings>,
  options: { immediate?: boolean } = {},
): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }
  ensureSettingsRuntimeLifecycle();
  const context = captureSettingsRuntimeContext();

  if (
    _pendingSettingsContext &&
    !isSameSettingsRuntimeContext(_pendingSettingsContext, context)
  ) {
    if (_settingsFlushTimer) clearTimeout(_settingsFlushTimer);
    // Owner change: drain against the captured context now, never park it
    // behind the initial-load gate.
    void _flushSettingsUpdate({ skipInitialLoadGate: true });
  }

  _settingsMutationRevision += 1;
  _pendingSettingsChanges = { ...(_pendingSettingsChanges ?? {}), ...changes };
  _pendingSettingsContext = context;
  dispatchSettingsSaveState('saving');

  if (_settingsFlushTimer) {
    clearTimeout(_settingsFlushTimer);
  }
  const flushed = new Promise<void>((resolve) => {
    _settingsFlushWaiters.push(resolve);
  });
  if (options.immediate) {
    // Immediate writes (lifecycle stop, explicit saves) must go out now;
    // only debounced background flushes wait for the initial load.
    void _flushSettingsUpdate({ skipInitialLoadGate: true });
  } else {
    _settingsFlushTimer = setTimeout(
      () => void _flushSettingsUpdate(),
      SETTINGS_DEBOUNCE_MS
    );
  }
  return flushed;
};
