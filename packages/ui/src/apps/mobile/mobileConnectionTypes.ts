import { Capacitor } from '@capacitor/core';
import type { PairingConnectionPayload } from '@/lib/connectionPayload';
import type { createRelayTunnelClient } from '@/lib/relay/tunnel-client';

export const MOBILE_CONNECTIONS_STORAGE_KEY = 'pichamber.mobile.connections.v1';
export const MOBILE_SECURE_STORAGE_PREFIX = 'pichamber.mobile.';
export const MOBILE_DEVICE_ID_STORAGE_KEY = 'pichamber.mobile.deviceId';

export const MOBILE_CONNECTIONS_LIMIT = 12;
export const MOBILE_CONNECT_TIMEOUT_MS = 8000;
export const MOBILE_NATIVE_HTTP_TIMEOUT_MS = 2500;
export const MOBILE_SECURE_TIMEOUT_MS = 3000;
export const MOBILE_FAST_PROBE_TIMEOUT_MS = 2500;
export const RELAY_CONNECT_TIMEOUT_MS = 15_000;
export const RELAY_RACE_HEADSTART_MS = 1_500;
export const CANDIDATE_REFRESH_DELAY_MS = 5_000;

export const getMobileDeviceId = (): string => {
  try {
    const existing = window.localStorage.getItem(MOBILE_DEVICE_ID_STORAGE_KEY);
    if (existing && existing.trim()) return existing.trim();
    const generated = crypto.randomUUID();
    window.localStorage.setItem(MOBILE_DEVICE_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return crypto.randomUUID();
  }
};

export const mobileClientDedupeKey = (): string => `mobile:${getMobileDeviceId()}`;

export const mobileDevicePlatform = (): string | undefined => {
  try {
    const platform = Capacitor.getPlatform();
    return platform === 'ios' || platform === 'android' ? platform : undefined;
  } catch {
    return undefined;
  }
};

export const createMobilePasswordOperationTracker = () => {
  let current = 0;
  return {
    begin: (): number => {
      current += 1;
      return current;
    },
    cancel: (): void => {
      current += 1;
    },
    isCurrent: (operation: number): boolean => operation === current,
  };
};

export type MobileRelayConfig = {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
};

export type MobileTransportCandidate =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relay: MobileRelayConfig };

export type MobileSavedConnection = {
  id: string;
  label: string;
  candidates: MobileTransportCandidate[];
  lastUsedAt: number;
  hasToken?: boolean;
  clientToken?: string;
};

export type MobilePendingConnection = {
  id: string;
  label: string;
  candidates: MobileTransportCandidate[];
  relay?: MobileRelayConfig;
  relayGrant?: string;
};

export type MobileConnectInput = {
  id?: string;
  url?: string;
  candidates?: MobileTransportCandidate[];
  clientToken?: string;
  label?: string;
  relay?: MobileRelayConfig;
  relayGrant?: string;
};

export type MobileFetchResponse = {
  ok: boolean;
  status: number;
  source: 'native-http' | 'browser-fetch';
  json: () => Promise<unknown>;
};

export type MobileSessionStatus = {
  authenticated?: boolean;
  disabled?: boolean;
  scope?: string;
};

export type PairingRedeemResponse = {
  ok?: boolean;
  clientToken?: unknown;
  client?: { label?: unknown } | null;
  server?: { label?: unknown; url?: unknown } | null;
};

export type ChosenTransport =
  | { kind: 'direct'; url: string }
  | {
      kind: 'relay';
      relay: MobileRelayConfig;
      tunnel?: ReturnType<typeof createRelayTunnelClient>;
    };

export type RelayProbeOutcome = 'ok' | 'needs-login' | 'auth-failed' | 'unreachable';

export type RelayProbeResult = {
  outcome: RelayProbeOutcome;
  tunnel?: ReturnType<typeof createRelayTunnelClient>;
};

export type ProbeResult =
  | { status: 'ok'; transport: ChosenTransport }
  | { status: 'needs-login' }
  | { status: 'unreachable' };

export type LiveTransport =
  | { kind: 'direct'; url: string }
  | {
      kind: 'relay';
      relay: MobileRelayConfig;
      tunnel: ReturnType<typeof createRelayTunnelClient>;
    };

export type AutoConnectOutcome =
  | { status: 'connected' }
  | { status: 'no-candidate' }
  | { status: 'unreachable'; label: string }
  | { status: 'needs-login'; label: string };

export type ReprobeOutcome =
  | 'switched'
  | 'unchanged'
  | 'unreachable'
  | 'needs-login'
  | 'no-connection';

export type CandidateRefreshResult = 'updated' | 'unchanged' | 'skipped';

export type UseMobileConnection = {
  connections: MobileSavedConnection[];
  isBusy: boolean;
  isPasswordBusy: boolean;
  error: string | null;
  pendingConnection: MobilePendingConnection | null;
  connect: (input: MobileConnectInput) => Promise<void>;
  redeemPairingConnection: (payload: PairingConnectionPayload) => Promise<void>;
  submitPassword: (password: string) => Promise<void>;
  cancelPassword: () => void;
  saveConnection: (input: MobileConnectInput) => Promise<MobileSavedConnection | null>;
  removeConnection: (id: string) => Promise<MobileSavedConnection | null>;
  setError: (message: string | null) => void;
};
