import { MOBILE_KEYBOARD_MODE_STORAGE_KEY, normalizeMobileKeyboardMode as normalizeMobileKeyboardModeShared, type MobileKeyboardMode as SharedMobileKeyboardMode } from './pwaKeys';

export type MobileKeyboardMode = SharedMobileKeyboardMode;

export const supportsMobileKeyboardResizeContent = (): boolean => {
  return true;
};

export function normalizeMobileKeyboardMode(value: unknown): MobileKeyboardMode;
export function normalizeMobileKeyboardMode(value: unknown, fallback: MobileKeyboardMode): MobileKeyboardMode;
export function normalizeMobileKeyboardMode(value: unknown, fallback: undefined): MobileKeyboardMode | undefined;
export function normalizeMobileKeyboardMode(
  value: unknown,
  fallback: MobileKeyboardMode | undefined = 'resize-content',
): MobileKeyboardMode | undefined {
  return normalizeMobileKeyboardModeShared(value, fallback) ?? undefined;
}

export const getStoredMobileKeyboardMode = (): MobileKeyboardMode => {
  if (typeof window === 'undefined') {
    return 'resize-content';
  }

  try {
    return normalizeMobileKeyboardMode(localStorage.getItem(MOBILE_KEYBOARD_MODE_STORAGE_KEY));
  } catch {
    return 'resize-content';
  }
};

export const setStoredMobileKeyboardMode = (value: unknown): MobileKeyboardMode => {
  const mode = normalizeMobileKeyboardMode(value);

  if (typeof window !== 'undefined') {
    try {
      if (mode === 'resize-content') {
        localStorage.removeItem(MOBILE_KEYBOARD_MODE_STORAGE_KEY);
      } else {
        localStorage.setItem(MOBILE_KEYBOARD_MODE_STORAGE_KEY, mode);
      }
    } catch {
      // Ignore storage failures in restricted browsing contexts.
    }
  }

  return mode;
};
