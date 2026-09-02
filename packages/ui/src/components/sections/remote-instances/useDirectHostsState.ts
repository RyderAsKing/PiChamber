import React from 'react';
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
import {
  desktopPlatformName,
  type HeaderDraft,
  buildRequestHeaders,
  readRequestHeaderDrafts,
  navigateToUrl,
} from './remoteInstanceHelpers';
import {
  parsePairingConnectionPayload,
  type PairingEndpointCandidate,
} from '@/lib/connectionPayload';

export function useDirectHostsState(showInstanceManagement: boolean) {
  const [directHosts, setDirectHosts] = React.useState<DesktopHost[]>([]);
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

  const persistDirectHosts = React.useCallback(
    async (hosts: DesktopHost[], defaultHostId: string | null = directDefaultHostId) => {
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
    },
    [directDefaultHostId],
  );

  const handleAddDirectHost = React.useCallback(async () => {
    const resolved = resolveDesktopHostUrl(directUrl);
    if (!resolved) {
      setDirectError('Invalid URL (must be http/https)');
      return;
    }
    const url = resolved.persistedUrl;
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
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
      setDirectError('Invalid PiChamber connection link.');
      return;
    }
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

    const ordered = [...payload.candidates].sort(
      (a, b) => (a.type === 'relay' ? 1 : 0) - (b.type === 'relay' ? 1 : 0),
    );

    let redeemed:
      | { kind: 'direct'; url: string; token: string }
      | { kind: 'relay'; relay: DesktopHostRelay; token: string }
      | null = null;

    for (const candidate of ordered) {
      if (candidate.type === 'relay') {
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
              relay: {
                relayUrl: candidate.relayUrl,
                serverId: candidate.serverId,
                hostEncPubJwk: candidate.hostEncPubJwk,
              },
              token,
            };
            break;
          }
        } catch {
          // Handshake failed, try next
        } finally {
          tunnel.close();
        }
        continue;
      }
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
        // Unreachable candidate
      }
    }

    if (!redeemed) {
      setDirectError('Invalid URL (must be http/https)');
      return;
    }

    const makeId = (): string =>
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const linkRelayCandidate = payload.candidates.find(
      (candidate): candidate is Extract<PairingEndpointCandidate, { type: 'relay' }> =>
        candidate.type === 'relay',
    );
    const relay: DesktopHostRelay | undefined =
      redeemed.kind === 'relay'
        ? redeemed.relay
        : linkRelayCandidate
          ? {
              relayUrl: linkRelayCandidate.relayUrl,
              serverId: linkRelayCandidate.serverId,
              hostEncPubJwk: linkRelayCandidate.hostEncPubJwk,
            }
          : undefined;
    const firstDirectUrl = payload.candidates
      .filter(
        (candidate): candidate is Extract<PairingEndpointCandidate, { type: 'lan' | 'tunnel' }> =>
          candidate.type !== 'relay',
      )
      .map((candidate) => normalizeHostUrl(candidate.url))
      .find((value): value is string => Boolean(value));
    const directUrlResolved = redeemed.kind === 'direct' ? redeemed.url : firstDirectUrl;
    const { token } = redeemed;

    const url = directUrlResolved || (relay ? relayHostDisplayUrl(relay.serverId) : null);
    if (!url) {
      setDirectError('Invalid URL (must be http/https)');
      return;
    }
    const transportFields = {
      url,
      apiUrl: directUrlResolved || undefined,
      clientToken: token,
      ...(relay ? { relay } : {}),
    };
    const existing = directHosts.find((host) =>
      relay
        ? host.relay?.serverId === relay.serverId
        : !host.relay && normalizeHostUrl(host.apiUrl || host.url) === url,
    );
    if (existing) {
      const nextHosts = directHosts.map((host) =>
        host.id === existing.id
          ? { ...host, label: payload.label || host.label, ...transportFields }
          : host,
      );
      await persistDirectHosts(nextHosts, directDefaultHostId);
    } else {
      await persistDirectHosts(
        [{ id: makeId(), label: payload.label || redactSensitiveUrl(url), ...transportFields }, ...directHosts],
        directDefaultHostId,
      );
    }
    setDirectConnectLink('');
    setDirectError(null);
    setDirectImportDialogOpen(false);
  }, [directConnectLink, directDefaultHostId, directHosts, persistDirectHosts]);

  const handleRemoveDirectHost = React.useCallback(
    async (id: string) => {
      const nextHosts = directHosts.filter((host) => host.id !== id);
      const nextDefault = directDefaultHostId === id ? 'local' : directDefaultHostId;
      await persistDirectHosts(nextHosts, nextDefault);
      if (directEditingId === id) {
        setDirectEditingId(null);
      }
    },
    [directDefaultHostId, directEditingId, directHosts, persistDirectHosts],
  );

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
      setDirectError('Invalid URL (must be http/https)');
      return;
    }
    const url = resolved.persistedUrl;
    const nextHosts = directHosts.map((host) =>
      host.id === directEditingId
        ? {
            ...host,
            label: directEditLabel.trim() || redactSensitiveUrl(url),
            url,
            apiUrl: url,
            clientToken: directEditToken.trim() || undefined,
            requestHeaders: buildRequestHeaders(directEditHeaders),
          }
        : host,
    );
    await persistDirectHosts(nextHosts, directDefaultHostId);
    setDirectEditingId(null);
    if (resolved.redeemUrl) {
      navigateToUrl(resolved.redeemUrl);
    }
  }, [
    directDefaultHostId,
    directEditHeaders,
    directEditLabel,
    directEditToken,
    directEditUrl,
    directEditingId,
    directHosts,
    persistDirectHosts,
  ]);

  const setDefaultDirectHost = React.useCallback(
    async (id: string) => {
      await persistDirectHosts(directHosts, id);
    },
    [directHosts, persistDirectHosts],
  );

  React.useEffect(() => {
    if (!showInstanceManagement || directHosts.length === 0) return;
    let cancelled = false;
    void Promise.all(
      directHosts.map(async (host) => {
        const relayProbe = () =>
          probeRelayDesktopHost(host.relay!, {
            clientToken: host.clientToken || null,
            requestHeaders: host.requestHeaders || null,
          }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
        if (host.relay && !host.apiUrl) {
          return [host.id, await relayProbe()] as const;
        }
        const url = normalizeHostUrl(getDesktopHostApiUrl(host));
        if (!url) {
          return [
            host.id,
            host.relay ? await relayProbe() : ({ status: 'unreachable', latencyMs: 0 } as HostProbeResult),
          ] as const;
        }
        const direct = await desktopHostProbe(url, {
          clientToken: host.clientToken || null,
          requestHeaders: host.requestHeaders || null,
        }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
        if (direct.status === 'unreachable' && host.relay) {
          const relayResult = await relayProbe();
          if (relayResult.status === 'ok') return [host.id, relayResult] as const;
        }
        return [host.id, direct] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setDirectHostStatus(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [directHosts, showInstanceManagement]);

  return {
    directHosts,
    directHostStatus,
    directDefaultHostId,
    directLoading,
    directSaving,
    directLabel,
    setDirectLabel,
    directUrl,
    setDirectUrl,
    directToken,
    setDirectToken,
    directHeaders,
    setDirectHeaders,
    directConnectLink,
    setDirectConnectLink,
    directError,
    directAddDialogOpen,
    setDirectAddDialogOpen,
    directImportDialogOpen,
    setDirectImportDialogOpen,
    directEditingId,
    setDirectEditingId,
    directEditLabel,
    setDirectEditLabel,
    directEditUrl,
    setDirectEditUrl,
    directEditToken,
    setDirectEditToken,
    directEditHeaders,
    setDirectEditHeaders,
    handleAddDirectHost,
    importDirectConnectLink,
    handleRemoveDirectHost,
    beginEditDirectHost,
    saveDirectHostEdit,
    setDefaultDirectHost,
  };
}
