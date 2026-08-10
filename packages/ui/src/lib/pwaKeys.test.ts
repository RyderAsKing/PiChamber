import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  MOBILE_KEYBOARD_MODE_STORAGE_KEY,
  PWA_NAME_STORAGE_KEY,
  PWA_ORIENTATION_STORAGE_KEY,
  PWA_RECENT_SESSIONS_STORAGE_KEY,
  PWA_RECENT_SESSION_ID_MAX_LENGTH,
  PWA_RECENT_TITLE_MAX_LENGTH,
  PWA_RECENT_SHORTCUT_LIMIT,
  PWA_NAME_MAX_LENGTH,
  normalizeMobileKeyboardMode,
  normalizePwaName,
  normalizePwaOrientation,
} from './pwaKeys';

const buildMemoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key) : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
  };
};

const installStorage = () => {
  const storage = buildMemoryStorage();
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window: unknown }).window = { localStorage: storage };
  return {
    storage,
    restore() {
      (globalThis as { window: unknown }).window = originalWindow;
    },
  };
};

describe('pwaKeys constants', () => {
  test('key constants match the planned pichamber.* names', () => {
    expect(PWA_NAME_STORAGE_KEY).toBe('pichamber.pwaName');
    expect(PWA_ORIENTATION_STORAGE_KEY).toBe('pichamber.pwaOrientation');
    expect(MOBILE_KEYBOARD_MODE_STORAGE_KEY).toBe('pichamber.mobileKeyboardMode');
    expect(PWA_RECENT_SESSIONS_STORAGE_KEY).toBe('pichamber.pwaRecentSessions');
  });

  test('preserves existing normalization limits', () => {
    expect(PWA_NAME_MAX_LENGTH).toBe(64);
    expect(PWA_RECENT_TITLE_MAX_LENGTH).toBe(48);
    expect(PWA_RECENT_SHORTCUT_LIMIT).toBe(3);
    expect(PWA_RECENT_SESSION_ID_MAX_LENGTH).toBe(160);
  });
});

describe('normalizePwaName', () => {
  test('trims and collapses whitespace, then caps length', () => {
    const long = 'x'.repeat(PWA_NAME_MAX_LENGTH + 10);
    const normalized = normalizePwaName(`   ${long}   `, 'fallback');
    expect(normalized.length).toBe(PWA_NAME_MAX_LENGTH);
  });

  test('falls back when value is empty or non-string', () => {
    expect(normalizePwaName('', 'fallback')).toBe('fallback');
    expect(normalizePwaName('   ', 'fallback')).toBe('fallback');
    expect(normalizePwaName(null, 'fallback')).toBe('fallback');
    expect(normalizePwaName(undefined, 'fallback')).toBe('fallback');
  });
});

describe('normalizeMobileKeyboardMode', () => {
  test('returns native/resize-content for known values', () => {
    expect(normalizeMobileKeyboardMode('native')).toBe('native');
    expect(normalizeMobileKeyboardMode('resize-content')).toBe('resize-content');
  });
  test('returns fallback for unknown values', () => {
    expect(normalizeMobileKeyboardMode('weird', 'resize-content')).toBe('resize-content');
    expect(normalizeMobileKeyboardMode(null)).toBe('resize-content');
    expect(normalizeMobileKeyboardMode(null, 'native')).toBe('native');
  });
});

describe('normalizePwaOrientation', () => {
  test('returns system/portrait/landscape for known values', () => {
    expect(normalizePwaOrientation('system')).toBe('system');
    expect(normalizePwaOrientation('portrait')).toBe('portrait');
    expect(normalizePwaOrientation('landscape')).toBe('landscape');
  });
  test('returns fallback for unknown values', () => {
    expect(normalizePwaOrientation('upside-down', 'system')).toBe('system');
    expect(normalizePwaOrientation(null)).toBe('system');
  });
});

describe('localStorage round-trip', () => {
  let harness: ReturnType<typeof installStorage>;

  beforeEach(() => {
    harness = installStorage();
  });

  afterEach(() => {
    harness.restore();
  });

  test('PWA_NAME_STORAGE_KEY survives a write+remove round-trip', () => {
    harness.storage.setItem(PWA_NAME_STORAGE_KEY, normalizePwaName('  PiChamber   Install ', ''));
    expect(harness.storage.getItem(PWA_NAME_STORAGE_KEY)).toBe('PiChamber Install');
    harness.storage.removeItem(PWA_NAME_STORAGE_KEY);
    expect(harness.storage.getItem(PWA_NAME_STORAGE_KEY)).toBeNull();
  });

  test('MOBILE_KEYBOARD_MODE_STORAGE_KEY round-trips correctly', () => {
    harness.storage.setItem(MOBILE_KEYBOARD_MODE_STORAGE_KEY, 'native');
    expect(normalizeMobileKeyboardMode(harness.storage.getItem(MOBILE_KEYBOARD_MODE_STORAGE_KEY))).toBe('native');
  });

  test('PWA_RECENT_SESSIONS_STORAGE_KEY survives serialization', () => {
    const signature = JSON.stringify([
      { sessionId: 'ses_alpha', title: 'Plan migration' },
    ]);
    harness.storage.setItem(PWA_RECENT_SESSIONS_STORAGE_KEY, signature);
    expect(harness.storage.getItem(PWA_RECENT_SESSIONS_STORAGE_KEY)).toBe(signature);
  });
});
