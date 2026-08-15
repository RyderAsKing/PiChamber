/**
 * Canonical localStorage keys for PWA persistence.
 *
 * Both the React-side writers (this package) and the pre-React readers in
 * `packages/web/index.html` must use these constants. The TypeScript constants
 * are exported here and the matching `<script>` literals in `index.html` are
 * locked to the same strings by `packages/web/server/lib/pwa-keys-contract.test.ts`.
 */

export const PWA_NAME_STORAGE_KEY = 'pichamber.pwaName';
export const PWA_ORIENTATION_STORAGE_KEY = 'pichamber.pwaOrientation';
export const MOBILE_KEYBOARD_MODE_STORAGE_KEY = 'pichamber.mobileKeyboardMode';
export const PWA_RECENT_SESSIONS_STORAGE_KEY = 'pichamber.pwaRecentSessions';

// Frozen tuple used by the contract test and the inline `index.html` reader.

export type PwaOrientation = 'system' | 'portrait' | 'landscape';

const PWA_ORIENTATION_VALUES: ReadonlyArray<PwaOrientation> = ['system', 'portrait', 'landscape'];

export function normalizePwaOrientation(value: unknown, fallback: PwaOrientation = 'system'): PwaOrientation | undefined {
  if (typeof value === 'string' && (PWA_ORIENTATION_VALUES as ReadonlyArray<string>).includes(value)) {
    return value as PwaOrientation;
  }
  return fallback;
}

export type MobileKeyboardMode = 'native' | 'resize-content';

const MOBILE_KEYBOARD_MODE_VALUES: ReadonlyArray<MobileKeyboardMode> = ['native', 'resize-content'];

export function normalizeMobileKeyboardMode(value: unknown, fallback: MobileKeyboardMode = 'resize-content'): MobileKeyboardMode | undefined {
  if (typeof value === 'string' && (MOBILE_KEYBOARD_MODE_VALUES as ReadonlyArray<string>).includes(value)) {
    return value as MobileKeyboardMode;
  }
  return fallback;
}

export const PWA_NAME_MAX_LENGTH = 64;
export const PWA_RECENT_TITLE_MAX_LENGTH = 48;
export const PWA_RECENT_SHORTCUT_LIMIT = 3;
export const PWA_RECENT_SESSION_ID_MAX_LENGTH = 160;

export function normalizePwaName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return fallback;
  }
  return normalized.slice(0, PWA_NAME_MAX_LENGTH);
}
