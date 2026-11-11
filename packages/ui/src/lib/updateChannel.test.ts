import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { defaultMobileUpdateChannel, getMobileUpdateChannel, setMobileUpdateChannel } from './updateChannel';

const STORAGE_KEY = 'pichamber.mobileUpdateChannel';

// Bun runs these tests without a DOM; give them a window with an in-memory localStorage.
const installWindow = () => {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  };
};

describe('mobile update channel', () => {
  beforeEach(installWindow);
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test('a release candidate install follows release candidates until a channel is picked', () => {
    expect(defaultMobileUpdateChannel('1.0.6-rc.4')).toBe('rc');
    expect(defaultMobileUpdateChannel('1.0.5')).toBe('stable');
    expect(defaultMobileUpdateChannel('1.0.6-beta.1')).toBe('stable');
    expect(defaultMobileUpdateChannel(undefined)).toBe('stable');
    expect(getMobileUpdateChannel('1.0.6-rc.4')).toBe('rc');
  });

  test('a picked channel wins over the version default, including Stable on an RC install', () => {
    setMobileUpdateChannel('stable');
    expect(getMobileUpdateChannel('1.0.6-rc.4')).toBe('stable');
    setMobileUpdateChannel('rc');
    expect(getMobileUpdateChannel('1.0.5')).toBe('rc');
  });

  test('without a window, the version default applies', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(getMobileUpdateChannel('1.0.6-rc.4')).toBe('rc');
  });

  test('an unknown stored value falls back to the version default', () => {
    window.localStorage.setItem(STORAGE_KEY, 'nightly');
    expect(getMobileUpdateChannel('1.0.6-rc.4')).toBe('rc');
    expect(getMobileUpdateChannel('1.0.5')).toBe('stable');
  });
});
