import * as React from 'react';
import QRCode from 'qrcode';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { ClientAuthAPI, PairingTransports, PendingPairingRecord, RemoteClientRecord } from '@/lib/api/types';
import {
  buildPairingConnectionPayload,
  encodePairingConnectionPayload,
  type PairingEndpointCandidate,
} from '@/lib/connectionPayload';
import {
  buildAddDeviceSessionInput,
  formatPairingCountdown,
  getAddDevicePhase,
  getIncludedRouteChips,
  isLoopbackOnlyTransports,
  shouldAnnounceCountdown,
  type AddDevicePhase,
  type RouteChip,
} from './addDeviceViewModel';

/**
 * Simplified "Add a device" state machine.
 *
 * Opening the dialog immediately creates ONE pairing session including ALL
 * available routes (LAN + Tailscale server-side while active, relay only
 * when available). No transport picker, no name field: the redeeming client
 * supplies its own device label (`clientLabel`/`deviceName`), which the
 * server prefers over the session label — so asking up front would only
 * override the device's own name. Pending rows show the server's
 * "Pair new device" placeholder until redeem.
 *
 * Phases: creating → ready ⇄ expired (New code) → succeeded (auto-close).
 * Closing without success cancels the pending session server-side.
 */
export interface AddDeviceApi {
  open: boolean;
  phase: AddDevicePhase;
  creating: boolean;
  loopbackOnly: boolean;
  pairingUrl: string | null;
  pairingQrDataUrl: string | null;
  pairingCopied: boolean;
  expiresAt: string | null;
  countdownText: string | null;
  announcedCountdownText: string | null;
  routeChips: RouteChip[];
  error: string | null;
  openDialog: () => void;
  closeDialog: () => void;
  regenerate: () => void;
  copyLink: () => void;
  scrollToWays: (row: 'lan' | 'tailscale') => void;
}

const COUNTDOWN_TICK_MS = 1_000;

