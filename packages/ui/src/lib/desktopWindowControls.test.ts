import { describe, expect, test } from 'bun:test';

import { usesFramelessElectronChrome } from './desktopWindowControls';

const setWindowGlobals = (values: {
  electronRuntime?: string;
  platform?: string | null;
}) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const nextWindow: Record<string, unknown> = {};
  if (values.electronRuntime !== undefined) {
    nextWindow.__PICHAMBER_ELECTRON__ = { runtime: values.electronRuntime };
  }
  if (values.platform !== undefined && values.platform !== null) {
    nextWindow.__PICHAMBER_PLATFORM__ = values.platform;
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: nextWindow,
  });
  return () => {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  };
};

describe('desktop window chrome', () => {
  test('uses frameless classic controls only on Windows and Linux Electron shells', () => {
    for (const platform of ['win32', 'linux']) {
      const restore = setWindowGlobals({ electronRuntime: 'electron', platform });
      try {
        expect(usesFramelessElectronChrome()).toBe(true);
      } finally {
        restore();
      }
    }
  });

  test('macOS Electron keeps native OS-owned traffic lights (no in-app chrome)', () => {
    const restore = setWindowGlobals({ electronRuntime: 'electron', platform: 'darwin' });
    try {
      expect(usesFramelessElectronChrome()).toBe(false);
    } finally {
      restore();
    }
  });

  test('web and mobile runtimes render no window chrome', () => {
    const restoreBrowser = setWindowGlobals({});
    try {
      expect(usesFramelessElectronChrome()).toBe(false);
    } finally {
      restoreBrowser();
    }

    const restoreNonElectron = setWindowGlobals({ electronRuntime: 'web', platform: 'win32' });
    try {
      expect(usesFramelessElectronChrome()).toBe(false);
    } finally {
      restoreNonElectron();
    }
  });
});
