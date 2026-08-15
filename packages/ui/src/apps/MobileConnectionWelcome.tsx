import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
import { cn } from '@/lib/utils';

import { connectionDisplayUrl, useMobileConnection } from './mobileConnections';
import { isQrScanSupported, parseConnectionPayload, scanConnectionQr } from './mobileQrScan';
import { mobileConnectionInputClass, mobileInputKeyboardProps } from './mobileConnectionUi';
import { MobileQrConnectionLoading, MobileQrScannerOverlay } from './MobileQrScannerOverlay';

export type MobileConnectionNotice = {
  kind: 'unreachable' | 'auth-expired';
  label: string;
};

export const MobileConnectionWelcome: React.FC<{
  onConnected: () => void;
  /** Why the user landed here (failed cold-launch auto-connect) — shown as a banner. */
  notice?: MobileConnectionNotice | null;
}> = ({ onConnected, notice = null }) => {
  const conn = useMobileConnection(onConnected);
  const { connections, isBusy, isPasswordBusy, error, pendingConnection } = conn;
  const [serverUrl, setServerUrl] = React.useState('');
  const [connectionName, setConnectionName] = React.useState('');
  const [clientToken, setClientToken] = React.useState('');
  const [isScanning, setIsScanning] = React.useState(false);
  const [isCompletingScan, setIsCompletingScan] = React.useState(false);
  const scanAbortRef = React.useRef<AbortController | null>(null);
  const qrScanSupported = React.useMemo(() => isQrScanSupported(), []);
  // QR pairing is the primary flow; the manual URL form stays collapsed unless
  // scanning is unavailable (web build) or the user asks for it.
  const [manualOpen, setManualOpen] = React.useState(() => !isQrScanSupported());
  // Which saved connection is being connected to, for the per-row spinner.
  const [connectingId, setConnectingId] = React.useState<string | null>(null);
  const [password, setPassword] = React.useState('');

  const handleSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void conn.connect({ url: serverUrl, clientToken, label: connectionName });
  }, [clientToken, conn, connectionName, serverUrl]);

  // Accept a pasted pairing link (openchamber://connect?...) in the URL field and
  // split it back into the server URL + token.
  const handleUrlChange = React.useCallback((value: string) => {
    if (/^openchamber:\/\//i.test(value.trim())) {
      const payload = parseConnectionPayload(value);
      if (payload) {
        if ('pairing' in payload) {
          void conn.redeemPairingConnection(payload.pairing);
          return;
        }
        setServerUrl(payload.url);
        if (payload.label) setConnectionName(payload.label);
        if (payload.clientToken) setClientToken(payload.clientToken);
        return;
      }
    }
    setServerUrl(value);
  }, [conn]);

  const handleScanQr = React.useCallback(async () => {
    if (scanAbortRef.current || isBusy) return;
    conn.setError(null);
    setIsScanning(true);
    const controller = new AbortController();
    scanAbortRef.current = controller;
    try {
      const result = await scanConnectionQr({ signal: controller.signal });
      if (scanAbortRef.current === controller) {
        scanAbortRef.current = null;
        setIsScanning(false);
      }
      switch (result.status) {
        case 'ok':
          setIsCompletingScan(true);
          setServerUrl(result.url);
          if (result.label) setConnectionName(result.label);
          if (result.clientToken) setClientToken(result.clientToken);
          await conn.connect({ url: result.url, clientToken: result.clientToken, label: result.label });
          break;
        case 'pairing':
          setIsCompletingScan(true);
          await conn.redeemPairingConnection(result.pairing);
          break;
        case 'permission-denied':
          conn.setError("Camera access is off. Enable it in Settings to scan a QR code.");
          break;
        case 'invalid':
          conn.setError("That QR code is not an PiChamber connection code.");
          break;
        case 'unsupported':
          conn.setError("QR scanning is only available in the installed mobile app.");
          break;
        case 'failed':
          conn.setError("Could not scan that QR code. Try again or enter the URL manually.");
          break;
        case 'cancelled':
        default:
          break;
      }
    } finally {
      setIsCompletingScan(false);
      if (scanAbortRef.current === controller) {
        scanAbortRef.current = null;
        setIsScanning(false);
      }
    }
  }, [conn, isBusy]);

  React.useEffect(() => () => scanAbortRef.current?.abort(), []);

  const handlePasswordSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void conn.submitPassword(password);
  }, [conn, password]);

  const cancelPassword = React.useCallback(() => {
    setPassword('');
    conn.cancelPassword();
  }, [conn]);

  return (
    <>
    {isScanning ? <MobileQrScannerOverlay onCancel={() => scanAbortRef.current?.abort()} /> : null}
    {isCompletingScan ? <MobileQrConnectionLoading /> : null}
    <main className="oc-keyboard-fill-screen flex min-h-dvh flex-col overflow-y-auto bg-background px-6 pb-[calc(var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))+28px)] pt-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+28px)] text-foreground">
      <div className="m-auto flex w-full max-w-[360px] shrink-0 flex-col items-center gap-9 py-8">
        <div className="flex flex-col items-center gap-5 text-center">
          <PiChamberLogo width={72} height={72} className="size-[72px]" />
          <h1 className="typography-h2 text-foreground">{"Connect to PiChamber"}</h1>
        </div>

        {notice ? (
          <div
            role="status"
            className="flex w-full items-center gap-3 rounded-[18px] border border-[color-mix(in_srgb,var(--status-warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--status-warning)_10%,transparent)] px-3.5 py-3"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-[color-mix(in_srgb,var(--status-warning)_16%,transparent)] text-[var(--status-warning)]">
              <Icon name={notice.kind === 'auth-expired' ? 'lock' : 'cloud-off'} className="size-[18px]" />
            </span>
            <p className="min-w-0 flex-1 typography-small text-foreground">
              {notice.kind === 'auth-expired'
                ? `Access to ${notice.label} has expired or was revoked. Sign in again.`
                : `Couldn't reach ${notice.label}. Check that the server is running.`}
            </p>
          </div>
        ) : null}

        {pendingConnection ? (
          <form className="flex w-full flex-col gap-3" onSubmit={handlePasswordSubmit}>
            <div className="flex items-center gap-3 rounded-[18px] border border-border/70 bg-surface-elevated px-3.5 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                <Icon name="lock" className="size-[18px]" />
              </span>
              <div className="min-w-0 text-left">
                <p className="truncate typography-ui-label text-foreground">{pendingConnection.label}</p>
                <p className="truncate typography-small text-muted-foreground">
                  {pendingConnection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(pendingConnection) : "via PiChamber Relay"}
                </p>
              </div>
            </div>
            <input
              {...mobileInputKeyboardProps}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={"PiChamber password"}
              aria-label={"Password"}
              type="password"
              autoFocus
              className={mobileConnectionInputClass}
            />
            {error ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}
            <Button type="submit" size="lg" className="mt-1 h-12 w-full" disabled={isPasswordBusy || !password.trim()}>
              {isPasswordBusy ? "Connecting..." : "Unlock and connect"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={cancelPassword}
            >
              {"Use another server"}
            </Button>
          </form>
        ) : (
          <div className="flex w-full flex-col gap-6">
            {/* Primary path: scan the pairing QR from "Add a device" on the server. */}
            {qrScanSupported ? (
              <div className="flex w-full flex-col gap-2">
                <Button
                  type="button"
                  size="lg"
                  className="h-12 w-full"
                  onClick={() => void handleScanQr()}
                  disabled={isScanning || isBusy}
                >
                  <Icon name="scan-2" className={cn('size-[18px]', isScanning && 'animate-pulse')} />
                  {isBusy ? "Connecting..." : "Scan QR code"}
                </Button>
                <p className="px-2 text-center typography-small text-muted-foreground">
                  {"On your computer, open «Add a device» to show a QR code, then scan it here."}
                </p>
              </div>
            ) : null}

            {error && !manualOpen ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}

            {connections.length > 0 ? (
              <section className="flex w-full flex-col gap-2.5">
                <h2 className="text-center typography-micro uppercase tracking-[0.14em] text-muted-foreground">
                  {"Saved connections"}
                </h2>
                <div className="overflow-hidden rounded-[18px] border border-border/70 bg-surface-elevated">
                  {connections.map((connection) => {
                    const isConnectingRow = connectingId === connection.id;
                    return (
                      <button
                        key={connection.id}
                        type="button"
                        disabled={isBusy}
                        className="flex min-h-14 w-full items-center gap-3 border-b border-border/70 px-3.5 py-2.5 text-left last:border-b-0 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-70"
                        onClick={() => {
                          setConnectingId(connection.id);
                          void conn.connect({ id: connection.id, candidates: connection.candidates, clientToken: connection.clientToken, label: connection.label })
                            .finally(() => setConnectingId(null));
                        }}
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                          <Icon name="server" className="size-[18px]" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate typography-ui-label text-foreground">{connection.label}</span>
                          <span className={cn('block truncate typography-small', isConnectingRow ? 'text-foreground' : 'text-muted-foreground')}>
                            {isConnectingRow
                              ? "Connecting..."
                              : connection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(connection) : "via PiChamber Relay"}
                          </span>
                        </span>
                        {isConnectingRow
                          ? <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" />
                          : <Icon name="arrow-right-s" className="size-5 text-muted-foreground" />}
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {/* Manual URL entry, collapsed by default — most people pair by QR. */}
            <div className="flex w-full flex-col">
              {qrScanSupported ? (
                <button
                  type="button"
                  onClick={() => setManualOpen((value) => !value)}
                  aria-expanded={manualOpen}
                  className="mx-auto flex items-center gap-1 rounded-full px-2 py-1 typography-small text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span>{"Connect by address"}</span>
                  <Icon name="arrow-down-s" className={cn('size-4 transition-transform duration-200', manualOpen && 'rotate-180')} />
                </button>
              ) : null}
              <div
                className="grid transition-[grid-template-rows] duration-200 ease-out"
                style={{ gridTemplateRows: manualOpen ? '1fr' : '0fr' }}
              >
                <div className="min-h-0 overflow-hidden">
                  <form className="flex w-full flex-col gap-3 pt-3" onSubmit={handleSubmit}>
                    <input
                      {...mobileInputKeyboardProps}
                      value={serverUrl}
                      onChange={(event) => handleUrlChange(event.target.value)}
                      placeholder={"http://192.168.1.74:2606"}
                      aria-label={"Server URL"}
                      type="url"
                      inputMode="url"
                      autoCapitalize="none"
                      tabIndex={manualOpen ? undefined : -1}
                      className={cn(mobileConnectionInputClass, 'text-center')}
                    />
                    <input
                      value={connectionName}
                      onChange={(event) => setConnectionName(event.target.value)}
                      placeholder={"Optional display name"}
                      aria-label={"Name"}
                      autoComplete="off"
                      autoCapitalize="words"
                      autoCorrect="off"
                      spellCheck={false}
                      tabIndex={manualOpen ? undefined : -1}
                      className={cn(mobileConnectionInputClass, 'text-center')}
                    />
                    <input
                      {...mobileInputKeyboardProps}
                      value={clientToken}
                      onChange={(event) => setClientToken(event.target.value)}
                      placeholder={"Paste access token"}
                      aria-label={"Client token"}
                      tabIndex={manualOpen ? undefined : -1}
                      autoCapitalize="none"
                      className={cn(mobileConnectionInputClass, 'text-center')}
                    />
                    <p className="px-1 text-center typography-micro text-muted-foreground">{"Only needed if your server requires a token instead of a password."}</p>
                    {error ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}
                    <Button type="submit" variant={qrScanSupported ? 'outline' : 'default'} size="lg" className="h-12 w-full" disabled={isBusy || isScanning || !serverUrl.trim()}>
                      {isBusy ? "Connecting..." : "Connect"}
                    </Button>
                  </form>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
    </>
  );
};
