import { isCapacitorApp } from '@/lib/platform';
import i18n from '@/i18n';

const STORAGE_KEY = 'pichamber.mobile.diagnostics.v1';
const MAX_ENTRIES = 300;
const MAX_DETAIL_LENGTH = 240;
const PERSIST_DEBOUNCE_MS = 1000;

type MobileDiagnosticEntry = {
  at: string;
  category: string;
  code?: string;
  status?: number;
  detail?: string;
};

let entries: MobileDiagnosticEntry[] = [];
let loadedFromStorage = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let captureInstalled = false;

const redactDetail = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const text = String(value)
    .replace(/(?:authorization|proxy-authorization)\s*:\s*bearer\s+[^\s,;]+/gi, 'authorization=[redacted]')
    .replace(
      /\b(bearer|token|password|secret|api[-_]?key)\b(?:\s*[:=]\s*|\s+)[^\s,;]+/gi,
      '$1=[redacted]',
    )
    .replace(/(?:https?|wss?):\/\/[^\s"'`]+/gi, '[url]')
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:home|Users|data|storage|private|var)\/)[^\s"'`]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL_LENGTH);
  return text || undefined;
};

const errorFields = (error: unknown): Pick<MobileDiagnosticEntry, 'code' | 'status' | 'detail'> => {
  if (!error || typeof error !== 'object') {
    return { detail: redactDetail(error) };
  }
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    status?: unknown;
  };
  return {
    ...(typeof candidate.code === 'string' ? { code: redactDetail(candidate.code) } : {}),
    ...(typeof candidate.status === 'number' && Number.isFinite(candidate.status) ? { status: candidate.status } : {}),
    ...(candidate.message !== undefined
      ? { detail: redactDetail(candidate.message) }
      : typeof candidate.name === 'string'
        ? { detail: redactDetail(candidate.name) }
        : {}),
  };
};

const getLocalStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const ensureLoaded = (): void => {
  if (loadedFromStorage) return;
  loadedFromStorage = true;
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const valid: MobileDiagnosticEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const candidate = item as Partial<Record<keyof MobileDiagnosticEntry, unknown>>;
      const at = typeof candidate.at === 'string' ? candidate.at : null;
      const category = typeof candidate.category === 'string' ? candidate.category : null;
      if (!at || !category) continue;
      const entry: MobileDiagnosticEntry = {
        at,
        category,
        ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
        ...(typeof candidate.status === 'number' && Number.isFinite(candidate.status)
          ? { status: candidate.status }
          : {}),
        ...(typeof candidate.detail === 'string' ? { detail: candidate.detail } : {}),
      };
      valid.push(entry);
    }
    entries = [...valid, ...entries].slice(-MAX_ENTRIES);
  } catch {
    // Malformed JSON or storage access denial: start empty and do not throw
  }
};

const clearSaveTimer = (): void => {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
};

const schedulePersist = (): void => {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushMobileDiagnostics();
  }, PERSIST_DEBOUNCE_MS);
};

export const flushMobileDiagnostics = (): void => {
  clearSaveTimer();
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    ensureLoaded();
    storage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // Storage quota or privacy mode error: do not throw
  }
};

export const recordMobileDiagnostic = (
  category: string,
  fields: { code?: string; status?: number; detail?: unknown } = {},
): void => {
  if (!isCapacitorApp()) return;
  ensureLoaded();
  const entry: MobileDiagnosticEntry = {
    at: new Date().toISOString(),
    category: category.trim().slice(0, 80) || 'unknown',
    ...(fields.code ? { code: redactDetail(fields.code) } : {}),
    ...(typeof fields.status === 'number' && Number.isFinite(fields.status) ? { status: fields.status } : {}),
    ...(fields.detail !== undefined ? { detail: redactDetail(fields.detail) } : {}),
  };
  entries = [...entries, entry].slice(-MAX_ENTRIES);
  schedulePersist();
};

export const recordMobileDiagnosticError = (category: string, error: unknown): void => {
  recordMobileDiagnostic(category, errorFields(error));
};

export const buildMobileErrorLog = (): string => {
  ensureLoaded();
  return JSON.stringify({
    format: 'pichamber-mobile-diagnostics-v1',
    generatedAt: new Date().toISOString(),
    platform: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
    entries,
  }, null, 2);
};

export type MobileErrorLogExportResult = 'shared' | 'downloaded' | 'copied';

export const exportMobileErrorLog = async (): Promise<MobileErrorLogExportResult> => {
  const text = buildMobileErrorLog();
  // Loaded lazily so this always-imported module stays free of Capacitor plugins.
  const { isShareCancelledError, saveOrShareFile } = await import('@/lib/nativeFileSave');
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: i18n.t('PiChamber mobile diagnostics'),
        text,
      });
      return 'shared';
    } catch (error) {
      if (isShareCancelledError(error)) {
        throw new Error('Diagnostics export was cancelled');
      }
    }
  }

  // Android WebView has no navigator.share; use the native share sheet.
  const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  if (capacitor?.getPlatform?.() === 'android') {
    try {
      await saveOrShareFile({
        filename: 'pichamber-mobile-diagnostics.json',
        mimeType: 'application/json',
        data: text,
      });
      return 'shared';
    } catch {
      // Older native build without the plugin: fall back to the clipboard.
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return 'copied';
  }

  if (typeof document !== 'undefined') {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'pichamber-mobile-diagnostics.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return 'downloaded';
  }

  throw new Error(i18n.t('No mobile export method is available'));
};

export const startMobileErrorLogCapture = (): (() => void) => {
  if (!isCapacitorApp() || typeof window === 'undefined' || captureInstalled) return () => {};
  captureInstalled = true;
  ensureLoaded();
  recordMobileDiagnostic('app-launch', { code: 'start' });

  const handleError = (event: ErrorEvent) => {
    recordMobileDiagnostic('window-error', {
      code: event.error?.name,
      detail: event.message,
    });
  };
  const handleRejection = (event: PromiseRejectionEvent) => {
    recordMobileDiagnosticError('unhandled-rejection', event.reason);
  };
  const handlePageHide = () => {
    flushMobileDiagnostics();
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      flushMobileDiagnostics();
    }
  };

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleRejection);
  window.addEventListener('pagehide', handlePageHide);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleRejection);
    window.removeEventListener('pagehide', handlePageHide);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    flushMobileDiagnostics();
    captureInstalled = false;
  };
};

export const __resetMobileErrorLogForTests = (): void => {
  clearSaveTimer();
  entries = [];
  loadedFromStorage = false;
  captureInstalled = false;
};
