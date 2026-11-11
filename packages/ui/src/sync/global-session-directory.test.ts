import { afterEach, describe, expect, mock, test } from 'bun:test';

let localOrigin = true;

mock.module('@/lib/desktop', () => ({
  isDesktopLocalOriginActive: () => localOrigin,
}));

mock.module('@/stores/utils/safeStorage', () => ({
  getDeferredSafeStorage: () => ({ getItem: () => null }),
}));

const { getGlobalSessionDirectories } = await import('./global-session-directory');

describe('getGlobalSessionDirectories', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    localOrigin = true;
  });

  test("uses the desktop app's own home on its built-in server", () => {
    (globalThis as { window?: unknown }).window = { __PICHAMBER_HOME__: 'C:/Users/Home PC' };
    expect(getGlobalSessionDirectories('C:/Users/Home PC')).toEqual(['~', 'C:/Users/Home PC']);
  });

  test("leaves out the desktop app's home on a remote server", () => {
    localOrigin = false;
    (globalThis as { window?: unknown }).window = { __PICHAMBER_HOME__: 'C:/Users/Home PC' };
    expect(getGlobalSessionDirectories('/root')).toEqual(['~', '/root']);
  });
});
