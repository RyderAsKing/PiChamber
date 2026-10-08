import type { PairingEndpointCandidate } from '@/lib/connectionPayload';
import type { PairingTransports } from '@/lib/api/types';

/**
 * Pure view-model for the simplified "Add a device" flow.
 *
 * The dialog creates ONE pairing session including every available route:
 * direct candidates (LAN + Tailscale are folded in server-side while active)
 * plus the relay candidate only when `relayAvailable`. No transport radio
 * group, no fallback checkboxes.
 */

export interface AddDeviceSessionInput {
  serverUrl?: string;
  includeRelay: boolean;
  includeDirect: boolean;
}

/** ALL routes: direct on, relay only when the server reports it available. */
export const buildAddDeviceSessionInput = (transports: {
  lan: string | null;
  relayAvailable: boolean;
}): AddDeviceSessionInput => ({
  ...(transports.lan ? { serverUrl: transports.lan } : {}),
  includeRelay: transports.relayAvailable,
  includeDirect: true,
});

/**
 * No LAN, no Tailscale, no relay: a QR would encode only loopback, which no
 * other device can reach. Show the "can't reach this computer yet" callout
 * instead of a QR that can't work.
 */
export const isLoopbackOnlyTransports = (transports: {
  local: string | null;
  lan: string | null;
  relayAvailable: boolean;
  tailscale?: { available: boolean; url: string | null; mode?: 'private' | 'public' } | null;
}): boolean =>
  !transports.lan
  && !(transports.tailscale?.available && transports.tailscale.url)
  && !transports.relayAvailable;

export interface RouteChip {
  key: string;
  label: string;
}

/** Chips listing the routes included in the pairing payload. */
export const getIncludedRouteChips = (input: {
  candidates: PairingEndpointCandidate[];
  lanUrl: string | null;
}): RouteChip[] => {
  const chips: RouteChip[] = [];
  const lanCandidate = input.candidates.find((candidate) => candidate.type === 'lan' || candidate.type === 'tunnel');
  if (lanCandidate && 'url' in lanCandidate && lanCandidate.url) {
    let host = lanCandidate.url;
    try {
      host = new URL(lanCandidate.url).hostname;
    } catch {
      // Keep the raw URL.
    }
    chips.push({ key: 'lan', label: `Local network · ${host}` });
  } else if (input.lanUrl) {
    let host = input.lanUrl;
    try {
      host = new URL(input.lanUrl).hostname;
    } catch {
      // Keep the raw URL.
    }
    chips.push({ key: 'lan', label: `Local network · ${host}` });
  }
  const tailscaleCandidate = input.candidates.find((candidate) => candidate.type === 'tailscale');
  if (tailscaleCandidate && 'mode' in tailscaleCandidate) {
    chips.push({
      key: 'tailscale',
      label: `Tailscale · ${tailscaleCandidate.mode === 'public' ? 'Public' : 'Private'}`,
    });
  }
  if (input.candidates.some((candidate) => candidate.type === 'relay')) {
    chips.push({ key: 'relay', label: 'Relay · works away from home' });
  }
  return chips;
};

/** "Expires in 9:42" for the live countdown; null once expired. */
export const formatPairingCountdown = (msRemaining: number): string | null => {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return null;
  const totalSeconds = Math.floor(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `Expires in ${minutes}:${String(seconds).padStart(2, '0')}`;
};

/** aria-live announcements at sensible granularity (mates with the visible
 * countdown): announce each minute, plus the final 10 seconds. */
export const shouldAnnounceCountdown = (msRemaining: number, previousMsRemaining: number): boolean => {
  if (!Number.isFinite(msRemaining) || !Number.isFinite(previousMsRemaining)) return false;
  if (msRemaining <= 0 || previousMsRemaining <= 0) return msRemaining <= 0 !== previousMsRemaining <= 0;
  const minuteOf = (ms: number) => Math.floor(ms / 60_000);
  if (minuteOf(msRemaining) !== minuteOf(previousMsRemaining)) return true;
  return msRemaining <= 10_000 && Math.floor(msRemaining / 1000) !== Math.floor(previousMsRemaining / 1000);
};

export type AddDevicePhase = 'creating' | 'ready' | 'expired' | 'succeeded';

export const getAddDevicePhase = (input: {
  expiresAt: string | null;
  nowMs: number;
  hasPayload: boolean;
  succeeded: boolean;
}): AddDevicePhase => {
  if (input.succeeded) return 'succeeded';
  if (!input.hasPayload || !input.expiresAt) return 'creating';
  const expiresMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresMs)) return 'creating';
  return expiresMs <= input.nowMs ? 'expired' : 'ready';
};

export type { PairingTransports };
