import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTabletLayout, type TabletLayout } from './device';

const __dirname = dirname(fileURLToPath(import.meta.url));
const deviceSource = readFileSync(join(__dirname, 'device.ts'), 'utf8');

// No module mocking here on purpose: mock.module is process-global and would
// leak into every other test file. Outside a Capacitor shell isIPadApp() is
// already false, so a bare viewport stub isolates the geometry rules.
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

const setViewport = (width: number, height: number) => {
  // Bun exposes `window` as a non-writable global; (re)define it explicitly.
  Object.defineProperty(globalThis, 'window', {
    value: {
      innerWidth: width,
      innerHeight: height,
      // isIPadApp() reaches for the Capacitor markers; a plain web location
      // keeps it on its `false` path without mocking the module.
      location: { protocol: 'https:', search: '' },
    },
    configurable: true,
    writable: true,
  });
};

const withViewport = (width: number, height: number): TabletLayout => {
  setViewport(width, height);
  return readTabletLayout();
};

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

describe('readTabletLayout', () => {
  test('a phone stays a phone in both orientations', () => {
    expect(withViewport(390, 844).enabled).toBe(false);
    // The long side alone must never qualify — this is the case a plain
    // width threshold gets wrong.
    expect(withViewport(844, 390).enabled).toBe(false);
  });

  test('a tablet qualifies in both orientations', () => {
    expect(withViewport(834, 1194).enabled).toBe(true);
    expect(withViewport(1194, 834).enabled).toBe(true);
  });

  test('side panels need real width, so a tablet in portrait keeps the drawer', () => {
    expect(withViewport(834, 1194).roomyForPanels).toBe(false);
    expect(withViewport(1194, 834).roomyForPanels).toBe(true);
  });

  test('an unfolded foldable is a tablet but never roomy enough for panels', () => {
    // Book foldables are near-square: the long side is barely wider than a
    // tablet's short one, so both orientations keep the portrait layout.
    expect(withViewport(690, 840)).toEqual({ enabled: true, roomyForPanels: false });
    expect(withViewport(840, 690)).toEqual({ enabled: true, roomyForPanels: false });
  });

  test('folding shut drops back to the phone layout', () => {
    expect(withViewport(370, 900).enabled).toBe(false);
  });
});

describe('useTabletLayout shared subscription', () => {
  test('uses useSyncExternalStore with one global resize and one orientation listener', () => {
    expect(deviceSource).toContain('useSyncExternalStore');
    expect(deviceSource).toContain('subscribeTabletLayout');
    expect(deviceSource).toContain('readTabletLayoutSnapshot');
    // Single global listeners, not per-consumer
    expect(deviceSource).toContain("window.addEventListener('resize', scheduleTabletLayoutUpdate)");
    expect(deviceSource).toContain("window.matchMedia('(orientation: landscape)')");
    expect(deviceSource).toContain('tabletLayoutSubscribers');
  });

  test('provides stable snapshots and correct SSR cleanup', () => {
    expect(deviceSource).toContain('isSameTabletLayout');
    expect(deviceSource).toContain('DEFAULT_TABLET_LAYOUT');
    expect(deviceSource).toContain('cleanupTabletLayoutSource');
    expect(deviceSource).toContain('tabletLayoutSnapshot = null');
  });
});
