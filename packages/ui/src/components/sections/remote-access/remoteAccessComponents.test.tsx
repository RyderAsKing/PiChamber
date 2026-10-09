import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TailscaleStatus } from '@/lib/tailscale';
import { AddDeviceDialogBody } from './AddDeviceDialog';
import { TailscaleRouteRow } from './TailscaleRouteRow';
import type { TailscaleAccessApi } from './useTailscaleAccessState';
import { DesktopPasswordFields } from './DesktopLanAccessSettings';
import { DevicesSection } from './DevicesSection';
import type { AddDeviceApi } from './useAddDeviceState';
import type { DesktopLanAccessState } from './useDesktopLanAccessState';
import type { RemoteDevicesApi } from './useRemoteDevicesState';

const noop = () => undefined;

let activeTailscaleApi: TailscaleAccessApi = {
  status: null,
  initialLoading: true,
  loadFailed: false,
  loadError: null,
  actionError: null,
  actionErrorCode: null,
  mutationInFlight: false,
  pendingMode: null,
  confirmPublicOpen: false,
  setMode: noop,
  confirmPublic: noop,
  cancelPublicConfirm: noop,
  setPort: noop,
  retryNow: noop,
  reload: noop,
};

mock.module('./useTailscaleAccessState', () => ({
  useTailscaleAccessState: () => activeTailscaleApi,
}));

const tailscaleApiFor = (status: TailscaleStatus): TailscaleAccessApi => ({
  ...activeTailscaleApi,
  status,
  initialLoading: false,
});

const tailscaleStatus = (overrides: Partial<TailscaleStatus> = {}): TailscaleStatus => ({
  installed: true,
  running: true,
  loggedIn: true,
  magicDnsName: 'm.ts.net',
  httpsCertsAvailable: null,
  config: { enabled: false, mode: 'private', httpsPort: 443 },
  state: 'off',
  url: null,
  approvalUrl: null,
  errorCode: null,
  errorMessage: null,
  ...overrides,
});

const addDeviceStub = (overrides: Partial<AddDeviceApi> = {}): AddDeviceApi => ({
  open: true,
  phase: 'ready',
  creating: false,
  loopbackOnly: false,
  pairingUrl: 'pichamber://connect?v=2&p=abc',
  pairingQrDataUrl: 'data:image/png;base64,qr',
  pairingCopied: false,
  expiresAt: new Date(Date.now() + 582_000).toISOString(),
  countdownText: 'Expires in 9:42',
  announcedCountdownText: 'Expires in 9:42',
  routeChips: [
    { key: 'lan', label: 'Local network · 192.168.1.74' },
    { key: 'tailscale', label: 'Tailscale · Private' },
  ],
  error: null,
  openDialog: noop,
  closeDialog: noop,
  regenerate: noop,
  copyLink: noop,
  scrollToWays: noop,
  ...overrides,
});

const devicesStub = (overrides: Partial<RemoteDevicesApi> = {}): RemoteDevicesApi => ({
  remoteClients: [],
  pendingPairings: [],
  loading: false,
  error: null,
  revokedClientCount: 0,
  reload: noop,
  revokeRemoteClient: noop,
  purgeRevokedRemoteClients: noop,
  cancelPendingPairing: noop,
  ...overrides,
});