export const useAddDeviceState = (
  clientAuth: ClientAuthAPI | undefined,
  devices: { pendingPairings: PendingPairingRecord[]; remoteClients: RemoteClientRecord[]; reload: () => void },
): AddDeviceApi => {
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [loopbackOnly, setLoopbackOnly] = React.useState(false);
  const [pairingUrl, setPairingUrl] = React.useState<string | null>(null);
  const [pairingQrDataUrl, setPairingQrDataUrl] = React.useState<string | null>(null);
  const [pairingCopied, setPairingCopied] = React.useState(false);
  const [createdPairingId, setCreatedPairingId] = React.useState<string | null>(null);
  const [expiresAt, setExpiresAt] = React.useState<string | null>(null);
  const [candidates, setCandidates] = React.useState<PairingEndpointCandidate[]>([]);
  const [lanUrl, setLanUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const [succeeded, setSucceeded] = React.useState(false);
  const [announcedCountdownText, setAnnouncedCountdownText] = React.useState<string | null>(null);
  const seenPendingRef = React.useRef(false);
  const createGenerationRef = React.useRef(0);
  const prevCountdownRef = React.useRef<number | null>(null);

  const phase: AddDevicePhase = loopbackOnly
    ? 'creating'
    : getAddDevicePhase({ expiresAt, nowMs, hasPayload: Boolean(pairingUrl), succeeded });

  const msRemaining = expiresAt ? Date.parse(expiresAt) - nowMs : Number.NaN;
  const countdownText = phase === 'ready' ? formatPairingCountdown(msRemaining) : null;

  const routeChips = React.useMemo(
    () => getIncludedRouteChips({ candidates, lanUrl }),
    [candidates, lanUrl],
  );

  // Live countdown tick while a code is showing.
  React.useEffect(() => {
    if (!open || !expiresAt || succeeded) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      const remaining = Date.parse(expiresAt) - now;
      const previous = prevCountdownRef.current;
      prevCountdownRef.current = remaining;
      if (previous !== null && shouldAnnounceCountdown(remaining, previous)) {
        const text = formatPairingCountdown(remaining);
        if (text) setAnnouncedCountdownText(text);
      }
    }, COUNTDOWN_TICK_MS);
    return () => window.clearInterval(timer);
  }, [open, expiresAt, succeeded]);

  const createSession = React.useCallback(async () => {
    if (!clientAuth?.createPairingSession) {
      setError('Pairing is not available on this server.');
      return;
    }
    const generation = createGenerationRef.current + 1;
    createGenerationRef.current = generation;
    setCreating(true);
    setError(null);
    setPairingUrl(null);
    setPairingQrDataUrl(null);
    setPairingCopied(false);
    setCreatedPairingId(null);
    setExpiresAt(null);
    setCandidates([]);
    setSucceeded(false);
    seenPendingRef.current = false;
    prevCountdownRef.current = null;
    try {
      const transports: PairingTransports = await clientAuth.getPairingTransports();
      if (createGenerationRef.current !== generation) return;
      setLanUrl(transports.lan);
      if (isLoopbackOnlyTransports(transports)) {
        setLoopbackOnly(true);
        return;
      }
      setLoopbackOnly(false);
      const input = buildAddDeviceSessionInput(transports);
      const { pairing, server } = await clientAuth.createPairingSession({
        allowedClientKinds: ['mobile', 'desktop'],
        serverUrl: input.serverUrl,
        includeRelay: input.includeRelay,
        includeDirect: input.includeDirect,
      });
      if (createGenerationRef.current !== generation) {
        // A regenerate superseded us: cancel the orphan we just made.
        if (clientAuth.cancelPairing) {
          void clientAuth.cancelPairing(pairing.id).catch(() => undefined);
        }
        return;
      }
      const payload = buildPairingConnectionPayload({
        pairingId: pairing.id,
        secret: pairing.secret,
        label: server.label,
        fingerprint: pairing.fingerprint ?? undefined,
        expiresAt: pairing.expiresAt,
        candidates: server.candidates as unknown as PairingEndpointCandidate[],
      });
      const encoded = encodePairingConnectionPayload(payload);
      setPairingUrl(encoded);
      setPairingQrDataUrl(
        await QRCode.toDataURL(encoded, { width: 1024, margin: 2, errorCorrectionLevel: 'L' }),
      );
      if (createGenerationRef.current !== generation) return;
      setCreatedPairingId(pairing.id);
      setExpiresAt(pairing.expiresAt ?? null);
      setCandidates(server.candidates as unknown as PairingEndpointCandidate[]);
      setNowMs(Date.now());
      prevCountdownRef.current = pairing.expiresAt ? Date.parse(pairing.expiresAt) - Date.now() : null;
      const initialCountdown = pairing.expiresAt
        ? formatPairingCountdown(Date.parse(pairing.expiresAt) - Date.now())
        : null;
      setAnnouncedCountdownText(initialCountdown);
    } catch (cause) {
      if (createGenerationRef.current !== generation) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (createGenerationRef.current === generation) {
        setCreating(false);
      }
    }
  }, [clientAuth]);

  const openDialog = React.useCallback(() => {
    setError(null);
    setLoopbackOnly(false);
    setOpen(true);
    void createSession();
  }, [createSession]);

  const cancelSession = React.useCallback((id: string | null) => {
    if (!id || !clientAuth?.cancelPairing) return;
    void clientAuth.cancelPairing(id).catch(() => undefined);
  }, [clientAuth]);

  const closeDialog = React.useCallback(() => {
    // Cancel the pending session when closed without success; a redeemed
    // (succeeded) session is already consumed and must not be cancelled.
    if (!succeeded) {
      cancelSession(createdPairingId);
    }
    createGenerationRef.current += 1;
    setOpen(false);
    setCreating(false);
    setCreatedPairingId(null);
  }, [succeeded, createdPairingId, cancelSession]);

  const regenerate = React.useCallback(() => {
    cancelSession(createdPairingId);
    void createSession();
  }, [cancelSession, createdPairingId, createSession]);

  const copyLink = React.useCallback(() => {
    if (!pairingUrl) return;
    void copyTextToClipboard(pairingUrl).then((result) => {
      if (!result.ok) return;
      setPairingCopied(true);
      window.setTimeout(() => setPairingCopied(false), 2000);
    });
  }, [pairingUrl]);

  const scrollToWays = React.useCallback((row: 'lan' | 'tailscale') => {
    setOpen(false);
    window.requestAnimationFrame(() => {
      const target = document.getElementById(
        row === 'lan' ? 'remote-access-lan-row' : 'remote-access-tailscale-row',
      );
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, []);

  // Success detection: the created session left the pending list (redeemed).
  const { pendingPairings, remoteClients, reload } = devices;
  React.useEffect(() => {
    if (!open || !createdPairingId || succeeded) return;
    if (pendingPairings.some((pending) => pending.id === createdPairingId)) {
      seenPendingRef.current = true;
      return;
    }
    if (!seenPendingRef.current) return;
    setSucceeded(true);
    setCreatedPairingId(null);
    setOpen(false);
    if (remoteClients.some((client) => client.pairingId === createdPairingId)) {
      toast.success('Device connected.');
    }
    reload();
  }, [open, createdPairingId, succeeded, pendingPairings, remoteClients, reload]);

  return {
    open,
    phase,
    creating,
    loopbackOnly: loopbackOnly && open && !creating && !pairingUrl,
    pairingUrl,
    pairingQrDataUrl,
    pairingCopied,
    expiresAt,
    countdownText,
    announcedCountdownText,
    routeChips,
    error,
    openDialog,
    closeDialog,
    regenerate,
    copyLink,
    scrollToWays,
  };
};
