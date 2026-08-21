import React from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsGroupTitle,
  SETTINGS_PAGE_TITLE_CLASS,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { toast } from '@/components/ui';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { PendingPairingRecord, RemoteClientRecord } from '@/lib/api/types';
import { buildPairingConnectionPayload, encodePairingConnectionPayload, parsePairingConnectionPayload, type PairingEndpointCandidate } from '@/lib/connectionPayload';
import {
  desktopSshLogsClear,
  desktopSshLogs,
  type DesktopSshInstance,
  type DesktopSshPortForward,
  type DesktopSshPortForwardType,
} from '@/lib/desktopSsh';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  desktopInstallIdGet,
  getDesktopHostApiUrl,
  normalizeHostUrl,
  probeRelayDesktopHost,
  redactSensitiveUrl,
  resolveDesktopHostUrl,
  relayHostDisplayUrl,
  type DesktopHost,
  type DesktopHostRelay,
  type HostProbeResult,
} from '@/lib/desktopHosts';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { getDesktopLanAddress, isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, switchRuntimeEndpoint } from '@/lib/runtime-switch';

const randomPort = (): number => {
  return Math.floor(20000 + Math.random() * 30000);
};

const isPortInUseError = (error: unknown): boolean => {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('address already in use') || message.includes('eaddrinuse') || message.includes('port already in use');
};

// Platform this desktop reports about itself when redeeming a pairing link —
// display-only metadata for the issuing server's device list.
const desktopPlatformName = (): string | undefined => {
  if (typeof navigator === 'undefined') return undefined;
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return undefined;
};

// Friendly label for a device's self-reported platform in the device list.
const devicePlatformLabel = (platform?: string | null): string | null => {
  switch ((platform || '').toLowerCase()) {
    case 'ios': return 'iOS';
    case 'android': return 'Android';
    case 'macos':
    case 'darwin': return 'macOS';
    case 'windows':
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    default: return null;
  }
};

