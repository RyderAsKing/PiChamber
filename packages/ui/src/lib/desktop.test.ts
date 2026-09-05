import { describe, expect, test } from 'bun:test';

import {
  getDesktopProcessPerformanceRecording,
  isBrowserClientRuntime,
  setDesktopProcessPerformanceRecording,
} from './desktop';

const withLocalDesktopBridge = async <T>(
  invoke: (command: string, args: Record<string, unknown>) => unknown,
  run: () => Promise<T>,
): Promise<T> => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __PICHAMBER_ELECTRON__: { runtime: 'electron' },
      __PICHAMBER_DESKTOP__: { invoke },
      location: { origin: 'http://127.0.0.1:57123' },
    },
  });
  try {
    return await run();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
};

describe('desktop process performance recording', () => {
  test('reads and updates recording through the desktop bridge', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    await withLocalDesktopBridge((command, args) => {
      calls.push({ command, args });
      return { supported: true, enabled: command.startsWith('desktop_set'), active: command.startsWith('desktop_set') };
    }, async () => {
      expect(await getDesktopProcessPerformanceRecording()).toEqual({
        supported: true,
        enabled: false,
        active: false,
      });
      expect(await setDesktopProcessPerformanceRecording(true)).toEqual({
        supported: true,
        enabled: true,
        active: true,
      });
    });

    expect(calls).toEqual([
      { command: 'desktop_get_process_performance_recording', args: {} },
      { command: 'desktop_set_process_performance_recording', args: { enabled: true } },
    ]);
  });

  test('rejects malformed recorder status', async () => {
    await withLocalDesktopBridge(() => ({ supported: true, enabled: true }), async () => {
      expect(await getDesktopProcessPerformanceRecording()).toBeNull();
    });
  });
});

describe('browser client runtime', () => {
  test('uses browser file behavior only outside the Electron shell', () => {
    expect(isBrowserClientRuntime('web', false)).toBe(true);
    expect(isBrowserClientRuntime('web', true)).toBe(false);
  });

  test('keeps desktop runtime behavior out of browser-only flows', () => {
    expect(isBrowserClientRuntime('desktop', false)).toBe(false);
  });
});
