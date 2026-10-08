/**
 * Shared mobile servers manager: saved-server list, add, edit, remove,
 * password unlock, and QR/pairing flows for phones.
 *
 * Used by both the quick-access sheet (`MobileInstancesSurface`) and the
 * mobile servers settings page, so the two stay consistent. Rows and the
 * add-server flow render through the shared `ServerList`/`ServerRow`/
 * `AddServerDialog` components (touch layout, `Connect` label); data and
 * transport come from `useMobileServers`, which preserves the existing
 * mobile storage/transport semantics (candidate racing, secure tokens,
 * password unlock, remove fallback).
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { AddServerDialog, type AddServerManualInput } from '@/components/servers/AddServerDialog';
import { ServerList } from '@/components/servers/ServerList';
import { exportMobileErrorLog, type MobileErrorLogExportResult } from '@/lib/mobile-error-log';

import { useMobileServers } from './mobile/useMobileServers';
import { connectionDisplayUrl } from './mobileConnections';
import { connectionDisplayUrl as connectionDisplayUrlFromStorage } from './mobile/mobileConnectionStorage';
import { isQrScanSupported, parseConnectionPayload, scanConnectionQr } from './mobileQrScan';
import { mobileConnectionInputClass, mobileInputKeyboardProps } from './mobileConnectionUi';
import { MobileQrConnectionLoading, MobileQrScannerOverlay } from './MobileQrScannerOverlay';
import { useNativeAndroidBackButton } from './mobileNativeChrome';

export type MobileServersManagerProps = {
  onConnect: () => void;
  onActiveConnectionDeleted: () => void;
  /** Sheet-only extras (diagnostics export lives on the Instances sheet). */
  showDiagnostics?: boolean;
};