describe('AddDeviceDialog body', () => {
  test('ready shows QR, instruction, chips, countdown, waiting indicator, and actions', () => {
    const markup = renderToStaticMarkup(
      <AddDeviceDialogBody addDevice={addDeviceStub()} isDesktop />,
    );
    expect(markup).toContain('alt="PiChamber connection QR code"');
    expect(markup).toContain('Scan with the PiChamber app');
    expect(markup).toContain('Local network · 192.168.1.74');
    expect(markup).toContain('Tailscale · Private');
    expect(markup).toContain('Expires in 9:42');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('Waiting for device…');
    expect(markup).toContain('New code');
    expect(markup).toContain('aria-label="Copy pairing link"');
    expect(markup).not.toContain('opacity-40');
  });

  test('expired dims the QR and asks for a new code', () => {
    const markup = renderToStaticMarkup(
      <AddDeviceDialogBody
        addDevice={addDeviceStub({ phase: 'expired', countdownText: null, announcedCountdownText: null })}
        isDesktop
      />,
    );
    expect(markup).toContain('opacity-40');
    expect(markup).toContain('Code expired');
    expect(markup).toContain('New code');
    expect(markup).not.toContain('Waiting for device…');
  });

  test('creating shows a status without a QR', () => {
    const markup = renderToStaticMarkup(
      <AddDeviceDialogBody
        addDevice={addDeviceStub({
          phase: 'creating',
          creating: true,
          pairingUrl: null,
          pairingQrDataUrl: null,
          countdownText: null,
          announcedCountdownText: null,
          routeChips: [],
        })}
        isDesktop
      />,
    );
    expect(markup).toContain('Creating secure code…');
    expect(markup).not.toContain('PiChamber connection QR code');
  });

  test('errors render as an alert', () => {
    const markup = renderToStaticMarkup(
      <AddDeviceDialogBody
        addDevice={addDeviceStub({ error: 'Failed to create pairing session', pairingUrl: null, pairingQrDataUrl: null, routeChips: [] })}
        isDesktop
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Failed to create pairing session');
  });

  test('loopback-only desktop offers LAN and Tailscale setup, web offers Tailscale only', () => {
    const desktop = renderToStaticMarkup(
      <AddDeviceDialogBody
        addDevice={addDeviceStub({ loopbackOnly: true, pairingUrl: null, pairingQrDataUrl: null, routeChips: [] })}
        isDesktop
      />,
    );
    expect(desktop).toContain("Other devices can&#x27;t reach this computer yet");
    expect(desktop).toContain('Turn on Local network');
    expect(desktop).toContain('Set up Tailscale');
    expect(desktop).not.toContain('PiChamber connection QR code');

    const web = renderToStaticMarkup(
      <AddDeviceDialogBody
        addDevice={addDeviceStub({ loopbackOnly: true, pairingUrl: null, pairingQrDataUrl: null, routeChips: [] })}
        isDesktop={false}
      />,
    );
    expect(web).toContain('Set up Tailscale');
    expect(web).not.toContain('Turn on Local network');
  });
});

describe('DevicesSection', () => {
  test('empty and loading states', () => {
    expect(renderToStaticMarkup(<DevicesSection devices={devicesStub()} />)).toContain('No devices connected yet.');
    expect(renderToStaticMarkup(<DevicesSection devices={devicesStub({ loading: true })} />)).toContain('Loading devices...');
  });

  test('pending rows show a labeled cancel action', () => {
    const markup = renderToStaticMarkup(
      <DevicesSection
        devices={devicesStub({
          pendingPairings: [{ id: 'pair_1', label: 'Pair new device', expiresAt: new Date(Date.now() + 60_000).toISOString() }],
        })}
      />,
    );
    expect(markup).toContain('Waiting to connect…');
    expect(markup).toContain('aria-label="Cancel pairing for Pair new device"');
  });

  test('revoked clients disable revoke and surface clear-revoked', () => {
    const markup = renderToStaticMarkup(
      <DevicesSection
        devices={devicesStub({
          revokedClientCount: 1,
          remoteClients: [{
            id: 'c1',
            label: 'Old phone',
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
            revokedAt: new Date().toISOString(),
          }],
        })}
      />,
    );
    expect(markup).toContain('Revoked');
    expect(markup).toContain('Clear revoked');
    expect(markup).toContain('disabled');
    expect(markup).toContain('aria-label="Revoke Old phone"');
  });

  test('device errors render as an alert', () => {
    const markup = renderToStaticMarkup(
      <DevicesSection devices={devicesStub({ error: 'Failed to load' })} />,
    );
    expect(markup).toContain('role="alert"');
  });
});

describe('DesktopPasswordFields (Security)', () => {
  const lanStub = (overrides: Partial<DesktopLanAccessState> = {}): DesktopLanAccessState => ({
    isLocalDesktop: true,
    isLoading: false,
    isSaving: false,
    error: null,
    draftLanEnabled: false,
    setDraftLanEnabled: noop,
    draftPassword: '',
    handlePasswordChange: noop,
    showPassword: false,
    setShowPassword: (() => undefined) as unknown as DesktopLanAccessState['setShowPassword'],
    lanAccessActive: false,
    lanRequiresPassword: false,
    lanBlockedByMissingPassword: false,
    lanUrl: null,
    isDirty: false,
    saveDisabled: true,
    saveAndRestart: noop,
    ...overrides,
  });

  test('renders in Security with the stable focus id for the Tailscale callout', () => {
    const markup = renderToStaticMarkup(<DesktopPasswordFields lan={lanStub()} />);
    expect(markup).toContain('id="desktop-ui-password"');
    expect(markup).toContain('Desktop UI Password');
  });
});

describe('TailscaleRouteRow check-again availability', () => {
  test('not-installed shows Check again alongside Get Tailscale', () => {
    activeTailscaleApi = tailscaleApiFor(tailscaleStatus({ state: 'off', installed: false }));
    const markup = renderToStaticMarkup(<TailscaleRouteRow />);
    expect(markup).toContain('Not installed');
    expect(markup).toContain('Get Tailscale');
    expect(markup).toContain('Check again');
  });

  test('signed-out still shows Check again', () => {
    activeTailscaleApi = tailscaleApiFor(tailscaleStatus({ state: 'off', running: false }));
    const markup = renderToStaticMarkup(<TailscaleRouteRow />);
    expect(markup).toContain('Not signed in');
    expect(markup).toContain('Check again');
  });
});

describe('AddDeviceDialog chrome', () => {
  test('QR description shows only with a QR; loopback-only shows Ways to connect guidance', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'AddDeviceDialog.tsx'), 'utf8');
    // Description is inside the Base UI dialog portal (SSR renders nothing),
    // so assert the conditional in source plus the body guidance in markup.
    expect(source).toContain('showQrDescription');
    expect(source).toContain('single-use and expires');
    const loopback = renderToStaticMarkup(
      <AddDeviceDialogBody
        addDevice={{ ...addDeviceStub(), loopbackOnly: true, pairingUrl: null, pairingQrDataUrl: null, routeChips: [] }}
        isDesktop={false}
      />,
    );
    expect(loopback).toContain('Ways to connect');
    expect(loopback).toContain('--lan');
  });
});
