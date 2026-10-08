import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServerList } from './ServerList';
import { ServerRow } from './ServerRow';
import { AddServerDialogBody } from './AddServerDialog';
import {
  desktopHostToServerListItem,
  sortServerListItems,
  type ServerListItem,
} from '@/lib/servers/serverViewModel';

const redactUrl = (raw: string): string =>
  raw.replace(/([?&]t=)[^&]*/, '$1[REDACTED]');

const noop = () => undefined;

/**
 * Representative desktop harness: current local host, a connected Tailscale
 * host, an offline relay-only host, and a sign-in-required host. Electron
 * runtime verification is pending (desktop shell only); these SSR assertions
 * cover the shared markup contract instead.
 */
const harnessItems = (): ServerListItem[] => {
  const raw = [
    desktopHostToServerListItem(
      { id: 'local', label: 'Local', url: 'http://127.0.0.1:4020' },
      {
        isCurrent: true,
        isDefault: true,
        isLocal: true,
        probe: { status: 'ok', latencyMs: 3 },
        probing: false,
        localOrigin: 'http://127.0.0.1:4020',
        redactUrl,
      },
    ),
    desktopHostToServerListItem(
      {
        id: 'tail',
        label: 'Studio',
        url: 'https://studio.tail-scale.ts.net',
        apiUrl: 'https://studio.tail-scale.ts.net',
      },
      {
        isCurrent: false,
        isDefault: false,
        isLocal: false,
        probe: { status: 'ok', latencyMs: 42 },
        probing: false,
        redactUrl,
      },
    ),
    desktopHostToServerListItem(
      {
        id: 'relay',
        label: 'Cabin',
        url: 'relay://server-id-abc',
        relay: { relayUrl: 'wss://relay.example', serverId: 'server-id-abc' },
      },
      {
        isCurrent: false,
        isDefault: false,
        isLocal: false,
        probe: { status: 'unreachable', latencyMs: 0 },
        probing: false,
        redactUrl,
      },
    ),
    desktopHostToServerListItem(
      {
        id: 'office',
        label: 'Office',
        url: 'https://office.example.com',
        apiUrl: 'https://office.example.com',
      },
      {
        isCurrent: false,
        isDefault: true,
        isLocal: false,
        probe: { status: 'auth', latencyMs: 31 },
        probing: false,
        redactUrl,
      },
    ),
  ];
  return sortServerListItems(raw);
};

