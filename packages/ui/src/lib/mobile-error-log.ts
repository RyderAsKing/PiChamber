import { isCapacitorApp } from '@/lib/platform';

const MAX_ENTRIES = 300;
const MAX_DETAIL_LENGTH = 240;

type MobileDiagnosticEntry = {
  at: string;
  category: string;
  code?: string;
  status?: number;
  detail?: string;
};

let entries: MobileDiagnosticEntry[] = [];
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

export const recordMobileDiagnostic = (
  category: string,
  fields: { code?: string; status?: number; detail?: unknown } = {},
): void => {
  if (!isCapacitorApp()) return;
  const entry: MobileDiagnosticEntry = {
    at: new Date().toISOString(),
    category: category.trim().slice(0, 80) || 'unknown',
    ...(fields.code ? { code: redactDetail(fields.code) } : {}),
    ...(typeof fields.status === 'number' && Number.isFinite(fields.status) ? { status: fields.status } : {}),
    ...(fields.detail !== undefined ? { detail: redactDetail(fields.detail) } : {}),
  };
  entries = [...entries, entry].slice(-MAX_ENTRIES);
};

export const recordMobileDiagnosticError = (category: string, error: unknown): void => {
  recordMobileDiagnostic(category, errorFields(error));
};

export const buildMobileErrorLog = (): string => JSON.stringify({
  format: 'pichamber-mobile-diagnostics-v1',
  generatedAt: new Date().toISOString(),
  platform: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
  entries,
}, null, 2);

export type MobileErrorLogExportResult = 'shared' | 'downloaded' | 'copied';

export const exportMobileErrorLog = async (): Promise<MobileErrorLogExportResult> => {
  const text = buildMobileErrorLog();
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    await navigator.share({
      title: 'PiChamber mobile diagnostics',
      text,
    });
    return 'shared';
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
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return 'downloaded';
  }

  throw new Error('No mobile export method is available');
};

export const startMobileErrorLogCapture = (): (() => void) => {
  if (!isCapacitorApp() || typeof window === 'undefined' || captureInstalled) return () => {};
  captureInstalled = true;

  const handleError = (event: ErrorEvent) => {
    recordMobileDiagnostic('window-error', {
      code: event.error?.name,
      detail: event.message,
    });
  };
  const handleRejection = (event: PromiseRejectionEvent) => {
    recordMobileDiagnosticError('unhandled-rejection', event.reason);
  };

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleRejection);
  return () => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleRejection);
    captureInstalled = false;
  };
};