export const MobileServersManager: React.FC<MobileServersManagerProps> = ({
  onConnect,
  onActiveConnectionDeleted,
  showDiagnostics = false,
}) => {
  const servers = useMobileServers({ onConnected: onConnect, onActiveConnectionDeleted });
  const { conn, items, connectingId } = servers;
  const {
    connections, isBusy, isPasswordBusy, error, pendingConnection,
    saveConnection, setError,
  } = conn;

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const editingConnection = editingId ? connections.find((connection) => connection.id === editingId) ?? null : null;
  const [url, setUrl] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [clientToken, setClientToken] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [addOpen, setAddOpen] = React.useState(false);
  const [isScanning, setIsScanning] = React.useState(false);
  const [isCompletingScan, setIsCompletingScan] = React.useState(false);
  const [isExportingDiagnostics, setIsExportingDiagnostics] = React.useState(false);
  const [diagnosticsMessage, setDiagnosticsMessage] = React.useState<string | null>(null);
  const scanAbortRef = React.useRef<AbortController | null>(null);
  const qrScanSupported = React.useMemo(() => isQrScanSupported(), []);

  // A successful manual/scan/pairing add either connects (sheet closes via
  // onConnect) or lands on password unlock — either way the dialog is done.
  React.useEffect(() => {
    if (pendingConnection) setAddOpen(false);
  }, [pendingConnection]);

  // Populate/clear the edit form imperatively (on edit tap / cancel / save)
  // rather than via an effect keyed on the derived connection object. With an
  // effect, any churn of the connections list re-fires it and overwrites what
  // the user is typing — the keyboard "resets" mid-edit. Imperative
  // population is immune to that.
  const resetEditForm = React.useCallback(() => {
    setEditingId(null);
    setUrl('');
    setLabel('');
    setClientToken('');
    setError(null);
  }, [setError]);

  const beginEdit = React.useCallback((id: string) => {
    const target = connections.find((connection) => connection.id === id) ?? null;
    if (!target) return;
    setEditingId(id);
    setUrl(connectionDisplayUrlFromStorage(target));
    setLabel(target.label);
    setClientToken(target.clientToken || '');
    setError(null);
  }, [connections, setError]);

  const saveEdit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    // The id is what makes this an EDIT: saveConnection uses it to preserve the
    // existing relay/https candidates (and the Keychain token they key) instead
    // of rebuilding the server from the single URL field.
    void saveConnection({ id: editingId ?? undefined, url, label, clientToken }).then((saved) => {
      if (saved) resetEditForm();
    });
  }, [clientToken, editingId, label, resetEditForm, saveConnection, url]);

  const handleScanQr = React.useCallback(async () => {
    if (scanAbortRef.current) return;
    setError(null);
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
          // Legacy token QR: connect directly with the scanned URL + token
          // (the welcome screen precedent). A password-protected server lands
          // on the unlock form via pendingConnection, which closes the dialog.
          setIsCompletingScan(true);
          await conn.connect({ url: result.url, clientToken: result.clientToken, label: result.label });
          break;
        case 'pairing':
          setIsCompletingScan(true);
          await conn.redeemPairingConnection(result.pairing);
          break;
        case 'cancelled':
          break;
        default: {
          // Terminal scan failures surface on the sheet; the dialog closes so
          // the error is visible (the dialog menu step has no error slot).
          const message = result.status === 'permission-denied'
            ? "Camera access is off. Enable it in Settings to scan a QR code."
            : result.status === 'invalid'
              ? "That QR code is not an PiChamber connection code."
              : result.status === 'unsupported'
                ? "QR scanning is only available in the installed mobile app."
                : "Could not scan that QR code. Try again or enter the URL manually.";
          setAddOpen(false);
          setError(message);
          break;
        }
      }
    } finally {
      setIsCompletingScan(false);
      if (scanAbortRef.current === controller) {
        scanAbortRef.current = null;
        setIsScanning(false);
      }
    }
  }, [conn, setError]);

  React.useEffect(() => () => scanAbortRef.current?.abort(), []);

  const handleImportLink = React.useCallback((link: string) => {
    // Paste-link path: pairing links redeem (and connect) through the
    // existing pairing flow; plain URLs connect by address. An invalid link
    // stays in the dialog via importError; success closes via onConnect and
    // password unlock closes via the pendingConnection effect.
    const payload = parseConnectionPayload(link.trim());
    if (!payload) {
      setError('Invalid PiChamber connection link.');
      return;
    }
    if ('pairing' in payload) {
      void conn.redeemPairingConnection(payload.pairing);
      return;
    }
    void conn.connect({ url: payload.url });
  }, [conn, setError]);

  const handleAddManual = React.useCallback((input: AddServerManualInput) => {
    // Manual address uses the connect-by-address behavior (not save-only), so
    // the access-token field and the password-unlock case work exactly like
    // the welcome screen: connect persists, switches on success, and lands on
    // the unlock form when the server needs a password. Extra headers are a
    // desktop concept and are intentionally ignored on mobile.
    if (!input.url.trim()) {
      setError('Enter a server URL.');
      return;
    }
    void conn.connect({ url: input.url, label: input.label, clientToken: input.token });
  }, [conn, setError]);

  const handlePasswordSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void conn.submitPassword(password);
  }, [conn, password]);

  const cancelPasswordPrompt = React.useCallback(() => {
    setPassword('');
    conn.cancelPassword();
  }, [conn]);

  const handleExportDiagnostics = React.useCallback(async () => {
    if (isExportingDiagnostics) return;
    setDiagnosticsMessage(null);
    setIsExportingDiagnostics(true);
    try {
      const result: MobileErrorLogExportResult = await exportMobileErrorLog();
      setDiagnosticsMessage(
        result === 'copied'
          ? 'Diagnostics copied to the clipboard.'
          : result === 'downloaded'
            ? 'Diagnostics downloaded.'
            : 'Diagnostics ready to share.',
      );
    } catch {
      setDiagnosticsMessage('Diagnostics export was cancelled or unavailable.');
    } finally {
      setIsExportingDiagnostics(false);
    }
  }, [isExportingDiagnostics]);

  const openAddDialog = React.useCallback(() => {
    setError(null);
    setAddOpen(true);
  }, [setError]);

  // Android back LIFO (the shell owns the sheet close beneath us): scanner,
  // add dialog, and edit/password layers close top-first.
  const handleNativeBack = React.useCallback(() => {
    if (isScanning) {
      scanAbortRef.current?.abort();
      return true;
    }
    if (addOpen) {
      setAddOpen(false);
      return true;
    }
    if (editingConnection) {
      resetEditForm();
      return true;
    }
    if (pendingConnection) {
      cancelPasswordPrompt();
      return true;
    }
    return false;
  }, [addOpen, cancelPasswordPrompt, editingConnection, isScanning, pendingConnection, resetEditForm]);

  useNativeAndroidBackButton(handleNativeBack);

  const inputClass = mobileConnectionInputClass;

  if (pendingConnection) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <form className="flex-1 overflow-y-auto px-5 py-4" onSubmit={handlePasswordSubmit}>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 rounded-[18px] border border-border/70 bg-surface-elevated px-3.5 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                <Icon name="lock" className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <p className="truncate typography-ui-label text-foreground">{pendingConnection.label}</p>
                <p className="truncate typography-small text-muted-foreground">
                  {pendingConnection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl({ candidates: pendingConnection.candidates }) : "via PiChamber Relay"}
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
              className={inputClass}
            />
            {error ? <p className="px-1 typography-small text-[var(--status-error)]">{error}</p> : null}
            <Button type="submit" size="lg" className="mt-1 h-12 w-full" disabled={isPasswordBusy || !password.trim()}>
              {isPasswordBusy ? "Connecting..." : "Unlock and connect"}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="w-full" onClick={cancelPasswordPrompt}>
              {"Use another server"}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <>
    {isScanning ? <MobileQrScannerOverlay onCancel={() => scanAbortRef.current?.abort()} /> : null}
    {isCompletingScan ? <MobileQrConnectionLoading /> : null}
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="space-y-6">
          <ServerList
            items={items}
            layout="touch"
            switchLabel="Connect"
            pendingId={connectingId}
            actionsDisabled={isBusy}
            onSwitch={(item) => void servers.connectServer(item.id)}
            onEdit={(item) => beginEdit(item.id)}
            onRemove={(item) => void servers.removeServer(item.id)}
            emptyMessage="No saved servers yet."
          />
          {error && !addOpen && !editingConnection ? (
            <p className="px-1 text-center typography-small text-[var(--status-error)]" role="alert">{error}</p>
          ) : null}

          {showDiagnostics ? (
            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-12 w-full"
                onClick={() => void handleExportDiagnostics()}
                disabled={isExportingDiagnostics}
              >
                <Icon name="download" className="size-[18px]" />
                {isExportingDiagnostics ? "Preparing diagnostics…" : "Export diagnostics"}
              </Button>
              {diagnosticsMessage ? (
                <p className="px-1 text-center typography-small text-muted-foreground">{diagnosticsMessage}</p>
              ) : null}
            </div>
          ) : null}

          {editingConnection ? (
            <form className="space-y-3" onSubmit={saveEdit}>
              <div className="flex h-8 items-center justify-between gap-3 px-1">
                <h3 className="typography-ui-label text-foreground">{"Edit server"}</h3>
                <Button type="button" variant="ghost" size="xs" onClick={resetEditForm}>
                  {"Cancel"}
                </Button>
              </div>
              <label className="block space-y-1.5">
                <span className="block px-1 typography-ui-label text-foreground">{"Server URL"}</span>
                <input
                  {...mobileInputKeyboardProps}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder={"http://192.168.1.74:2606"}
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="block px-1 typography-ui-label text-foreground">{"Name"}</span>
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={"Optional display name"}
                  autoComplete="off"
                  autoCapitalize="words"
                  autoCorrect="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="block px-1 typography-ui-label text-foreground">{"Client token"}</span>
                <input
                  {...mobileInputKeyboardProps}
                  value={clientToken}
                  onChange={(event) => setClientToken(event.target.value)}
                  placeholder={"Paste access token"}
                  autoCapitalize="none"
                  className={inputClass}
                />
                <p className="px-1 typography-micro text-muted-foreground">{"Only needed if your server requires a token instead of a password."}</p>
              </label>
              {error ? <p className="px-1 typography-small text-[var(--status-error)]">{error}</p> : null}
              <Button type="submit" size="lg" className="mt-1 h-12 w-full">
                {"Save server"}
              </Button>
            </form>
          ) : (
            <div className="space-y-2">
              <Button
                type="button"
                size="lg"
                className="h-12 w-full"
                onClick={openAddDialog}
                disabled={isBusy}
              >
                <Icon name="add" className="size-[18px]" />
                {"Add server"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
    <AddServerDialog
      open={addOpen}
      onOpenChange={(open) => {
        setAddOpen(open);
        if (!open) setError(null);
      }}
      canScanQr={qrScanSupported}
      onScanQr={() => void handleScanQr()}
      onImportLink={handleImportLink}
      importSaving={isBusy}
      importError={error}
      onAddManual={handleAddManual}
      manualSaving={isBusy}
      manualError={error}
    />
    </>
  );
};