describe('ServerRow', () => {
  test('renders current/default badges, route chips, status, and address', () => {
    const [current] = harnessItems();
    const markup = renderToStaticMarkup(
      <ServerRow
        item={current!}
        onSwitch={noop}
        onSetDefault={noop}
        onOpenInNewWindow={noop}
      />,
    );
    expect(markup).toContain('Local');
    expect(markup).toContain('Current');
    expect(markup).toContain('This computer');
    expect(markup).toContain('Connected');
    expect(markup).toContain('http://127.0.0.1:4020');
    expect(markup).toContain('aria-label="Actions for Local"');
    expect(markup).toContain('aria-label="Default server Local"');
  });

  test('tailscale host shows the Tailscale chip and latency', () => {
    const tail = harnessItems().find((entry) => entry.id === 'tail')!;
    const markup = renderToStaticMarkup(
      <ServerRow item={tail} onSwitch={noop} onSetDefault={noop} />,
    );
    expect(markup).toContain('Tailscale');
    expect(markup).toContain('Connected');
    expect(markup).toContain('42ms');
    expect(markup).toContain('aria-label="Switch to Studio"');
    expect(markup).toContain('aria-label="Set Studio as default server"');
  });

  test('relay-only host shows the relay label and no pseudo-url', () => {
    const relay = harnessItems().find((entry) => entry.id === 'relay')!;
    const markup = renderToStaticMarkup(<ServerRow item={relay} onRemove={noop} />);
    expect(markup).toContain('PiChamber Relay');
    expect(markup).toContain('Offline');
    expect(markup).not.toContain('relay://');
    // No switch handler: no switch button, no actions menu without handlers
    // other than remove — remove lives behind the menu trigger.
    expect(markup).toContain('aria-label="Actions for Cabin"');
  });

  test('sign-in-required host keeps its address with the new vocabulary', () => {
    const office = harnessItems().find((entry) => entry.id === 'office')!;
    const markup = renderToStaticMarkup(<ServerRow item={office} onEdit={noop} />);
    expect(markup).toContain('Sign-in required');
    expect(markup).toContain('https://office.example.com');
    expect(markup).not.toContain('Auth required');
  });

  test('mixed transports render a radiogroup with the active route checked', () => {
    const mixed = desktopHostToServerListItem(
      {
        id: 'm',
        label: 'Studio',
        url: 'http://192.168.1.74:4020',
        apiUrl: 'http://192.168.1.74:4020',
        relay: { relayUrl: 'wss://relay.example', serverId: 'sid' },
      },
      {
        isCurrent: false,
        isDefault: false,
        isLocal: false,
        probe: { status: 'ok', latencyMs: 210, via: 'relay' },
        probing: false,
        redactUrl,
      },
    );
    const markup = renderToStaticMarkup(<ServerRow item={mixed} />);
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="Connection routes for Studio"');
    expect(markup).toContain('Local network');
    expect(markup).toContain('PiChamber Relay');
    expect(markup).toContain('aria-checked="true"');
  });

  test('blocked statuses disable defaulting when guarded', () => {
    const relay = harnessItems().find((entry) => entry.id === 'relay')!;
    const guarded = renderToStaticMarkup(
      <ServerRow item={relay} onSetDefault={noop} guardDefaultByStatus />,
    );
    expect(guarded).toContain('disabled');
    const unguarded = renderToStaticMarkup(
      <ServerRow item={relay} onSetDefault={noop} />,
    );
    expect(unguarded).not.toContain('disabled');
  });
});

describe('ServerList', () => {
  test('rows render in order with an empty state', () => {
    const items = harnessItems();
    const markup = renderToStaticMarkup(
      <ServerList items={items} onSwitch={noop} emptyMessage="No other servers added yet." />,
    );
    expect(markup).toContain('role="list"');
    // Current local host sorts first.
    expect(markup.indexOf('Local')).toBeLessThan(markup.indexOf('Studio'));
    expect(
      renderToStaticMarkup(<ServerList items={[]} emptyMessage="No other servers added yet." />),
    ).toContain('No other servers added yet.');
  });
});

describe('AddServerDialog', () => {
  const bodyProps = {
    open: true,
    onStepChange: noop,
    onClose: noop,
    onImportLink: noop,
    onAddManual: noop,
  };

  test('menu hides Scan QR code when canScanQr is false', () => {
    const markup = renderToStaticMarkup(<AddServerDialogBody {...bodyProps} step="menu" canScanQr={false} />);
    expect(markup).toContain('Paste a pairing link');
    expect(markup).toContain('Enter address manually');
    expect(markup).not.toContain('Scan QR code');
  });

  test('menu shows Scan QR code when canScanQr is true', () => {
    const markup = renderToStaticMarkup(
      <AddServerDialogBody {...bodyProps} step="menu" canScanQr onScanQr={noop} />,
    );
    expect(markup).toContain('Scan QR code');
  });

  test('link step renders the import form and error', () => {
    const markup = renderToStaticMarkup(
      <AddServerDialogBody
        {...bodyProps}
        step="link"
        canScanQr={false}
        importError="Invalid PiChamber connection link."
      />,
    );
    expect(markup).toContain('pichamber://connect');
    expect(markup).toContain('Import link');
    expect(markup).toContain('role="alert"');
  });

  test('manual step renders the address form with headers', () => {
    const markup = renderToStaticMarkup(
      <AddServerDialogBody {...bodyProps} step="manual" canScanQr={false} />,
    );
    expect(markup).toContain('https://host:port');
    expect(markup).toContain('Connection token');
    expect(markup).toContain('Additional headers');
    expect(markup).toContain('Add server');
  });
});
