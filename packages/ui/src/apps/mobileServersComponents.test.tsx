import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MobileServersManager } from './MobileServersManager';
import { MobileConnectionWelcome } from './MobileConnectionWelcome';
import { SidebarHeader } from '@/components/session/sidebar/SidebarHeader';

const STORAGE_KEY = 'pichamber.mobile.connections.v1';
const noop = () => undefined;

const originalWindow = globalThis.window;

const installTestWindow = (connections: unknown[], capacitor = false) => {
  const store = new Map<string, string>([[STORAGE_KEY, JSON.stringify(connections)]]);
  // PiChamberLogo reads theme CSS vars during render; stub the CSSOM surface
  // it touches so SSR stays focused on the markup under test.
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: {} },
  });
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: () => ({ getPropertyValue: () => '' }),
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      matchMedia: () => ({ matches: false }),
      location: { protocol: capacitor ? 'capacitor:' : 'https:' },
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    },
  });
};

const originalDocument = globalThis.document;
const originalGetComputedStyle = (globalThis as Record<string, unknown>).getComputedStyle;

const restoreWindow = () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: originalGetComputedStyle });
};

const lanRow = {
  id: 'lan',
  label: 'Studio LAN',
  candidates: [{ kind: 'direct', url: 'http://192.168.1.74:2606' }],
  lastUsedAt: 2,
  clientToken: 'tok',
};

const relayRow = {
  id: 'relay',
  label: 'Cabin',
  candidates: [
    {
      kind: 'relay',
      relay: {
        relayUrl: 'wss://relay.example/tunnel',
        serverId: 'srv_cabin',
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' },
      },
    },
  ],
  lastUsedAt: 1,
  clientToken: 'tok-relay',
};

describe('MobileServersManager', () => {
  test('renders shared ServerRow rows in touch layout with Connect labels', () => {
    try {
      installTestWindow([lanRow, relayRow]);
      const markup = renderToStaticMarkup(
        <MobileServersManager onConnect={noop} onActiveConnectionDeleted={noop} />,
      );
      // Touch layout: rows render the switch affordance with the mobile label.
      expect(markup).toContain('aria-label="Connect to Studio LAN"');
      expect(markup).toContain('aria-label="Connect to Cabin"');
      // Route chips from the shared view-model, not per-connection custom rows.
      expect(markup).toContain('Local network');
      expect(markup).toContain('PiChamber Relay');
      // The relay pseudo-URL never reaches the UI.
      expect(markup).not.toContain('relay://');
      // Adding goes through the shared dialog entry point.
      expect(markup).toContain('Add server');
    } finally {
      restoreWindow();
    }
  });

  test('empty state uses server wording', () => {
    try {
      installTestWindow([]);
      const markup = renderToStaticMarkup(
        <MobileServersManager onConnect={noop} onActiveConnectionDeleted={noop} />,
      );
      expect(markup).toContain('No saved servers yet.');
      expect(markup).not.toContain('No saved connections yet.');
      expect(markup).not.toContain('Instances');
    } finally {
      restoreWindow();
    }
  });
});

describe('MobileConnectionWelcome', () => {
  test('saved servers render through the shared touch list with server wording', () => {
    try {
      installTestWindow([lanRow, relayRow]);
      const markup = renderToStaticMarkup(<MobileConnectionWelcome onConnected={noop} />);
      expect(markup).toContain('Saved servers');
      expect(markup).not.toContain('Saved connections');
      expect(markup).toContain('aria-label="Connect to Studio LAN"');
      expect(markup).toContain('Local network');
      expect(markup).toContain('PiChamber Relay');
      expect(markup).not.toContain('relay://');
    } finally {
      restoreWindow();
    }
  });

  test('Scan QR stays the primary action where supported', () => {
    try {
      installTestWindow([lanRow], true);
      // Capacitor shell with a barcode plugin: QR entry is available.
      (window as unknown as { Capacitor: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        Plugins: { BarcodeScanner: { scan: async () => undefined } },
      };
      const markup = renderToStaticMarkup(<MobileConnectionWelcome onConnected={noop} />);
      expect(markup).toContain('Scan QR code');
    } finally {
      restoreWindow();
    }
  });
});

describe('mobile Servers sidebar entry', () => {
  test('header entry reads Servers with a Servers aria label', () => {
    const markup = renderToStaticMarkup(
      <SidebarHeader
        hideDirectoryControls={false}
        handleOpenDirectoryDialog={noop}
        onOpenArchive={noop}
        onOpenInstances={noop}
        instanceLabel="Studio LAN"
        headerActionIconClass="size-4"
        headerActionButtonClass="size-10"
        isSessionSearchOpen={false}
        setIsSessionSearchOpen={noop}
        sessionSearchInputRef={{ current: null }}
        sessionSearchQuery=""
        setSessionSearchQuery={noop}
        hasSessionSearchQuery={false}
        searchMatchCount={0}
        selectionModeEnabled={false}
        onToggleSelectionMode={noop}
      />,
    );
    expect(markup).toContain('aria-label="Servers: Studio LAN"');
    expect(markup).not.toContain('Instances');
  });
});