const phaseLabel = (phase?: string): string => {
  switch (phase) {
    case 'config_resolved':
      return 'Resolving configuration';
    case 'auth_check':
      return 'Checking authentication';
    case 'master_connecting':
      return 'Establishing SSH connection';
    case 'remote_probe':
      return 'Checking remote machine';
    case 'installing':
      return 'Installing PiChamber';
    case 'updating':
      return 'Updating PiChamber';
    case 'server_detecting':
      return 'Detecting server';
    case 'server_starting':
      return 'Starting server';
    case 'forwarding':
      return 'Forwarding ports';
    case 'ready':
      return 'Ready';
    case 'degraded':
      return 'Reconnecting';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
};

const CONNECTING_PHASES = new Set<string>([
  'config_resolved',
  'auth_check',
  'master_connecting',
  'remote_probe',
  'installing',
  'updating',
  'server_detecting',
  'server_starting',
  'forwarding',
]);

const isConnectingPhase = (phase?: string): boolean => {
  return Boolean(phase && CONNECTING_PHASES.has(phase));
};

const phaseDotClass = (phase?: string): string => {
  if (phase === 'ready') {
    return 'bg-[var(--status-success)] animate-pulse';
  }
  if (phase === 'error') {
    return 'bg-[var(--status-error)] animate-pulse';
  }
  if (phase === 'degraded' || isConnectingPhase(phase)) {
    return 'bg-[var(--status-warning)] animate-pulse';
  }
  return 'bg-muted-foreground/40';
};

const buildForwardLabel = (forward: DesktopSshPortForward): string => {
  if (forward.type === 'dynamic') {
    return `${forward.localHost || '127.0.0.1'}:${forward.localPort || 0}`;
  }
  if (forward.type === 'remote') {
    return `${forward.remoteHost || '127.0.0.1'}:${forward.remotePort || 0} -> ${forward.localHost || '127.0.0.1'}:${forward.localPort || 0}`;
  }
  return `${forward.localHost || '127.0.0.1'}:${forward.localPort || 0} -> ${forward.remoteHost || '127.0.0.1'}:${forward.remotePort || 0}`;
};

const makeForward = (): DesktopSshPortForward => {
  return {
    id: `forward-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    enabled: true,
    type: 'local',
    localHost: '127.0.0.1',
    localPort: randomPort(),
    remoteHost: '127.0.0.1',
    remotePort: 80,
  };
};

const suggestConcreteHost = (pattern: string): string => {
  const value = pattern.trim().replace(/\*/g, 'host').replace(/\?/g, 'x');
  return value || 'user@host';
};

const HintLabel: React.FC<{ label: string; hint: React.ReactNode }> = ({ label, hint }) => {
  return (
    <span className={`inline-flex items-center gap-1 ${SETTINGS_FIELD_LABEL_CLASS}`}>
      <span>{label}</span>
      <SettingsInfoHint contentClassName="max-w-xs">{hint}</SettingsInfoHint>
    </span>
  );
};

const forwardTypeDescription = (type: DesktopSshPortForwardType): string => {
  switch (type) {
    case 'remote':
      return 'Open a port on the remote machine that connects back to your computer.';
    case 'dynamic':
      return 'Open a local SOCKS proxy through the SSH connection.';
    default:
      return 'Open a local port that connects to something on the remote machine.';
  }
};

const formatEndpoint = (host: string | undefined, port: number | undefined): string => {
  const value = (host || '').trim();
  const normalizedHost = !value || value === '127.0.0.1' || value === '::1' ? 'localhost' : value;
  return `${normalizedHost}:${port || 0}`;
};

const toBrowserHost = (host: string | undefined): string => {
  const value = (host || '').trim();
  if (!value || value === '0.0.0.0' || value === '::') {
    return '127.0.0.1';
  }
  return value;
};

const formatLogLine = (line: string): string => {
  const match = line.match(/^\[(\d{10,})\]\s*(?:\[([A-Z]+)\]\s*)?(.*)$/);
  if (!match) {
    return line;
  }

  const millis = Number(match[1]);
  const iso = Number.isFinite(millis) ? new Date(millis).toISOString() : match[1];
  const level = (match[2] || 'INFO').toUpperCase();
  const message = match[3] || '';
  return `[${iso}] [${level}] ${message}`;
};

type HeaderDraft = {
  id: string;
  name: string;
  value: string;
};

const createHeaderDraft = (name = '', value = ''): HeaderDraft => ({
  id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `header-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  name,
  value,
});

const isReservedRequestHeaderName = (name: string): boolean => name.trim().toLowerCase() === 'authorization';

const buildRequestHeaders = (headers: HeaderDraft[]): Record<string, string> | undefined => {
  const next: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.trim();
    const value = header.value.trim();
    if (name && value && !isReservedRequestHeaderName(name)) next[name] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

const readRequestHeaderDrafts = (headers: Record<string, string> | undefined): HeaderDraft[] => {
  return Object.entries(headers || {}).map(([name, value]) => createHeaderDraft(name, value));
};

const getRuntimePort = (): number | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
  const portSource = runtimeApiBaseUrl || window.location.href;
  try {
    const port = Number(new URL(portSource).port || window.location.port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    const port = Number(window.location.port);
    return Number.isFinite(port) && port > 0 ? port : null;
  }
};

const isLoopbackUrl = (value: string): boolean => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
};

const resolvePairingServerUrl = async (): Promise<string> => {
  const fallback = normalizeHostUrl(getRuntimeApiBaseUrl()) || window.location.origin;
  if (!isDesktopShell() || !isDesktopLocalOriginActive()) {
    return fallback;
  }

  let response: Response;
  try {
    response = await runtimeFetch('/api/pi/ui-settings', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return fallback;
  }
  if (!response.ok) return fallback;

  const settings = (await response.json().catch(() => null)) as null | {
    desktopLanAccessActive?: unknown;
  };
  if (settings?.desktopLanAccessActive !== true) {
    return fallback;
  }

  const address = await getDesktopLanAddress();
  const port = getRuntimePort();
  if (!address || !port) {
    return fallback;
  }

  return `http://${address}:${port}`;
};

const navigateToUrl = (rawUrl: string): void => {
  const target = rawUrl.trim();
  if (!target) {
    return;
  }
  try {
    window.location.assign(target);
  } catch {
    window.location.href = target;
  }
};

const normalizeForSave = (instance: DesktopSshInstance): DesktopSshInstance => {
  const trimmedCommand = instance.sshCommand.trim();
  const nickname = instance.nickname?.trim();
  const forwards = instance.portForwards.map((forward) => ({
    ...forward,
    localHost: forward.localHost?.trim() || '127.0.0.1',
    localPort: typeof forward.localPort === 'number' ? Math.max(1, Math.min(65535, Math.round(forward.localPort))) : undefined,
    remoteHost: forward.remoteHost?.trim(),
    remotePort:
      typeof forward.remotePort === 'number'
        ? Math.max(1, Math.min(65535, Math.round(forward.remotePort)))
        : undefined,
  }));

  return {
    ...instance,
    sshCommand: trimmedCommand,
    ...(nickname ? { nickname } : { nickname: undefined }),
    connectionTimeoutSec: Math.max(5, Math.min(240, Math.round(instance.connectionTimeoutSec || 60))),
    localForward: {
      ...instance.localForward,
      bindHost:
        instance.localForward.bindHost === 'localhost' ||
        instance.localForward.bindHost === '0.0.0.0'
          ? instance.localForward.bindHost
          : '127.0.0.1',
      preferredLocalPort:
        typeof instance.localForward.preferredLocalPort === 'number'
          ? Math.max(1, Math.min(65535, Math.round(instance.localForward.preferredLocalPort)))
          : undefined,
    },
    remoteOpenchamber: {
      ...instance.remoteOpenchamber,
      preferredPort:
        typeof instance.remoteOpenchamber.preferredPort === 'number'
          ? Math.max(1, Math.min(65535, Math.round(instance.remoteOpenchamber.preferredPort)))
          : undefined,
    },
    portForwards: forwards,
  };
};

export const RemoteInstancesPage: React.FC = () => {
    const { isMobile } = useDeviceInfo();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const { clientAuth } = useRuntimeAPIs();
  const showInstanceManagement = isDesktopShell();
  const instances = useDesktopSshStore((state) => state.instances);
  const statusesById = useDesktopSshStore((state) => state.statusesById);
  const importCandidates = useDesktopSshStore((state) => state.importCandidates);
  const isLoading = useDesktopSshStore((state) => state.isLoading);
  const isImportsLoading = useDesktopSshStore((state) => state.isImportsLoading);
  const isSaving = useDesktopSshStore((state) => state.isSaving);
  const error = useDesktopSshStore((state) => state.error);
  const load = useDesktopSshStore((state) => state.load);
  const loadImports = useDesktopSshStore((state) => state.loadImports);
  const refreshStatuses = useDesktopSshStore((state) => state.refreshStatuses);
  const upsertInstance = useDesktopSshStore((state) => state.upsertInstance);
  const createFromCommand = useDesktopSshStore((state) => state.createFromCommand);
  const removeInstance = useDesktopSshStore((state) => state.removeInstance);
  const connect = useDesktopSshStore((state) => state.connect);
  const disconnect = useDesktopSshStore((state) => state.disconnect);
  const retry = useDesktopSshStore((state) => state.retry);

  const selectedId = useUIStore((state) => state.settingsRemoteInstancesSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsRemoteInstancesSelectedId);

  const selectedInstance = React.useMemo(() => {
    if (!selectedId) return null;
    return instances.find((instance) => instance.id === selectedId) || null;
  }, [instances, selectedId]);

  const [draft, setDraft] = React.useState<DesktopSshInstance | null>(null);
  const [logDialogOpen, setLogDialogOpen] = React.useState(false);
  const [logDialogLoading, setLogDialogLoading] = React.useState(false);
  const [logDialogError, setLogDialogError] = React.useState<string | null>(null);
  const [logDialogLines, setLogDialogLines] = React.useState<string[]>([]);
  const [patternHost, setPatternHost] = React.useState<string | null>(null);
  const [patternDestination, setPatternDestination] = React.useState('');
  const [patternCreating, setPatternCreating] = React.useState(false);
  const [expandedForwards, setExpandedForwards] = React.useState<Record<string, boolean>>({});
  const [isPrimaryActionPending, setIsPrimaryActionPending] = React.useState(false);
  const [isRetryPending, setIsRetryPending] = React.useState(false);
  const [clockMs, setClockMs] = React.useState(() => Date.now());
  const [directHosts, setDirectHosts] = React.useState<DesktopHost[]>([]);
  // Live reachability per saved host (undefined = probe in flight), mirroring
  // the host switcher's status line so this list is not just dead text.
  const [directHostStatus, setDirectHostStatus] = React.useState<Record<string, HostProbeResult>>({});
  const [directDefaultHostId, setDirectDefaultHostId] = React.useState<string | null>('local');
  const [directLoading, setDirectLoading] = React.useState(false);
  const [directSaving, setDirectSaving] = React.useState(false);
  const [directLabel, setDirectLabel] = React.useState('');
  const [directUrl, setDirectUrl] = React.useState('');
  const [directToken, setDirectToken] = React.useState('');
  const [directHeaders, setDirectHeaders] = React.useState<HeaderDraft[]>([]);
  const [directConnectLink, setDirectConnectLink] = React.useState('');
  const [directError, setDirectError] = React.useState<string | null>(null);
  const [directAddDialogOpen, setDirectAddDialogOpen] = React.useState(false);
  const [directImportDialogOpen, setDirectImportDialogOpen] = React.useState(false);
  const [directEditingId, setDirectEditingId] = React.useState<string | null>(null);
  const [directEditLabel, setDirectEditLabel] = React.useState('');
  const [directEditUrl, setDirectEditUrl] = React.useState('');
  const [directEditToken, setDirectEditToken] = React.useState('');
  const [directEditHeaders, setDirectEditHeaders] = React.useState<HeaderDraft[]>([]);
  const [remoteClients, setRemoteClients] = React.useState<RemoteClientRecord[]>([]);
  const [pendingPairings, setPendingPairings] = React.useState<PendingPairingRecord[]>([]);
  const [remoteClientsLoading, setRemoteClientsLoading] = React.useState(false);
  const [remoteClientLabel, setRemoteClientLabel] = React.useState('');
  const [remoteClientError, setRemoteClientError] = React.useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = React.useState<string | null>(null);
  // The pairing session shown in the QR dialog; used to auto-close the dialog
  // once the device redeems it (the pairing leaves the pending list).
  const [createdPairingId, setCreatedPairingId] = React.useState<string | null>(null);
  const [pairingQrDataUrl, setPairingQrDataUrl] = React.useState<string | null>(null);
  const [pairingCopied, setPairingCopied] = React.useState(false);
  // "Add a device" dialog: a configure phase (name + transport + fallback) then a
  // result phase (QR + link). The QR only ever shows inside this dialog.
  const [addDeviceOpen, setAddDeviceOpen] = React.useState(false);
  const [addDevicePhase, setAddDevicePhase] = React.useState<'configure' | 'result'>('configure');
  const [addDeviceCreating, setAddDeviceCreating] = React.useState(false);
  const [addDeviceTransport, setAddDeviceTransport] = React.useState<'local' | 'lan' | 'relay'>('relay');
  const [addDeviceFallback, setAddDeviceFallback] = React.useState(true);
  const [transportOptions, setTransportOptions] = React.useState<{ localUrl: string | null; lanUrl: string | null; relayAvailable: boolean } | null>(null);
  const revokedClientCount = React.useMemo(() => remoteClients.filter((client) => Boolean(client.revokedAt)).length, [remoteClients]);
  const [sshAddDialogOpen, setSshAddDialogOpen] = React.useState(false);
  const [sshCommandDraft, setSshCommandDraft] = React.useState('ssh user@example.com');
  const [sshNameDraft, setSshNameDraft] = React.useState('');

  React.useEffect(() => {
    void load();
    void loadImports();
  }, [load, loadImports]);

  const loadDirectHosts = React.useCallback(async () => {
    setDirectLoading(true);
    setDirectError(null);
    try {
      const config = await desktopHostsGet();
      setDirectHosts(config.hosts || []);
      setDirectDefaultHostId(config.defaultHostId || 'local');
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirectLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadDirectHosts();
  }, [loadDirectHosts]);

  const persistDirectHosts = React.useCallback(async (hosts: DesktopHost[], defaultHostId: string | null = directDefaultHostId) => {
    setDirectSaving(true);
    setDirectError(null);
    try {
      await desktopHostsSet({ hosts, defaultHostId, initialHostChoiceCompleted: true });
      setDirectHosts(hosts);
      setDirectDefaultHostId(defaultHostId);
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirectSaving(false);
    }
  }, [directDefaultHostId]);

  const handleAddDirectHost = React.useCallback(async () => {
    const resolved = resolveDesktopHostUrl(directUrl);
    if (!resolved) {
      setDirectError("Invalid URL (must be http/https)");
      return;
    }
    const url = resolved.persistedUrl;
    const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const host: DesktopHost = {
      id,
      label: directLabel.trim() || redactSensitiveUrl(url),
      url,
      apiUrl: url,
      ...(directToken.trim() ? { clientToken: directToken.trim() } : {}),
      ...(buildRequestHeaders(directHeaders) ? { requestHeaders: buildRequestHeaders(directHeaders) } : {}),
    };
    await persistDirectHosts([host, ...directHosts], directDefaultHostId);
    setDirectLabel('');
    setDirectUrl('');
    setDirectToken('');
    setDirectHeaders([]);
    setDirectAddDialogOpen(false);
    if (resolved.redeemUrl) {
      navigateToUrl(resolved.redeemUrl);
    }
  }, [directDefaultHostId, directHeaders, directHosts, directLabel, directToken, directUrl, persistDirectHosts]);

  const importDirectConnectLink = React.useCallback(async () => {
    const payload = parsePairingConnectionPayload(directConnectLink);
    if (!payload) {
      setDirectError("Invalid PiChamber connection link.");
      return;
    }
    // The redeem body is identical across every transport (the desktop is the
    // same device however it reaches the server). The install-id dedupe key
    // collapses re-pairing / re-auth of this desktop into one device record.
    const installId = await desktopInstallIdGet().catch(() => '');
    const redeemBody = JSON.stringify({
      pairingId: payload.pairingId,
      secret: payload.secret,
      clientLabel: payload.label || 'PiChamber Desktop',
      clientKind: 'desktop',
      deviceName: 'PiChamber Desktop',
      devicePlatform: desktopPlatformName(),
      ...(installId ? { dedupeKey: `desktop:${installId}` } : {}),
    });
    const redeemInit: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: redeemBody,
    };
    const tokenFromResponse = async (response: Response): Promise<string | null> => {
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as { clientToken?: unknown } | null;
      const token = typeof body?.clientToken === 'string' ? body.clientToken.trim() : '';
      return token || null;
    };

    // Try direct (LAN/tunnel) candidates first — they're cheaper and don't need
    // relay infrastructure — then fall back to relay. Ordered by payload priority.
    const ordered = [...payload.candidates].sort(
      (a, b) => (a.type === 'relay' ? 1 : 0) - (b.type === 'relay' ? 1 : 0),
    );

    let redeemed:
      | { kind: 'direct'; url: string; token: string }
      | { kind: 'relay'; relay: DesktopHostRelay; token: string }
      | null = null;

    for (const candidate of ordered) {
      if (candidate.type === 'relay') {
        // Open a throwaway E2EE tunnel just to redeem the one-time secret; the
        // grant (if any) authorizes admission to the relay for this serverId.
        const tunnel = createRelayTunnelClient({
          relayUrl: candidate.relayUrl,
          serverId: candidate.serverId,
          hostEncPubJwk: candidate.hostEncPubJwk,
          ...(candidate.grant ? { grant: candidate.grant } : {}),
        });
        try {
          const response = await tunnel.fetch('/api/client-auth/pairing/redeem', redeemInit);
          const token = await tokenFromResponse(response);
          if (token) {
            redeemed = {
              kind: 'relay',
              // grant is intentionally not persisted (one-time pairing artifact).
              relay: { relayUrl: candidate.relayUrl, serverId: candidate.serverId, hostEncPubJwk: candidate.hostEncPubJwk },
              token,
            };
            break;
          }
        } catch {
          // Relay unreachable / handshake failed — try the next candidate.
        } finally {
          tunnel.close();
        }
        continue;
      }
      // Direct: the remote instance is a user-provided URL, so a plain
      // cross-origin fetch is correct here (not the active runtime).
      const candidateUrl = normalizeHostUrl(candidate.url);
      if (!candidateUrl) continue;
      try {
        const response = await fetch(`${candidateUrl}/api/client-auth/pairing/redeem`, redeemInit);
        const token = await tokenFromResponse(response);
        if (token) {
          redeemed = { kind: 'direct', url: candidateUrl, token };
          break;
        }
      } catch {
        // Unreachable candidate — try the next one.
      }
    }

    if (!redeemed) {
      setDirectError("Invalid URL (must be http/https)");
      return;
    }

    const makeId = (): string => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    // Persist EVERY transport the link carried, not just the one that answered
    // the redeem — a multi-transport host connects directly on the home network
    // and falls back to the relay away from it (same model as mobile devices).
    // The single token works over both transports.
    const linkRelayCandidate = payload.candidates.find(
      (candidate): candidate is Extract<PairingEndpointCandidate, { type: 'relay' }> => candidate.type === 'relay',
    );
    const relay: DesktopHostRelay | undefined = redeemed.kind === 'relay'
      ? redeemed.relay
      : linkRelayCandidate
        ? { relayUrl: linkRelayCandidate.relayUrl, serverId: linkRelayCandidate.serverId, hostEncPubJwk: linkRelayCandidate.hostEncPubJwk }
        : undefined;
    const firstDirectUrl = payload.candidates
      .filter((candidate): candidate is Extract<PairingEndpointCandidate, { type: 'lan' | 'tunnel' }> => candidate.type !== 'relay')
      .map((candidate) => normalizeHostUrl(candidate.url))
      .find((value): value is string => Boolean(value));
    const directUrl = redeemed.kind === 'direct' ? redeemed.url : firstDirectUrl;
    const { token } = redeemed;

    const url = directUrl || (relay ? relayHostDisplayUrl(relay.serverId) : null);
    if (!url) {
      setDirectError("Invalid URL (must be http/https)");
      return;
    }
    const transportFields = {
      url,
      apiUrl: directUrl || undefined,
      clientToken: token,
      ...(relay ? { relay } : {}),
    };
    // One host per server: match by relay serverId when the link has a relay
    // leg, else by direct URL — re-importing updates the record in place.
    const existing = directHosts.find((host) => (
      relay ? host.relay?.serverId === relay.serverId : (!host.relay && normalizeHostUrl(host.apiUrl || host.url) === url)
    ));
    if (existing) {
      const nextHosts = directHosts.map((host) => host.id === existing.id
        ? { ...host, label: payload.label || host.label, ...transportFields }
        : host);
      await persistDirectHosts(nextHosts, directDefaultHostId);
    } else {
      // payload.label is normally the issuing server's hostname.
      await persistDirectHosts([{ id: makeId(), label: payload.label || redactSensitiveUrl(url), ...transportFields }, ...directHosts], directDefaultHostId);
    }
    setDirectConnectLink('');
    setDirectError(null);
    setDirectImportDialogOpen(false);
  }, [directConnectLink, directDefaultHostId, directHosts, persistDirectHosts]);

  const handleRemoveDirectHost = React.useCallback(async (id: string) => {
    const nextHosts = directHosts.filter((host) => host.id !== id);
    const nextDefault = directDefaultHostId === id ? 'local' : directDefaultHostId;
    await persistDirectHosts(nextHosts, nextDefault);
    if (directEditingId === id) {
      setDirectEditingId(null);
    }
  }, [directDefaultHostId, directEditingId, directHosts, persistDirectHosts]);

  const beginEditDirectHost = React.useCallback((host: DesktopHost) => {
    setDirectEditingId(host.id);
    setDirectEditLabel(host.label);
    setDirectEditUrl(host.apiUrl || host.url);
    setDirectEditToken(host.clientToken || '');
    setDirectEditHeaders(readRequestHeaderDrafts(host.requestHeaders));
    setDirectError(null);
  }, []);

  const saveDirectHostEdit = React.useCallback(async () => {
    if (!directEditingId) return;
    const resolved = resolveDesktopHostUrl(directEditUrl);
    if (!resolved) {
      setDirectError("Invalid URL (must be http/https)");
      return;
    }
    const url = resolved.persistedUrl;
    const nextHosts = directHosts.map((host) => host.id === directEditingId
      ? {
        ...host,
        label: directEditLabel.trim() || redactSensitiveUrl(url),
        url,
        apiUrl: url,
        clientToken: directEditToken.trim() || undefined,
        requestHeaders: buildRequestHeaders(directEditHeaders),
      }
      : host);
    await persistDirectHosts(nextHosts, directDefaultHostId);
    setDirectEditingId(null);
    if (resolved.redeemUrl) {
      navigateToUrl(resolved.redeemUrl);
    }
  }, [directDefaultHostId, directEditHeaders, directEditLabel, directEditToken, directEditUrl, directEditingId, directHosts, persistDirectHosts]);

  const createSshInstanceFromDialog = React.useCallback(async () => {
    const command = sshCommandDraft.trim();
    if (!command) {
      toast.error("SSH command is required");
      return;
    }
    const id = `ssh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await createFromCommand(id, command, sshNameDraft.trim() || "New SSH connection");
      setSelectedId(id);
      setSshAddDialogOpen(false);
      setSshCommandDraft('ssh user@example.com');
      setSshNameDraft('');
      toast.success("Instance created");
    } catch (error) {
      toast.error("Failed to create SSH connection", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [createFromCommand, setSelectedId, sshCommandDraft, sshNameDraft]);

  const setDefaultDirectHost = React.useCallback(async (id: string) => {
    await persistDirectHosts(directHosts, id);
  }, [directHosts, persistDirectHosts]);

  // Probe saved hosts whenever the list changes so each row shows a live
  // Connected/Unreachable status like the host switcher does. One pass per
  // list identity — no polling; the row set changes rarely.
  React.useEffect(() => {
    if (!showInstanceManagement || directHosts.length === 0) return;
    let cancelled = false;
    void Promise.all(directHosts.map(async (host) => {
      const relayProbe = () => probeRelayDesktopHost(host.relay!, { clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
      // Relay-only host: tunnel probe. Multi-transport host: direct first,
      // relay as the away-from-home fallback.
      if (host.relay && !host.apiUrl) {
        return [host.id, await relayProbe()] as const;
      }
      const url = normalizeHostUrl(getDesktopHostApiUrl(host));
      if (!url) {
        return [host.id, host.relay ? await relayProbe() : ({ status: 'unreachable', latencyMs: 0 } as HostProbeResult)] as const;
      }
      const direct = await desktopHostProbe(url, { clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null })
        .catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
      if (direct.status === 'unreachable' && host.relay) {
        const relayResult = await relayProbe();
        if (relayResult.status === 'ok') return [host.id, relayResult] as const;
      }
      return [host.id, direct] as const;
    })).then((entries) => {
      if (cancelled) return;
      setDirectHostStatus(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [directHosts, showInstanceManagement]);

  const loadRemoteClients = React.useCallback(async (options?: { silent?: boolean }) => {
    if (!clientAuth) return;
    if (!options?.silent) setRemoteClientsLoading(true);
    if (!options?.silent) setRemoteClientError(null);
    try {
      // Pending fetch failure returns null (NOT []) so a transient blip neither
      // blanks the pending list nor fakes a "pairing redeemed" signal for the
      // QR dialog's auto-close below.
      const [clients, pending] = await Promise.all([
        clientAuth.listClients(),
        clientAuth.listPendingPairings().catch(() => null),
      ]);
      setRemoteClients(clients);
      if (pending) setPendingPairings(pending);
    } catch (err) {
      // A silent poll must not surface a transient error over the live list.
      if (!options?.silent) setRemoteClientError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!options?.silent) setRemoteClientsLoading(false);
    }
  }, [clientAuth]);

  // Auto-close the QR/link dialog once the device connects: the pairing session
  // is single-use, so it leaving the pending list means it was redeemed (or
  // expired/cancelled — the dialog is stale either way). Armed only after the
  // pairing has been SEEN in the pending list — the result phase renders before
  // the refreshed list arrives, and closing on that stale "absent" would blink
  // the dialog shut immediately. Successful-fetch-only updates keep transient
  // poll failures from faking the disappearance.
  const pairingSeenPendingRef = React.useRef(false);
  React.useEffect(() => {
    if (!addDeviceOpen || addDevicePhase !== 'result' || !createdPairingId) return;
    if (pendingPairings.some((pending) => pending.id === createdPairingId)) {
      pairingSeenPendingRef.current = true;
      return;
    }
    if (!pairingSeenPendingRef.current) return;
    setCreatedPairingId(null);
    setAddDeviceOpen(false);
    // Celebrate only an actual redeem (a client minted from this pairing exists);
    // an expired or cancelled session closes the stale dialog silently.
    if (remoteClients.some((client) => client.pairingId === createdPairingId)) {
      toast.success("Device connected.");
    }
  }, [addDeviceOpen, addDevicePhase, createdPairingId, pendingPairings, remoteClients]);

  const cancelPendingPairing = React.useCallback(async (id: string) => {
    if (!clientAuth) return;
    try {
      await clientAuth.cancelPairing(id);
      setPendingPairings((prev) => prev.filter((entry) => entry.id !== id));
      await loadRemoteClients({ silent: true });
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  // Load on mount, then poll while the page is visible so a device that redeems
  // a pairing link shows up in the list without reopening settings.
  React.useEffect(() => {
    if (!clientAuth) return;
    void loadRemoteClients();
    const interval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void loadRemoteClients({ silent: true });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [clientAuth, loadRemoteClients]);

  // Available direct transports for the create dialog. The server is authoritative
  // for LAN reachability (derived from its bind, not the UI origin), so "Local
  // network" works even when the UI is opened on localhost. Falls back to the
  // client-side guess if the endpoint is unavailable.
  const resolveTransportOptions = React.useCallback(async (): Promise<{ localUrl: string | null; lanUrl: string | null; relayAvailable: boolean }> => {
    if (clientAuth?.getPairingTransports) {
      try {
        const transports = await clientAuth.getPairingTransports();
        return { localUrl: transports.local, lanUrl: transports.lan, relayAvailable: transports.relayAvailable };
      } catch {
        // fall through to the client-side guess
      }
    }
    const port = getRuntimePort();
    const localUrl = port ? `http://127.0.0.1:${port}` : (isLoopbackUrl(window.location.origin) ? window.location.origin : null);
    let lanUrl: string | null = null;
    try {
      const resolved = normalizeHostUrl(await resolvePairingServerUrl());
      lanUrl = resolved && !isLoopbackUrl(resolved) ? resolved : null;
    } catch {
      // keep null
    }
    return { localUrl, lanUrl, relayAvailable: true };
  }, [clientAuth]);

  const openAddDevice = React.useCallback(async () => {
    setRemoteClientError(null);
    setPairingUrl(null);
    setPairingQrDataUrl(null);
    setPairingCopied(false);
    setCreatedPairingId(null);
    setAddDevicePhase('configure');
    setAddDeviceFallback(true);
    setAddDeviceOpen(true);
    const opts = await resolveTransportOptions();
    setTransportOptions(opts);
    // "Anywhere" (relay, with home-network preference) is the right default for
    // most people; fall back to narrower options only when relay is unavailable.
    setAddDeviceTransport(opts.relayAvailable ? 'relay' : opts.lanUrl ? 'lan' : 'local');
  }, [resolveTransportOptions]);

  const createPairingLink = React.useCallback(async () => {
    if (!clientAuth?.createPairingSession || !transportOptions) return;
    setRemoteClientError(null);
    setAddDeviceCreating(true);
    try {
      const label = remoteClientLabel.trim() || undefined;
      // Map the chosen transport (+ fallback) to the per-link candidate request.
      let serverUrl: string | undefined;
      let includeRelay: boolean;
      let includeDirect = true;
      if (addDeviceTransport === 'local') {
        serverUrl = transportOptions.localUrl ?? undefined;
        includeRelay = false;
      } else if (addDeviceTransport === 'lan') {
        serverUrl = transportOptions.lanUrl ?? undefined;
        includeRelay = addDeviceFallback;
      } else if (addDeviceFallback && transportOptions.lanUrl) {
        // Relay, but prefer the local network when available: carry both.
        serverUrl = transportOptions.lanUrl;
        includeRelay = true;
      } else {
        // Relay only.
        includeDirect = false;
        includeRelay = true;
      }
      const { pairing, server } = await clientAuth.createPairingSession({
        label,
        allowedClientKinds: ['mobile', 'desktop'],
        serverUrl,
        includeRelay,
        includeDirect,
      });
      const payload = buildPairingConnectionPayload({
        pairingId: pairing.id,
        secret: pairing.secret,
        // The typed name (`label`) is the per-device label shown in THIS server's
        // device list; it already went to createPairingSession above. The payload
        // label is what the paired device names its connection by, which must be
        // the issuing server's name (hostname), not the device's own name.
        label: server.label,
        fingerprint: pairing.fingerprint ?? undefined,
        expiresAt: pairing.expiresAt,
        candidates: server.candidates as unknown as PairingEndpointCandidate[],
      });
      const encoded = encodePairingConnectionPayload(payload);
      setPairingUrl(encoded);
      // Pairing payloads are dense (multiple transport candidates + the relay
      // E2EE key), so render at high resolution with low error-correction.
      setPairingQrDataUrl(await QRCode.toDataURL(encoded, { width: 1024, margin: 2, errorCorrectionLevel: 'L' }));
      setPairingCopied(false);
      pairingSeenPendingRef.current = false;
      setCreatedPairingId(pairing.id);
      setAddDevicePhase('result');
      // Loads the pending list including this pairing BEFORE the result phase
      // polls it, so the auto-close effect sees "present -> gone" transitions.
      await loadRemoteClients({ silent: true });
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddDeviceCreating(false);
    }
  }, [clientAuth, transportOptions, addDeviceTransport, addDeviceFallback, remoteClientLabel, loadRemoteClients]);

  const handleCopyPairing = React.useCallback(() => {
    if (!pairingUrl) return;
    void copyTextToClipboard(pairingUrl).then((result) => {
      if (!result.ok) return;
      setPairingCopied(true);
      window.setTimeout(() => setPairingCopied(false), 2000);
    });
  }, [pairingUrl]);

  const revokeRemoteClient = React.useCallback(async (client: RemoteClientRecord) => {
    if (!clientAuth) return;
    const isLocalDesktopClient = client.clientKind === 'desktop-local';
    setRemoteClientError(null);
    try {
      await clientAuth.revokeClient(client.id);
      if (isLocalDesktopClient && isDesktopShell()) {
        const config = await desktopHostsGet();
        await desktopHostsSet({
          hosts: config.hosts,
          defaultHostId: config.defaultHostId,
          initialHostChoiceCompleted: config.initialHostChoiceCompleted,
          localClientToken: null,
        });
        setRemoteClients((clients) => clients.map((entry) => entry.id === client.id
          ? { ...entry, revokedAt: new Date().toISOString() }
          : entry));
        switchRuntimeEndpoint({ apiBaseUrl: getRuntimeApiBaseUrl(), clientToken: null, runtimeKey: 'local' });
        return;
      }
      await loadRemoteClients();
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  const purgeRevokedRemoteClients = React.useCallback(async () => {
    if (!clientAuth) return;
    setRemoteClientError(null);
    try {
      await clientAuth.purgeRevokedClients();
      await loadRemoteClients();
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  React.useEffect(() => {
    setDraft(selectedInstance);
  }, [selectedInstance]);

  React.useEffect(() => {
    if (!selectedId) {
      return;
    }
    const interval = window.setInterval(() => {
      // Skip polling when tab is hidden to reduce background work
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void refreshStatuses();
    }, 2_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [refreshStatuses, selectedId]);

  React.useEffect(() => {
    // Use requestAnimationFrame for smoother clock updates without setInterval overhead
    let rafId: number | null = null;
    let lastTime = Date.now();
    
    const tick = () => {
      const now = Date.now();
      // Update only once per second
      if (now - lastTime >= 1_000) {
        setClockMs(now);
        lastTime = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    
    // Only run when visible
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      rafId = requestAnimationFrame(tick);
    }
    
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && rafId === null) {
        rafId = requestAnimationFrame(tick);
      } else if (document.visibilityState !== 'visible' && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
    
    document.addEventListener('visibilitychange', onVisibility);
    
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  const status = selectedId ? statusesById[selectedId] : null;
  const statusPhase = status?.phase;
  const isReady = statusPhase === 'ready';
  const isReconnecting = statusPhase === 'degraded';
  const isConnecting = isConnectingPhase(statusPhase);
  const isBusy = isConnecting || isReconnecting;
  const canDisconnect = isReady || isBusy;
  const statusAgeMs = status ? Math.max(0, clockMs - status.updatedAtMs) : 0;
  const reconnectAppearsStuck = isReconnecting && statusAgeMs > 12_000;

  const hasChanges = React.useMemo(() => {
    if (!draft || !selectedInstance) return false;
    return JSON.stringify(draft) !== JSON.stringify(selectedInstance);
  }, [draft, selectedInstance]);

  const updateDraft = React.useCallback((updater: (current: DesktopSshInstance) => DesktopSshInstance) => {
    setDraft((current) => (current ? updater(current) : current));
  }, []);

  const handleSave = React.useCallback(async () => {
    if (!draft) return;
    const normalized = normalizeForSave(draft);

    if (!normalized.sshCommand.trim()) {
      toast.error("SSH command is required");
      return;
    }

    if (normalized.localForward.bindHost === '0.0.0.0') {
      const allow = window.confirm(
        "Binding to 0.0.0.0 exposes forwarded ports to your local network. Continue?",
      );
      if (!allow) {
        return;
      }
    }

    if (
      normalized.auth.sshPassword?.enabled &&
      normalized.auth.sshPassword.value?.trim() &&
      normalized.auth.sshPassword.store !== 'settings'
    ) {
      const store = window.confirm("Store SSH password in plaintext on disk?");
      normalized.auth.sshPassword.store = store ? 'settings' : 'never';
      if (!store) {
        normalized.auth.sshPassword.value = undefined;
      }
    }

    if (
      normalized.auth.pichamberPassword?.enabled &&
      normalized.auth.pichamberPassword.value?.trim() &&
      normalized.auth.pichamberPassword.store !== 'settings'
    ) {
      const store = window.confirm("Store UI password in plaintext on disk?");
      normalized.auth.pichamberPassword.store = store ? 'settings' : 'never';
      if (!store) {
        normalized.auth.pichamberPassword.value = undefined;
      }
    }

    try {
      await upsertInstance(normalized);
      toast.success("Instance saved");
    } catch (error) {
      toast.error("Failed to save instance", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [draft, upsertInstance]);

  const createImportedInstance = React.useCallback(
    async (host: string, destination: string): Promise<boolean> => {
      const id = `ssh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        await createFromCommand(id, `ssh ${destination}`, host);
        setSelectedId(id);
        toast.success("Instance created");
        return true;
      } catch (error) {
        toast.error("Failed to create SSH connection", {
          description: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    [createFromCommand, setSelectedId],
  );

  const closePatternDialog = React.useCallback(() => {
    if (patternCreating) {
      return;
    }
    setPatternHost(null);
    setPatternDestination('');
  }, [patternCreating]);

  const handleImportCandidate = React.useCallback(
    (host: string, pattern: boolean) => {
      if (pattern) {
        setPatternHost(host);
        setPatternDestination(suggestConcreteHost(host));
        return;
      }
      void createImportedInstance(host, host);
    },
    [createImportedInstance],
  );

  const handlePatternCreate = React.useCallback(async () => {
    const host = patternHost;
    const destination = patternDestination.trim();
    if (!host) {
      return;
    }
    if (!destination) {
      toast.error("Destination is required");
      return;
    }

    setPatternCreating(true);
    try {
      const created = await createImportedInstance(host, destination);
      if (created) {
        setPatternHost(null);
        setPatternDestination('');
      }
    } finally {
      setPatternCreating(false);
    }
  }, [createImportedInstance, patternDestination, patternHost]);

  const connectWithPortRecovery = React.useCallback(async () => {
    if (!selectedInstance) return;
    try {
      await connect(selectedInstance.id);
      return;
    } catch (error) {
      if (!isPortInUseError(error)) {
        throw error;
      }

      const allow = window.confirm("Local port is already in use. Pick a random free local port and retry?");
      if (!allow) {
        throw error;
      }

      const nextInstance: DesktopSshInstance = {
        ...selectedInstance,
        localForward: {
          ...selectedInstance.localForward,
          preferredLocalPort: randomPort(),
        },
      };

      await upsertInstance(nextInstance);
      await connect(nextInstance.id);
      toast.success("Retried with a random local port");
    }
  }, [connect, selectedInstance, upsertInstance]);

  const readLogsForInstance = React.useCallback(async (id: string) => {
    const lines = await desktopSshLogs(id, 600);
    return lines.map((line) => formatLogLine(line));
  }, []);

  const handleOpenLogs = React.useCallback(async () => {
    if (!draft) return;
    setLogDialogOpen(true);
    setLogDialogLoading(true);
    setLogDialogError(null);
    try {
      const lines = await readLogsForInstance(draft.id);
      setLogDialogLines(lines);
    } catch (error) {
      setLogDialogLines([]);
      setLogDialogError(error instanceof Error ? error.message : String(error));
    } finally {
      setLogDialogLoading(false);
    }
  }, [draft, readLogsForInstance]);

  React.useEffect(() => {
    if (!logDialogOpen || !draft) {
      return;
    }

    let disposed = false;
    const run = async () => {
      try {
        const lines = await readLogsForInstance(draft.id);
        if (!disposed) {
          setLogDialogLines(lines);
          setLogDialogError(null);
        }
      } catch (error) {
        if (!disposed) {
          setLogDialogError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    void run();
    const interval = window.setInterval(() => {
      // Skip polling when tab is hidden
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void run();
    }, 1_000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [draft, logDialogOpen, readLogsForInstance]);

  const logLinesText = React.useMemo(() => logDialogLines.join('\n'), [logDialogLines]);

  const handleCopyAllLogs = React.useCallback(() => {
    if (!logLinesText.trim()) {
      toast.error("No logs to copy");
      return;
    }
    void copyTextToClipboard(logLinesText).then((result) => {
      if (result.ok) {
        toast.success("Logs copied");
      }
    });
  }, [logLinesText]);

  const handleClearLogs = React.useCallback(async () => {
    if (!draft) {
      return;
    }
    try {
      await desktopSshLogsClear(draft.id);
      setLogDialogLines([]);
      toast.success("Logs cleared");
    } catch (error) {
      toast.error("Failed to clear logs", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [draft]);

  const handleOpenCurrentInstance = React.useCallback(async () => {
    if (!status?.localUrl) {
      toast.error("Instance URL is unavailable");
      return;
    }

    const target = status.localUrl.trim();
    if (!target) {
      toast.error("Instance URL is unavailable");
      return;
    }

    navigateToUrl(target);
  }, [status?.localUrl]);

  const handlePrimaryConnectionAction = React.useCallback(() => {
    if (!draft) {
      return;
    }

    setIsPrimaryActionPending(true);
    const operation = canDisconnect ? disconnect(draft.id) : connectWithPortRecovery();
    void operation
      .catch((error) => {
        const message = canDisconnect
          ? (isReady
            ? 'Failed to disconnect instance'
            : 'Failed to cancel connection')
          : 'Failed to connect instance';
        toast.error(message, {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        setIsPrimaryActionPending(false);
      });
  }, [canDisconnect, connectWithPortRecovery, disconnect, draft, isReady]);

  const handleRetryAction = React.useCallback(() => {
    if (!draft) {
      return;
    }

    if (isConnecting) {
      return;
    }

    setIsRetryPending(true);
    const operation = isReconnecting
      ? disconnect(draft.id).then(() => connectWithPortRecovery())
      : retry(draft.id);

    void operation
      .catch((error) => {
        toast.error("Failed to retry connection", {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        setIsRetryPending(false);
      });
  }, [connectWithPortRecovery, disconnect, draft, isConnecting, isReconnecting, retry]);

  const retryButtonLabel = isConnecting
    ? "Connecting..."
    : isReconnecting
      ? reconnectAppearsStuck
        ? "Reconnect now"
        : "Reconnecting..."
      : "Retry";

  const canRetry =
    !isPrimaryActionPending &&
    !isRetryPending &&
    (statusPhase === 'error' || statusPhase === 'idle' || !statusPhase || (isReconnecting && reconnectAppearsStuck)) &&
    !isConnecting;

  const primaryButtonLabel = isReady
    ? "Disconnect"
    : canDisconnect
      ? "Cancel"
      : "Connect";

  if (!draft) {
    return (
      <SettingsPageLayout title={isMobile ? undefined : "Remote Instances"}>
        {clientAuth ? (
          <SettingsSection
            title={"Connect to this server"}
            info={"Create a secure link or token so PiChamber Desktop can connect to this server."}
            divider={false}
            settingsItem="remote-instances.client-auth"
            contentClassName="space-y-3"
          >
              <div>
                <Button type="button" size="xs" className="!font-normal" onClick={() => void openAddDevice()}>
                  <Icon name="add" className="h-3.5 w-3.5" />
                  {"Add a device"}
                </Button>
              </div>
              <div className="space-y-2.5">
                {revokedClientCount > 0 ? (
                  <div className="flex justify-end">
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void purgeRevokedRemoteClients()}>
                      {"Clear revoked"}
                    </Button>
                  </div>
                ) : null}
                {remoteClientsLoading && remoteClients.length === 0 && pendingPairings.length === 0 ? (
                  <p className="typography-meta text-muted-foreground">{"Loading tokens..."}</p>
                ) : remoteClients.length === 0 && pendingPairings.length === 0 ? (
                  <p className="typography-meta text-muted-foreground">{"No devices connected yet."}</p>
                ) : (
                  <>
                    {pendingPairings.map((pending) => (
                      <div key={`pending-${pending.id}`} className="flex items-center justify-between gap-3 py-1.5">
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--status-warning)] animate-pulse" />
                            <p className="typography-ui-label text-foreground truncate">{pending.label || "Device name — e.g. My iPhone"}</p>
                            {pending.usesRelay ? (
                              <span className="typography-micro text-muted-foreground bg-muted px-1 rounded shrink-0 leading-none pb-px border border-border/50">{"Relay"}</span>
                            ) : null}
                          </div>
                          <p className="typography-micro text-muted-foreground truncate">{"Waiting to connect…"}</p>
                        </div>
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void cancelPendingPairing(pending.id)}>
                          {"Cancel"}
                        </Button>
                      </div>
                    ))}
                    {remoteClients.map((client) => {
                      const isLocalDesktopClient = client.clientKind === 'desktop-local';
                      // Live presence: the server refreshes lastUsedAt on every
                      // authenticated request (writes throttled to 60s), so a
                      // device with activity in the last 90s is connected NOW.
                      // The list polls every 5s, keeping this fresh.
                      const lastUsedMs = client.lastUsedAt ? Date.parse(client.lastUsedAt) : Number.NaN;
                      const isOnline = !client.revokedAt
                        && (isLocalDesktopClient || (Number.isFinite(lastUsedMs) && Date.now() - lastUsedMs < 90_000));
                      const statusText = client.revokedAt
                        ? "Revoked"
                        : isOnline
                          ? (client.lastTransport === 'relay' && !isLocalDesktopClient
                            ? "Connected · Relay"
                            : "Connected · Local network")
                          : Number.isFinite(lastUsedMs)
                            ? `Last used ${formatDateTimeForPreference(lastUsedMs, timeFormatPreference, {
                                  month: 'short',
                                  day: 'numeric',
                                  hour: 'numeric',
                                  minute: '2-digit',
                                })}`
                            : "Never used";
                      return (
                        <div key={client.id} className="flex items-center justify-between gap-3 py-1.5">
                          <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className={cn(
                                'h-2 w-2 shrink-0 rounded-full',
                                client.revokedAt ? 'bg-muted-foreground/20' : isOnline ? 'bg-[var(--status-success)]' : 'bg-muted-foreground/30',
                              )} />
                              <p className="typography-ui-label text-foreground truncate">{client.label}</p>
                              {devicePlatformLabel(client.devicePlatform) ? (
                                <span className="typography-micro text-muted-foreground bg-muted px-1 rounded shrink-0 leading-none pb-px border border-border/50">
                                  {devicePlatformLabel(client.devicePlatform)}
                                </span>
                              ) : null}
                              {isLocalDesktopClient ? (
                                <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                                  {"This device"}
                                </span>
                              ) : null}
                              <span className={cn('typography-micro truncate', isOnline && !client.revokedAt ? 'text-[var(--status-success)]' : 'text-muted-foreground')}>{statusText}</span>
                            </div>
                          </div>
                          <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void revokeRemoteClient(client)} disabled={Boolean(client.revokedAt)}>
                            {"Revoke"}
                          </Button>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
              {remoteClientError ? <p className="typography-meta text-[var(--status-error)]">{remoteClientError}</p> : null}
          </SettingsSection>
        ) : null}

        {showInstanceManagement ? <SettingsSection
          title={"Other PiChamber servers"}
          info={"Servers this app can switch to. Import a pairing link from the other server, or add one by address."}
          settingsItem="remote-instances.direct-hosts"
          contentClassName="space-y-4"
          headerAction={(
            /* Importing a pairing link is the flagship path; add-by-address is
               the manual fallback. The token-storage note lives in the add
               dialog next to the token field it describes. */
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" size="xs" className="!font-normal" onClick={() => setDirectImportDialogOpen(true)} disabled={directSaving}>
                {"Import Link"}
              </Button>
              <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectAddDialogOpen(true)} disabled={directSaving}>
                <Icon name="add" className="h-3.5 w-3.5" />
                {"Add Server"}
              </Button>
            </div>
          )}
        >
            <div className="space-y-2.5">
              {directLoading ? (
                <p className="typography-meta text-muted-foreground">{"Loading instances..."}</p>
              ) : directHosts.length === 0 ? (
                <p className="typography-meta text-muted-foreground">{"No other servers added yet."}</p>
              ) : directHosts.map((host) => {
                const probe = directHostStatus[host.id];
                const statusLabel = !probe
                  ? 'Checking'
                  : probe.status === 'ok'
                    ? 'Connected'
                    : probe.status === 'auth'
                      ? 'Auth required'
                      : probe.status === 'update-recommended'
                        ? 'Update recommended'
                        : probe.status === 'incompatible'
                          ? 'Incompatible'
                          : probe.status === 'wrong-service'
                            ? 'Wrong service'
                            : 'Unreachable';
                const isOnline = probe?.status === 'ok';
                return (
                <div key={host.id} className="py-1.5">
                  <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            !probe ? 'bg-muted-foreground/30 animate-pulse' : isOnline ? 'bg-[var(--status-success)]' : 'bg-[var(--status-error)]',
                          )} />
                          <p className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(host.label)}</p>
                          {directDefaultHostId === host.id ? <span className="typography-micro text-muted-foreground shrink-0">{"Default"}</span> : null}
                          <span className={cn('typography-micro shrink-0', isOnline ? 'text-[var(--status-success)]' : 'text-muted-foreground')}>
                            {statusLabel}
                            {isOnline && typeof probe?.latencyMs === 'number'
                              ? ` · ${Math.max(0, Math.round(probe.latencyMs))}ms ping`
                              : ''}
                          </span>
                        </div>
                        <p className={cn('typography-micro text-muted-foreground truncate', host.apiUrl && 'font-mono')}>
                          {host.relay && !host.apiUrl ? "via PiChamber Relay" : redactSensitiveUrl(host.apiUrl || host.url)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void setDefaultDirectHost(host.id)} disabled={directSaving || directDefaultHostId === host.id} aria-label={"Set as default"}>
                          {directDefaultHostId === host.id ? <Icon name="star-fill" className="h-3.5 w-3.5" /> : <Icon name="star" className="h-3.5 w-3.5" />}
                        </Button>
                        {/* The edit form is URL/token-centric; relay-ONLY hosts have
                            nothing it can edit and are re-imported via a fresh pairing
                            link instead. Multi-transport hosts keep their relay leg
                            through the edit (object spread preserves it). */}
                        {host.relay && !host.apiUrl ? null : (
                          <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => beginEditDirectHost(host)} disabled={directSaving}>
                            <Icon name="pencil" className="h-3.5 w-3.5" />
                            {"Edit"}
                          </Button>
                        )}
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void handleRemoveDirectHost(host.id)} disabled={directSaving}>
                          <Icon name="delete-bin" className="h-3.5 w-3.5" />
                          {"Delete"}
                        </Button>
                      </div>
                  </div>
                </div>
                );
              })}
            </div>

            {directError ? <p className="typography-meta text-[var(--status-error)]">{directError}</p> : null}
        </SettingsSection> : null}

        {showInstanceManagement ? <Dialog open={directAddDialogOpen} onOpenChange={setDirectAddDialogOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{"Add Server"}</DialogTitle>
              <DialogDescription>{"Add another PiChamber server by URL. Use this when the server is already running and you have a connection token."}</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void handleAddDirectHost(); }}>
              <Input className="h-8" value={directLabel} onChange={(event) => setDirectLabel(event.target.value)} placeholder={"Label (optional)"} disabled={directSaving} />
              <Input className="h-8" value={directUrl} onChange={(event) => setDirectUrl(event.target.value)} placeholder={"https://host:port"} disabled={directSaving} autoFocus />
              <div className="space-y-1">
                <Input className="h-8" value={directToken} onChange={(event) => setDirectToken(event.target.value)} placeholder={"Connection token (optional for trusted local servers)"} type="password" disabled={directSaving} />
                <p className="px-1 typography-micro text-muted-foreground">{"Connection tokens are saved on this device and used only when this app connects to that server."}</p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <SettingsGroupTitle>{"Additional headers"}</SettingsGroupTitle>
                  <SettingsInfoHint>{"Optional HTTP headers for desktop API requests. Authorization is reserved for the connection token."}</SettingsInfoHint>
                </div>
                {directHeaders.map((header) => (
                  <div key={header.id} className="flex w-full gap-2">
                    <Input className="h-8 font-mono text-xs" value={header.name} onChange={(event) => setDirectHeaders((headers) => headers.map((item) => item.id === header.id ? { ...item, name: event.target.value } : item))} placeholder={"Header name"} disabled={directSaving} />
                    <Input className="h-8 font-mono text-xs" value={header.value} onChange={(event) => setDirectHeaders((headers) => headers.map((item) => item.id === header.id ? { ...item, value: event.target.value } : item))} placeholder={"Header value"} type="password" disabled={directSaving} />
                    <button type="button" onClick={() => setDirectHeaders((headers) => headers.filter((item) => item.id !== header.id))} className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--status-error-background)] hover:text-[var(--status-error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]" aria-label={"Remove header"} disabled={directSaving}>
                      <Icon name="close" className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => setDirectHeaders((headers) => [...headers, createHeaderDraft()])} disabled={directSaving}>
                  <Icon name="add" className="h-3.5 w-3.5" />
                  {"Add header"}
                </Button>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectAddDialogOpen(false)} disabled={directSaving}>{"Cancel"}</Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={directSaving || !directUrl.trim()}>{"Add Server"}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog> : null}

        {showInstanceManagement ? <Dialog open={Boolean(directEditingId)} onOpenChange={(open) => { if (!open) setDirectEditingId(null); }}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{"Edit"}</DialogTitle>
              <DialogDescription>{"Servers this app can switch to. Import a pairing link from the other server, or add one by address."}</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void saveDirectHostEdit(); }}>
              <Input className="h-8" value={directEditLabel} onChange={(event) => setDirectEditLabel(event.target.value)} placeholder={"Label (optional)"} disabled={directSaving} />
              <Input className="h-8" value={directEditUrl} onChange={(event) => setDirectEditUrl(event.target.value)} placeholder={"https://host:port"} disabled={directSaving} autoFocus />
              <Input className="h-8" value={directEditToken} onChange={(event) => setDirectEditToken(event.target.value)} placeholder={"Connection token (optional for trusted local servers)"} type="password" disabled={directSaving} />
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <SettingsGroupTitle>{"Additional headers"}</SettingsGroupTitle>
                  <SettingsInfoHint>{"Optional HTTP headers for desktop API requests. Authorization is reserved for the connection token."}</SettingsInfoHint>
                </div>
                {directEditHeaders.map((header) => (
                  <div key={header.id} className="flex w-full gap-2">
                    <Input className="h-8 font-mono text-xs" value={header.name} onChange={(event) => setDirectEditHeaders((headers) => headers.map((item) => item.id === header.id ? { ...item, name: event.target.value } : item))} placeholder={"Header name"} disabled={directSaving} />
                    <Input className="h-8 font-mono text-xs" value={header.value} onChange={(event) => setDirectEditHeaders((headers) => headers.map((item) => item.id === header.id ? { ...item, value: event.target.value } : item))} placeholder={"Header value"} type="password" disabled={directSaving} />
                    <button type="button" onClick={() => setDirectEditHeaders((headers) => headers.filter((item) => item.id !== header.id))} className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--status-error-background)] hover:text-[var(--status-error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]" aria-label={"Remove header"} disabled={directSaving}>
                      <Icon name="close" className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => setDirectEditHeaders((headers) => [...headers, createHeaderDraft()])} disabled={directSaving}>
                  <Icon name="add" className="h-3.5 w-3.5" />
                  {"Add header"}
                </Button>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectEditingId(null)} disabled={directSaving}>{"Cancel"}</Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={directSaving}>{"Save Changes"}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog> : null}

        {showInstanceManagement ? <Dialog open={directImportDialogOpen} onOpenChange={setDirectImportDialogOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{"Import Link"}</DialogTitle>
              <DialogDescription>{"Paste a connection link from another PiChamber server."}</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void importDirectConnectLink(); }}>
              <Input className="h-8" value={directConnectLink} onChange={(event) => setDirectConnectLink(event.target.value)} placeholder={"pichamber://connect?..."} disabled={directSaving} autoFocus />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectImportDialogOpen(false)} disabled={directSaving}>{"Cancel"}</Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={directSaving || !directConnectLink.trim()}>{"Import Link"}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog> : null}

        <Dialog open={addDeviceOpen} onOpenChange={setAddDeviceOpen}>
          <DialogContent className={addDevicePhase === 'result' ? 'sm:max-w-lg' : 'sm:max-w-md'}>
            <DialogHeader>
              <DialogTitle>{addDevicePhase === 'result' ? "Scan to connect" : "Add a device"}</DialogTitle>
              {/* Configure phase: what this dialog will produce. Result phase: what
                  to do with the QR code that is now on screen. */}
              <DialogDescription>{addDevicePhase === 'result' ? "Scan this with the PiChamber app on your other device. It is single-use and expires." : "Create a one-time QR code that connects another device to this server."}</DialogDescription>
            </DialogHeader>
            {addDevicePhase === 'configure' ? (
              <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void createPairingLink(); }}>
                <Input
                  className="h-8"
                  value={remoteClientLabel}
                  onChange={(event) => setRemoteClientLabel(event.target.value)}
                  placeholder={"Device name — e.g. My iPhone"}
                  autoFocus
                />
                <div className="space-y-1.5">
                  <p className="typography-ui-label text-foreground">{"Where will you use this device?"}</p>
                  {/* Ordered by how likely a first-time user is to want each option;
                      "Anywhere" is the default. Every option explains its outcome in
                      plain words — "relay" appears only inside the description. */}
                  <div role="radiogroup" aria-label={"Where will you use this device?"} className="space-y-1.5">
                    {([
                      { key: 'relay' as const, label: "Anywhere", hint: "Works at home and away. Away traffic goes through PiChamber Private Relay — an end-to-end encrypted tunnel. No setup needed.", available: Boolean(transportOptions?.relayAvailable) },
                      { key: 'lan' as const, label: "Home network only", hint: "Connects directly over your Wi-Fi. Does not work away from this network.", available: Boolean(transportOptions?.lanUrl) },
                      { key: 'local' as const, label: "This computer only", hint: "For apps running on this same machine.", available: Boolean(transportOptions?.localUrl) },
                    ]).map((option) => {
                      const selected = addDeviceTransport === option.key;
                      return (
                        <div
                          key={option.key}
                          className={cn('flex items-start gap-2 py-0.5', option.available ? 'cursor-pointer' : 'opacity-45')}
                          onClick={() => { if (option.available) setAddDeviceTransport(option.key); }}
                          role="presentation"
                        >
                          <Radio
                            checked={selected}
                            disabled={!option.available}
                            onChange={() => setAddDeviceTransport(option.key)}
                            ariaLabel={option.label}
                            className="mt-0.5"
                          />
                          <div className="min-w-0">
                            <p className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/70')}>{option.label}</p>
                            <p className="typography-meta text-muted-foreground">{option.hint}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {addDeviceTransport === 'lan' ? (
                    <label className="flex w-fit cursor-pointer items-center gap-2 pt-1">
                      <Checkbox checked={addDeviceFallback} onChange={setAddDeviceFallback} ariaLabel={"Also allow the encrypted relay when away from home"} />
                      <span className="typography-meta text-muted-foreground">{"Also allow the encrypted relay when away from home"}</span>
                    </label>
                  ) : null}
                  {addDeviceTransport === 'relay' && transportOptions?.lanUrl ? (
                    <label className="flex w-fit cursor-pointer items-center gap-2 pt-1">
                      <Checkbox checked={addDeviceFallback} onChange={setAddDeviceFallback} ariaLabel={"Prefer the direct home connection when available"} />
                      <span className="typography-meta text-muted-foreground">{"Prefer the direct home connection when available"}</span>
                    </label>
                  ) : null}
                </div>
                {remoteClientError ? <p className="typography-meta text-[var(--status-error)]">{remoteClientError}</p> : null}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setAddDeviceOpen(false)} disabled={addDeviceCreating}>{"Cancel"}</Button>
                  <Button type="submit" size="xs" className="!font-normal" disabled={addDeviceCreating || !transportOptions}>{"Create QR code"}</Button>
                </div>
              </form>
            ) : (
              <div className="space-y-3">
                {pairingQrDataUrl ? (
                  <div className="flex justify-center">
                    <img src={pairingQrDataUrl} alt={"PiChamber connection QR code"} className="w-full max-w-[420px] rounded-md bg-white p-4" />
                  </div>
                ) : null}
                {pairingUrl ? (
                  <div className="flex items-center gap-2 rounded-md border border-[var(--interactive-border)] p-2">
                    <code className="min-w-0 flex-1 truncate typography-code text-muted-foreground">{pairingUrl}</code>
                    <Button type="button" variant="outline" size="xs" className="!font-normal shrink-0" onClick={handleCopyPairing}>
                      <Icon name={pairingCopied ? 'check' : 'file-copy'} className={cn('h-3.5 w-3.5', pairingCopied && 'text-[var(--status-success)]')} />
                      {pairingCopied ? "Copied" : "Copy all"}
                    </Button>
                  </div>
                ) : null}
                <div className="flex justify-end">
                  <Button type="button" size="xs" className="!font-normal" onClick={() => setAddDeviceOpen(false)}>{"Done"}</Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {showInstanceManagement ? <SettingsSection
          headerAction={(
            <Button type="button" size="xs" className="!font-normal" onClick={() => setSshAddDialogOpen(true)}>
              <Icon name="add" className="h-3.5 w-3.5" />
              {"Add SSH connection"}
            </Button>
          )}
          contentClassName="space-y-2.5"
        >
            {isLoading ? (
              <p className="typography-meta text-muted-foreground">{"Loading SSH hosts..."}</p>
            ) : instances.length === 0 ? (
              <p className="typography-meta text-muted-foreground">{"No SSH hosts found."}</p>
            ) : instances.map((instance) => {
              const instanceStatus = statusesById[instance.id];
              const title = instance.nickname?.trim() || instance.sshParsed?.destination || instance.id;
              const phase = instanceStatus?.phase;
              const ready = phase === 'ready';
              return (
                <div key={instance.id} className="flex items-center justify-between gap-3 py-1.5">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${phaseDotClass(phase)}`} />
                      <p className="typography-ui-label text-foreground truncate">{title}</p>
                    </div>
                    <p className="typography-micro text-muted-foreground truncate">
                      {phaseLabel(phase)}{instanceStatus?.localUrl ? ` · ${instanceStatus.localUrl}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => {
                      const op = ready ? disconnect(instance.id) : connect(instance.id);
                      void op.catch((err) => toast.error(ready ? "Failed to disconnect instance" : "Failed to connect instance", {
                        description: err instanceof Error ? err.message : String(err),
                      }));
                    }}>
                      {ready ? <Icon name="stop" className="h-3.5 w-3.5" /> : <Icon name="plug-2" className="h-3.5 w-3.5" />}
                      {ready ? "Disconnect" : "Connect"}
                    </Button>
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => setSelectedId(instance.id)}>
                      <Icon name="pencil" className="h-3.5 w-3.5" />
                      {"Edit"}
                    </Button>
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => {
                      const ok = window.confirm("Remove this remote instance?");
                      if (!ok) return;
                      void removeInstance(instance.id).catch((err) => toast.error("Failed to remove instance", {
                        description: err instanceof Error ? err.message : String(err),
                      }));
                    }}>
                      <Icon name="delete-bin" className="h-3.5 w-3.5" />
                      {"Delete"}
                    </Button>
                  </div>
                </div>
              );
            })}
        </SettingsSection> : null}

        {showInstanceManagement ? <Dialog open={sshAddDialogOpen} onOpenChange={setSshAddDialogOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{"Add SSH connection"}</DialogTitle>
              <DialogDescription>{"Choose the SSH command and a display name for this connection."}</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void createSshInstanceFromDialog(); }}>
              <Input className="h-8" value={sshNameDraft} onChange={(event) => setSshNameDraft(event.target.value)} placeholder={"Work laptop"} disabled={isSaving} />
              <Input className="h-8" value={sshCommandDraft} onChange={(event) => setSshCommandDraft(event.target.value)} placeholder={"ssh user@host"} disabled={isSaving} autoFocus />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setSshAddDialogOpen(false)} disabled={isSaving}>{"Cancel"}</Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={isSaving || !sshCommandDraft.trim()}>{"Create"}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog> : null}

        {showInstanceManagement ? <SettingsSection
          title={"Saved SSH hosts"}
        >
          {isImportsLoading ? (
            <p className="typography-meta text-muted-foreground">{"Loading SSH hosts..."}</p>
          ) : importCandidates.length === 0 ? (
            <p className="typography-meta text-muted-foreground">{"No SSH hosts found."}</p>
          ) : (
            <div>
              {importCandidates.map((candidate) => (
                <div key={`${candidate.source}:${candidate.host}`} className="flex items-center justify-between gap-3 border-b border-[var(--surface-subtle)] py-3 last:border-b-0">
                  <div className="min-w-0">
                    <div className="typography-ui-label font-medium text-foreground truncate">
                      {candidate.host}
                      {candidate.pattern ? ` ${"(pattern)"}` : ''}
                    </div>
                    <div className="typography-meta text-muted-foreground truncate">{candidate.sshCommand}</div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="!font-normal"
                    onClick={() => void handleImportCandidate(candidate.host, candidate.pattern)}
                  >
                    {"Import"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </SettingsSection> : null}

        <Dialog
          open={Boolean(patternHost)}
          onOpenChange={(open) => {
            if (!open) {
              closePatternDialog();
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{"Choose an SSH destination"}</DialogTitle>
              <DialogDescription>
                {patternHost ? `${patternHost} requires a concrete destination.` : "Enter destination."}
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                handlePatternCreate();
              }}
            >
              <Input
                value={patternDestination}
                onChange={(event) => setPatternDestination(event.target.value)}
                placeholder={"user@host"}
                autoFocus
              />
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={closePatternDialog} disabled={patternCreating}>
                  {"Cancel"}
                </Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={patternCreating}>
                  {"Create"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </SettingsPageLayout>
    );
  }

  const isManagedMode = draft.remoteOpenchamber.mode === 'managed';
  const instanceTitle = draft.nickname?.trim() || draft.sshParsed?.destination || draft.id;

  return (
    <Dialog open={Boolean(draft)} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-auto">
      <div className="mb-6 px-1">
        <h1 className={`${SETTINGS_PAGE_TITLE_CLASS} truncate`}>{instanceTitle}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 typography-meta text-muted-foreground">
          <span className={`h-2.5 w-2.5 rounded-full ${phaseDotClass(statusPhase)}`} />
          <span>{phaseLabel(statusPhase)}</span>
          {status?.localUrl ? <span className="font-mono text-foreground/80">{status.localUrl}</span> : null}
          {reconnectAppearsStuck ? <span>{"Reconnection looks stuck. You can retry now."}</span> : null}
        </div>
      </div>

      <SettingsSection
        title={"Actions"}
        info={"Connect, reconnect, view logs, or remove this connection."}
        divider={false}
        contentClassName="space-y-3"
      >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={canDisconnect ? 'outline' : 'default'}
              size="xs"
              className="!font-normal"
              onClick={handlePrimaryConnectionAction}
              disabled={isPrimaryActionPending || isRetryPending}
            >
              {canDisconnect ? <Icon name="stop" className="h-3.5 w-3.5" /> : <Icon name="plug-2" className="h-3.5 w-3.5" />}
              {primaryButtonLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={handleRetryAction}
              disabled={!canRetry}
            >
              <Icon name="refresh" className={`h-3.5 w-3.5 ${isConnecting || (isReconnecting && !reconnectAppearsStuck) ? 'animate-spin' : ''}`} />
              {retryButtonLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => {
                void handleOpenLogs();
              }}
            >
              <Icon name="terminal-window" className="h-3.5 w-3.5" />
              {"SSH Logs"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal text-[var(--status-error)] border-[var(--status-error)]/30 hover:text-[var(--status-error)]"
              onClick={() => {
                const ok = window.confirm("Remove this remote instance?");
                if (!ok) return;
                void removeInstance(draft.id)
                  .then(() => {
                    setSelectedId(null);
                    toast.success("Instance removed");
                  })
                  .catch((err) => {
                    toast.error("Failed to remove instance", {
                      description: err instanceof Error ? err.message : String(err),
                    });
                  });
              }}
            >
              <Icon name="delete-bin" className="h-3.5 w-3.5" />
              {"Remove"}
            </Button>
          </div>
          {status?.localUrl ? (
            <div className="flex flex-wrap items-center gap-2 typography-meta text-muted-foreground">
              <span>{"Current local URL:"}</span>
              <span className="font-mono text-foreground/90">{status.localUrl}</span>
            </div>
          ) : null}
      </SettingsSection>

      <SettingsSection
        title={"Instance"}
        info={"Choose the SSH command and a display name for this connection."}
        contentClassName="space-y-3"
      >
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{"SSH command"}</span>
            <Input
              className="h-7 md:max-w-xl"
              value={draft.sshCommand}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  sshCommand: event.target.value,
                }))
              }
              placeholder={"ssh user@host"}
            />
          </div>
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{"Nickname"}</span>
            <Input
              className="h-7 md:max-w-sm"
              value={draft.nickname || ''}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  nickname: event.target.value,
                }))
              }
              placeholder={"Work laptop"}
            />
          </div>
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{"Connection timeout (seconds)"}</span>
            <NumberInput
              containerClassName="w-fit"
              min={5}
              max={240}
              step={1}
              className="w-16 tabular-nums"
              value={draft.connectionTimeoutSec}
              onValueChange={(next) => {
                updateDraft((current) => ({
                  ...current,
                  connectionTimeoutSec: Number.isFinite(next) ? next : current.connectionTimeoutSec,
                }));
              }}
            />
          </div>
      </SettingsSection>

      <SettingsSection
        title={"PiChamber on the remote machine"}
        info={"Choose how PiChamber should run after SSH connects."}
        contentClassName="space-y-3"
      >
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <div className="w-56 shrink-0">
                <HintLabel
                  label={"Mode"}
                  hint={"Choose whether PiChamber should start the server for you, or connect to one that is already running."}
                />
            </div>
            <Select
              value={draft.remoteOpenchamber.mode}
              onValueChange={(value) =>
                updateDraft((current) => ({
                  ...current,
                  remoteOpenchamber: {
                    ...current.remoteOpenchamber,
                    mode: value === 'external' ? 'external' : 'managed',
                  },
                }))
              }
            >
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-fit min-w-[140px]">
                <SelectValue placeholder={"Select mode"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="managed">{"Start it for me"}</SelectItem>
                <SelectItem value="external">{"Already running"}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <div className="w-56 shrink-0">
                <HintLabel
                  label={"Preferred remote port"}
                  hint={"Port to use on the remote machine. Leave empty to choose one automatically."}
                />
            </div>
            <NumberInput
              containerClassName="w-fit"
              min={1}
              max={65535}
              step={1}
              className="w-20 tabular-nums"
              value={draft.remoteOpenchamber.preferredPort}
              onValueChange={(next) => {
                updateDraft((current) => ({
                  ...current,
                  remoteOpenchamber: {
                    ...current.remoteOpenchamber,
                    preferredPort: Number.isFinite(next) && next > 0 ? next : undefined,
                  },
                }));
              }}
              onClear={() => {
                updateDraft((current) => ({
                  ...current,
                  remoteOpenchamber: {
                    ...current.remoteOpenchamber,
                    preferredPort: undefined,
                  },
                }));
              }}
              emptyLabel={"Auto"}
            />
          </div>

          {isManagedMode ? (
            <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
              <div className="w-56 shrink-0">
                <HintLabel
                  label={"Install method"}
                  hint={"How PiChamber should be placed on the remote machine when this app starts it for you."}
                />
              </div>
              <Select
                value={draft.remoteOpenchamber.installMethod}
                onValueChange={(value) =>
                  updateDraft((current) => ({
                    ...current,
                    remoteOpenchamber: {
                      ...current.remoteOpenchamber,
                      installMethod:
                        value === 'npm' || value === 'download_release' || value === 'upload_bundle'
                          ? value
                          : 'bun',
                    },
                  }))
                }
              >
                <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-fit min-w-[140px]">
                  <SelectValue placeholder={"Select install method"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bun">bun</SelectItem>
                  <SelectItem value="npm">npm</SelectItem>
                  <SelectItem value="download_release">{"Download release"}</SelectItem>
                  <SelectItem value="upload_bundle">{"Upload bundle"}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {isManagedMode ? (
            <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
              <div className="w-56 shrink-0">
                <HintLabel
                  label={"Keep server running"}
                  hint={"Keep PiChamber running on the remote machine after you disconnect."}
                />
              </div>
              <div className="flex w-full items-center gap-2 md:max-w-xs">
                <Switch
                  checked={draft.remoteOpenchamber.keepRunning}
                  onCheckedChange={(checked) =>
                    updateDraft((current) => ({
                      ...current,
                      remoteOpenchamber: {
                        ...current.remoteOpenchamber,
                        keepRunning: checked,
                      },
                    }))
                  }
                />
              </div>
            </div>
          ) : null}
      </SettingsSection>

      <SettingsSection
        title={"Local access"}
        info={"Choose the local address used to open this remote PiChamber server."}
        contentClassName="space-y-3"
      >
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <div className="w-56 shrink-0">
                <HintLabel
                  label={"Bind host"}
                  hint={"Where the local connection should listen. Use 127.0.0.1 or localhost unless you need LAN access."}
                />
            </div>
            <Select
              value={draft.localForward.bindHost}
              onValueChange={(value) => {
                if (value === '0.0.0.0') {
                  const allow = window.confirm(
                    "Binding to 0.0.0.0 exposes forwarded ports to your local network. Continue?",
                  );
                  if (!allow) return;
                }
                updateDraft((current) => ({
                  ...current,
                  localForward: {
                    ...current.localForward,
                    bindHost: value === 'localhost' || value === '0.0.0.0' ? value : '127.0.0.1',
                  },
                }));
              }}
            >
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-fit min-w-[140px]">
                <SelectValue placeholder={"Select bind host"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="127.0.0.1">127.0.0.1</SelectItem>
                <SelectItem value="localhost">localhost</SelectItem>
                <SelectItem value="0.0.0.0">0.0.0.0</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <div className="w-56 shrink-0">
                <HintLabel
                  label={"Preferred local port"}
                  hint={"Local port to open for this connection. Leave empty to choose one automatically."}
                />
            </div>
            <div className="flex w-full items-center gap-2 md:max-w-sm">
              <NumberInput
                containerClassName="w-fit"
                min={1}
                max={65535}
                step={1}
                className="w-20 tabular-nums"
                value={draft.localForward.preferredLocalPort}
                onValueChange={(next) => {
                  updateDraft((current) => ({
                    ...current,
                    localForward: {
                      ...current.localForward,
                      preferredLocalPort: Number.isFinite(next) && next > 0 ? next : undefined,
                    },
                  }));
                }}
                onClear={() => {
                  updateDraft((current) => ({
                    ...current,
                    localForward: {
                      ...current.localForward,
                      preferredLocalPort: undefined,
                    },
                  }));
                }}
                emptyLabel={"Auto"}
              />
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal h-7 w-7 px-0"
                title={"Pick random port"}
                onClick={() =>
                  updateDraft((current) => ({
                    ...current,
                    localForward: {
                      ...current.localForward,
                      preferredLocalPort: randomPort(),
                    },
                  }))
                }
              >
                <Icon name="shuffle" className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
      </SettingsSection>

      <SettingsSection
        title={"Authentication"}
        info={"Optional credentials for SSH and the remote PiChamber UI."}
        contentClassName="space-y-3"
      >
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{"SSH password (optional)"}</span>
            <Input
              className="h-7 md:max-w-sm"
              type="password"
              value={draft.auth.sshPassword?.value || ''}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  auth: {
                    ...current.auth,
                    sshPassword: {
                      enabled: event.target.value.trim().length > 0,
                      value: event.target.value,
                      store: current.auth.sshPassword?.store || 'never',
                    },
                  },
                }))
              }
              placeholder={"Enter SSH password"}
            />
          </div>

          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{"UI password (optional)"}</span>
            <Input
              className="h-7 md:max-w-sm"
              type="password"
              value={draft.auth.pichamberPassword?.value || ''}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  auth: {
                    ...current.auth,
                    pichamberPassword: {
                      enabled: event.target.value.trim().length > 0,
                      value: event.target.value,
                      store: current.auth.pichamberPassword?.store || 'never',
                    },
                  },
                }))
              }
              placeholder={"Enter UI password"}
            />
          </div>
      </SettingsSection>

      <SettingsSection
        title={"Port Forwards"}
        info={"Optional extra ports to make available through this SSH connection."}
        contentClassName="space-y-2"
      >
          {draft.portForwards.length === 0 ? (
            <p className="typography-micro text-muted-foreground/80">{"No extra port forwards configured."}</p>
          ) : null}

          {draft.portForwards.map((forward, index) => {
            const updateForward = (updater: (forward: DesktopSshPortForward) => DesktopSshPortForward) => {
              updateDraft((current) => ({
                ...current,
                portForwards: current.portForwards.map((item, itemIndex) =>
                  itemIndex === index ? updater(item) : item,
                ),
              }));
            };

            const localLabel = forward.type === 'remote' ? 'Local target' : 'Local listen';
            const localHint = forward.type === 'remote'
              ? 'Local host and port on your machine that receives traffic from remote -R listener.'
              : 'Local host and port where this forward listens on your machine.';
            const remoteLabel = forward.type === 'remote' ? 'Remote listen' : 'Remote target';
            const remoteHint = forward.type === 'remote'
              ? 'Remote host and port where SSH creates the -R listener.'
              : 'Remote host and port that receives traffic from local -L listener.';

            const localEndpoint = formatEndpoint(forward.localHost || 'localhost', forward.localPort);
            const remoteEndpoint = formatEndpoint(forward.remoteHost || 'localhost', forward.remotePort);
            const canOpenLocalEndpoint =
              forward.type === 'local' && typeof forward.localPort === 'number' && forward.localPort > 0;
            const localEndpointUrl = canOpenLocalEndpoint
              ? `http://${toBrowserHost(forward.localHost)}:${forward.localPort}`
              : '';

            const isForwardOpen = Boolean(expandedForwards[forward.id]);

            const typeLabel = forward.type === 'local' ? "Local (-L)" : forward.type === 'remote' ? "Remote (-R)" : "Dynamic (-D)";

            return (
              <Collapsible
                key={forward.id}
                open={isForwardOpen}
                onOpenChange={(open) => {
                  setExpandedForwards((current) => ({
                    ...current,
                    [forward.id]: open,
                  }));
                }}
                className={`${index > 0 ? 'border-t border-[var(--surface-subtle)]' : ''} py-2`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex items-center gap-2">
                    <CollapsibleTrigger className="flex items-center gap-2 group">
                      <Icon name="arrow-down-s" className={`h-4 w-4 text-muted-foreground transition-transform ${isForwardOpen ? 'rotate-180' : ''}`} />
                      <span className="typography-ui-label text-foreground truncate">{buildForwardLabel(forward)}</span>
                      <span className="typography-micro text-muted-foreground/70 shrink-0">{typeLabel}</span>
                    </CollapsibleTrigger>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={forward.enabled} onCheckedChange={(checked) => updateForward((item) => ({ ...item, enabled: checked }))} aria-label={"Enable forward"} />
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="!font-normal h-6 w-6 px-0 text-[var(--status-error)] hover:text-[var(--status-error)]"
                      onClick={() =>
                        updateDraft((current) => ({
                          ...current,
                          portForwards: current.portForwards.filter((item) => item.id !== forward.id),
                        }))
                      }
                    >
                      <Icon name="delete-bin" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <CollapsibleContent className="pt-2">
                  <div className="space-y-0 pb-2">
                    <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
                      <div className="w-56 shrink-0">
                        <HintLabel
                          label={"Forward type"}
                          hint={(
                            <div className="space-y-1">
                              <p>{"Choose what kind of port access this SSH connection should provide."}</p>
                              <p>{forwardTypeDescription(forward.type)}</p>
                            </div>
                          )}
                        />
                      </div>
                      <Select
                        value={forward.type}
                        onValueChange={(value) =>
                          updateForward((item) => ({
                            ...item,
                            type: (value === 'dynamic' || value === 'remote' ? value : 'local') as DesktopSshPortForwardType,
                          }))
                        }
                      >
                        <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-fit min-w-[140px]">
                          <SelectValue placeholder={"Type"} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="local">{"Local (-L)"}</SelectItem>
                          <SelectItem value="remote">{"Remote (-R)"}</SelectItem>
                          <SelectItem value="dynamic">{"Dynamic (-D)"}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
                      <div className="w-56 shrink-0">
                        <HintLabel label={localLabel} hint={localHint} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Input
                          className="h-7 w-32"
                          value={forward.localHost || '127.0.0.1'}
                          onChange={(event) =>
                            updateForward((item) => ({
                              ...item,
                              localHost: event.target.value,
                            }))
                          }
                          placeholder={"127.0.0.1"}
                        />
                        <span className="text-muted-foreground">:</span>
                        <NumberInput
                          containerClassName="w-fit"
                          min={1}
                          max={65535}
                          step={1}
                          className="w-16 tabular-nums"
                          value={forward.localPort}
                          onValueChange={(next) => {
                            updateForward((item) => ({
                              ...item,
                              localPort: Number.isFinite(next) && next > 0 ? next : undefined,
                            }));
                          }}
                          onClear={() => {
                            updateForward((item) => ({
                              ...item,
                              localPort: undefined,
                            }));
                          }}
                          emptyLabel={"Auto"}
                        />
                      </div>
                    </div>

                    {forward.type !== 'dynamic' ? (
                      <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
                        <div className="w-56 shrink-0">
                          <HintLabel label={remoteLabel} hint={remoteHint} />
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Input
                            className="h-7 w-32"
                            value={forward.remoteHost || ''}
                            onChange={(event) =>
                              updateForward((item) => ({
                                ...item,
                                remoteHost: event.target.value,
                              }))
                            }
                            placeholder={"127.0.0.1"}
                          />
                          <span className="text-muted-foreground">:</span>
                          <NumberInput
                            containerClassName="w-fit"
                            min={1}
                            max={65535}
                            step={1}
                            className="w-16 tabular-nums"
                            value={forward.remotePort}
                            onValueChange={(next) => {
                              updateForward((item) => ({
                                ...item,
                                remotePort: Number.isFinite(next) && next > 0 ? next : undefined,
                              }));
                            }}
                            onClear={() => {
                              updateForward((item) => ({
                                ...item,
                                remotePort: undefined,
                              }));
                            }}
                            emptyLabel={"Auto"}
                          />
                        </div>
                      </div>
                    ) : null}

                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--surface-subtle)] p-2">
                      <div className="flex flex-wrap items-center gap-1 typography-micro text-muted-foreground/80">
                        {forward.type === 'dynamic' ? (
                          <>
                            <Icon name="computer" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{localEndpoint}</span>
                            <span>{"(local SOCKS5)"}</span>
                          </>
                        ) : forward.type === 'remote' ? (
                          <>
                            <Icon name="server" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{remoteEndpoint}</span>
                            <span>{"(remote)"}</span>
                            <Icon name="arrow-right" className="h-3.5 w-3.5" />
                            <Icon name="computer" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{localEndpoint}</span>
                            <span>{"(local)"}</span>
                          </>
                        ) : (
                          <>
                            <Icon name="computer" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{localEndpoint}</span>
                            <span>{"(local)"}</span>
                            <Icon name="arrow-right" className="h-3.5 w-3.5" />
                            <Icon name="server" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{remoteEndpoint}</span>
                            <span>{"(remote)"}</span>
                          </>
                        )}
                      </div>

                      {canOpenLocalEndpoint ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className="!font-normal"
                          onClick={() => {
                            void openExternalUrl(localEndpointUrl).then((opened) => {
                              if (!opened) {
                                toast.error("Failed to open local address");
                              }
                            });
                          }}
                        >
                          <Icon name="external-link" className="h-3.5 w-3.5" />
                          {"Open local"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}

          <Button
            type="button"
            variant="outline"
            size="xs"
            className="!font-normal mt-1"
            onClick={() => {
              const nextForward = makeForward();
              updateDraft((current) => ({
                ...current,
                portForwards: [...current.portForwards, nextForward],
              }));
              setExpandedForwards((current) => ({
                ...current,
                [nextForward.id]: true,
              }));
            }}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
            {"Add forward"}
          </Button>
      </SettingsSection>

      <div className="mt-8 border-t border-[var(--interactive-border)] pt-3">
        <div className="flex items-center gap-2">
          <Button type="button" size="xs" className="!font-normal" onClick={() => void handleSave()} disabled={!hasChanges || isSaving}>
            {"Save Changes"}
          </Button>
          {status?.localUrl ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => {
                  void copyTextToClipboard(status.localUrl || '').then((result) => {
                    if (result.ok) {
                      toast.success("Local URL copied");
                    }
                  });
                }}
              >
                <Icon name="file-copy" className="h-3.5 w-3.5" />
                {"Copy local URL"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => {
                  void handleOpenCurrentInstance();
                }}
              >
                <Icon name="external-link" className="h-3.5 w-3.5" />
                {"Open"}
              </Button>
            </>
          ) : null}
          {error ? <div className="ml-auto typography-meta text-[var(--status-error)]">{error}</div> : null}
        </div>
      </div>

      <Dialog open={logDialogOpen} onOpenChange={setLogDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{"SSH Logs"}</DialogTitle>
            <DialogDescription>
              {draft?.nickname?.trim() || draft?.sshParsed?.destination || draft?.id || "Selected instance"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={handleCopyAllLogs} disabled={logDialogLoading || !logLinesText.trim()}>
              <Icon name="file-copy" className="h-3.5 w-3.5" />
              {"Copy all"}
            </Button>
            <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => void handleClearLogs()} disabled={logDialogLoading}>
              <Icon name="delete-bin" className="h-3.5 w-3.5" />
              {"Clear"}
            </Button>
          </div>
          {logDialogLoading ? (
            <div className="typography-meta text-muted-foreground">{"Loading logs..."}</div>
          ) : logDialogError ? (
            <div className="typography-meta text-[var(--status-error)]">{logDialogError}</div>
          ) : (
            <pre className="max-h-[55vh] overflow-auto rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-3 typography-micro text-foreground whitespace-pre-wrap break-words">
              {logDialogLines.length > 0 ? logDialogLines.join('\n') : "No SSH logs yet."}
            </pre>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(patternHost)}
        onOpenChange={(open) => {
          if (!open) {
            closePatternDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{"Choose an SSH destination"}</DialogTitle>
            <DialogDescription>
              {patternHost
                ? `${patternHost} requires a concrete destination.`
                : "Enter destination."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              handlePatternCreate();
            }}
          >
            <Input
              value={patternDestination}
              onChange={(event) => setPatternDestination(event.target.value)}
              placeholder={"user@host"}
              autoFocus
            />
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={closePatternDialog} disabled={patternCreating}>
                {"Cancel"}
              </Button>
              <Button type="submit" size="xs" className="!font-normal" disabled={patternCreating}>
                {"Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      </DialogContent>
    </Dialog>
  );
};
