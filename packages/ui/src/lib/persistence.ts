import type { DesktopSettings } from '@/lib/desktop';
import { sanitizeStarterRefs } from './draftStarters';
import { useUIStore } from '@/stores/useUIStore';
import { loadAppearancePreferences, applyAppearancePreferences } from '@/lib/appearancePersistence';
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
let _settingsInflight: {
  promise: Promise<DesktopSettings | null>;
  context: SettingsRuntimeContext;
} | null = null;
let _pendingSettingsChanges: Partial<DesktopSettings> | null = null;
let _pendingSettingsContext: SettingsRuntimeContext | null = null;
let _settingsFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _settingsFlushWaiters: Array<() => void> = [];
let _settingsLifecycleInitialized = false;
const SETTINGS_CACHE_TTL = 2_000; // 2 seconds — covers the startup burst
const SETTINGS_DEBOUNCE_MS = 200;

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
    if (_pendingSettingsChanges) void _flushSettingsUpdate();
  });
  subscribeRuntimeEndpointChanged((detail) => {
    if (detail.runtimeKey === detail.previousRuntimeKey) return;
    _settingsRuntimeGeneration += 1;
    _settingsCache = null;
    _settingsInflight = null;
  });
};

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

  const inflight = {
    context,
    promise: (async (): Promise<DesktopSettings | null> => {
      const runtimeSettings = getRuntimeSettingsAPI();
      if (runtimeSettings) {
        try {
          const result = await runtimeSettings.load();
          if (!isSettingsRuntimeContextCurrent(context)) return null;
          const settings = sanitizeWebSettings(result.settings);
          _settingsCache = { value: settings, at: Date.now(), context };
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
        _settingsCache = { value: settings, at: Date.now(), context };
        return settings;
      } catch (error) {
        if (!isSettingsRuntimeContextCurrent(context)) return null;
        console.warn('Failed to load shared settings from server:', error);
        return null;
      }
    })(),
  };
  _settingsInflight = inflight;
  void inflight.promise.finally(() => {
    if (_settingsInflight === inflight) _settingsInflight = null;
  });

  return inflight.promise;
};

/** Invalidate cached settings (call after a successful PUT) */
export const invalidateSettingsCache = (): void => {
  _settingsCache = null;
};

export const syncDesktopSettings = async (): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }
  ensureSettingsRuntimeLifecycle();
  const context = captureSettingsRuntimeContext();

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
    const shouldPersistScheduleTaskMigration =
      settings.draftStartersScheduleTaskAdded !== true;
    // Legacy skill/command starters are removed without conversion on next
    // sanitize/persist. Detect any non-prompt record (defensively, from
    // untrusted persisted JSON) to trigger a single idempotent migration.
    const shouldMigrateLegacyStarters =
      Array.isArray(settings.draftStarters) &&
      (settings.draftStarters as unknown[]).some((starter) => {
        if (!starter || typeof starter !== 'object') return false;
        const type = (starter as Record<string, unknown>).type;
        return type !== 'prompt';
      });
    const shouldSeedAutoSaveEnabled =
      typeof settings.autoSaveEnabled !== 'boolean';
    const authoritativeSettings =
      materializeAuthoritativeUiSettings(settings);
    try {
      persistToLocalStorage(settings);
    } catch (error) {
      console.warn('persistToLocalStorage failed:', error);
    }
    await waitForHydration();
    if (!isSettingsRuntimeContextCurrent(context)) return;
    if (shouldSeedAutoSaveEnabled) {
      authoritativeSettings.autoSaveEnabled =
        useUIStore.getState().autoSaveEnabled;
    }
    if (settings.draftStarters === undefined) {
      useUIStore.setState({ globalDraftStarters: null });
    }
    try {
      applyDesktopUiPreferences(authoritativeSettings);
    } catch (error) {
      console.warn('applyDesktopUiPreferences failed:', error);
    }
    const migrationPatch: Partial<DesktopSettings> = {};
    if (
      shouldPersistScheduleTaskMigration ||
      shouldMigrateLegacyStarters
    ) {
      // Sanitize drops legacy skill/command records; persisting the cleaned
      // list makes the migration idempotent (no repeated writes).
      const cleaned = Array.isArray(authoritativeSettings.draftStarters)
        ? sanitizeStarterRefs(authoritativeSettings.draftStarters)
        : sanitizeStarterRefs(settings.draftStarters);
      migrationPatch.draftStarters = cleaned;
      migrationPatch.draftStartersScheduleTaskAdded = true;
    }
    if (shouldSeedAutoSaveEnabled) {
      migrationPatch.autoSaveEnabled = authoritativeSettings.autoSaveEnabled;
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

// Coalesce rapid updateDesktopSettings calls into a single PUT
async function _flushSettingsUpdate(): Promise<void> {
  const changes = _pendingSettingsChanges;
  const context = _pendingSettingsContext;
  const waiters = _settingsFlushWaiters;
  _pendingSettingsChanges = null;
  _pendingSettingsContext = null;
  _settingsFlushTimer = null;
  _settingsFlushWaiters = [];
  try {
    if (
      !changes ||
      !context ||
      Object.keys(changes).length === 0 ||
      !isSettingsRuntimeContextCurrent(context)
    ) {
      dispatchSettingsSaveState('saved');
      return;
    }

    const runtimeSettings = getRuntimeSettingsAPI();
    if (runtimeSettings) {
      try {
        const updated = await runtimeSettings.save(changes);
        if (!isSettingsRuntimeContextCurrent(context)) return;
        if (updated) {
          applyDesktopUiPreferences(updated);
          dispatchSettingsSynced(updated);
          _settingsCache = null;
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
        applyDesktopUiPreferences(updated);
        dispatchSettingsSynced(updated);
        dispatchSettingsSaveState('saved');
        _settingsCache = null;
      } else {
        dispatchSettingsSaveState('error');
      }
    } catch (error) {
      if (isSettingsRuntimeContextCurrent(context)) {
        console.warn('Failed to update shared settings via API:', error);
        dispatchSettingsSaveState('error');
      }
    }
  } finally {
    waiters.forEach((resolve) => resolve());
  }
}

export const updateDesktopSettings = async (
  changes: Partial<DesktopSettings>
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
    void _flushSettingsUpdate();
  }

  _pendingSettingsChanges = { ...(_pendingSettingsChanges ?? {}), ...changes };
  _pendingSettingsContext = context;
  dispatchSettingsSaveState('saving');

  if (_settingsFlushTimer) {
    clearTimeout(_settingsFlushTimer);
  }
  const flushed = new Promise<void>((resolve) => {
    _settingsFlushWaiters.push(resolve);
  });
  _settingsFlushTimer = setTimeout(
    () => void _flushSettingsUpdate(),
    SETTINGS_DEBOUNCE_MS
  );
  return flushed;
};

export const initializeAppearancePreferences = async (): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }

  const persistApi = getPersistApi();

  try {
    const appearance = await loadAppearancePreferences();
    if (!appearance) {
      return;
    }

    const applyAppearance = () => applyAppearancePreferences(appearance);

    if (persistApi?.hasHydrated?.()) {
      applyAppearance();
      return;
    }

    applyAppearance();
    if (persistApi?.onFinishHydration) {
      const unsubscribe = persistApi.onFinishHydration(() => {
        unsubscribe?.();
        applyAppearance();
      });
    }
  } catch (error) {
    console.warn('Failed to load appearance preferences:', error);
  }
};
