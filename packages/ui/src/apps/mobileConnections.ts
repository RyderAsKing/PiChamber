import React from 'react';

import type { PairingConnectionPayload } from '@/lib/connectionPayload';
import { isCapacitorApp } from '@/lib/platform';
import {
  RELAY_CONNECT_TIMEOUT_MS,
  createMobilePasswordOperationTracker,
  mobileClientDedupeKey,
  mobileDevicePlatform,
  type AutoConnectOutcome,
  type CandidateRefreshResult,
  type LiveTransport,
  type MobileConnectInput,
  type MobileFetchResponse,
  type MobilePendingConnection,
  type MobileRelayConfig,
  type MobileSavedConnection,
  type MobileSessionStatus,
  type MobileTransportCandidate,
  type PairingRedeemResponse,
  type ReprobeOutcome,
  type UseMobileConnection,
} from './mobile/mobileConnectionTypes';
import {
  buildCandidatesFromInput,
  candidateSetsMatch,
  connectionDisplayUrl,
  deleteMobileConnection,
  directCandidates,
  getConnectionLabel,
  isSameConnectionUrl,
  loadMobileConnections,
  migrateLegacyInlineTokenRecords,
  normalizeConnectionUrl,
  readConnections,
  readSecureToken,
  relayCandidateOf,
  relayConnectionRuntimeKey,
  secureTokenKeyOf,
  upsertConnectionInList,
  upsertMobileConnection,
  writeConnections,
  writeSecureToken,
} from './mobile/mobileConnectionStorage';
import {
  autoConnectLastInstance,
  establishLiveTransport,
  getAutoConnectTargetLabel,
  isActiveRuntimeConnection,
  logConnect,
  pairingCandidatesToMobile,
  probeConnectionCandidates,
  raceWithTimeout,
  refreshActiveConnectionCandidates,
  reprobeActiveConnection,
  requestWithTimeout,
  switchToTransport,
  validateActiveRuntimeSession,
  validateMobileConnectionSession,
} from './mobile/mobileConnectionTransport';

// Re-export public API
export {
  createMobilePasswordOperationTracker,
  normalizeConnectionUrl,
  getConnectionLabel,
  isSameConnectionUrl,
  relayConnectionRuntimeKey,
  connectionDisplayUrl,
  migrateLegacyInlineTokenRecords,
  loadMobileConnections,
  upsertMobileConnection,
  deleteMobileConnection,
  getAutoConnectTargetLabel,
  autoConnectLastInstance,
  validateMobileConnectionSession,
  validateActiveRuntimeSession,
  isActiveRuntimeConnection,
  reprobeActiveConnection,
  refreshActiveConnectionCandidates,
};

export type {
  MobileRelayConfig,
  MobileTransportCandidate,
  MobileSavedConnection,
  MobilePendingConnection,
  MobileConnectInput,
  AutoConnectOutcome,
  ReprobeOutcome,
  UseMobileConnection,
};

export const useMobileConnection = (onConnected: () => void): UseMobileConnection => {
  const [connections, setConnections] = React.useState<MobileSavedConnection[]>(() =>
    readConnections()
  );
  const [busyOperation, setBusyOperation] = React.useState<
    'connect' | 'password' | 'pairing' | null
  >(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingConnection, setPendingConnection] =
    React.useState<MobilePendingConnection | null>(null);
  const connectionsRef = React.useRef(connections);
  const busyRef = React.useRef<'connect' | 'password' | 'pairing' | null>(null);
  const passwordOperationRef = React.useRef(createMobilePasswordOperationTracker());

  const applyConnections = React.useCallback((next: MobileSavedConnection[]) => {
    connectionsRef.current = next;
    setConnections(next);
  }, []);

  const beginBusy = React.useCallback((operation: 'connect' | 'password' | 'pairing') => {
    busyRef.current = operation;
    setBusyOperation(operation);
  }, []);

  const endBusy = React.useCallback((operation: 'connect' | 'password' | 'pairing') => {
    if (busyRef.current !== operation) return;
    busyRef.current = null;
    setBusyOperation(null);
  }, []);

  // Refresh from storage on mount (runs the legacy-token migration too).
  React.useEffect(() => {
    let disposed = false;
    void loadMobileConnections().then((loaded) => {
      if (!disposed) applyConnections(loaded);
    });
    return () => {
      disposed = true;
    };
  }, [applyConnections]);

  // Persist metadata for a connection and reflect it in state immediately.
  const persistMetadata = React.useCallback(
    (draft: {
      id?: string;
      label: string;
      candidates: MobileTransportCandidate[];
      clientToken?: string;
    }) => {
      const next = upsertConnectionInList(connectionsRef.current, draft);
      applyConnections(next);
      writeConnections(next);
      return next;
    },
    [applyConnections]
  );

  const connect = React.useCallback(
    async (input: MobileConnectInput) => {
      setError(null);
      beginBusy('connect');
      try {
        const candidates = buildCandidatesFromInput(input);
        if (candidates.length === 0) {
          setError('Enter a server URL.');
          return;
        }
        const saved = input.id
          ? connectionsRef.current.find((c) => c.id === input.id)
          : connectionsRef.current.find((c) =>
              candidateSetsMatch(c.candidates, candidates)
            );
        const label =
          input.label?.trim() ||
          saved?.label ||
          getConnectionLabel(connectionDisplayUrl({ candidates }));
        const grant = input.relayGrant;

        // Resolve a token: explicit input wins, otherwise read the saved one.
        let token = input.clientToken?.trim() || undefined;
        const tokenIsNew = Boolean(token);
        if (!token) {
          if (isCapacitorApp()) {
            if (saved?.hasToken)
              token = await readSecureToken(secureTokenKeyOf({ candidates }));
          } else {
            token = saved?.clientToken;
          }
        }

        logConnect('connect:start', {
          candidates: candidates.map((c) => c.kind),
          hasToken: Boolean(token),
        });
        const result = await probeConnectionCandidates(candidates, token);
        logConnect('connect:probe', { status: result.status });

        if (result.status === 'unreachable') {
          setError('Could not reach that PiChamber server.');
          return;
        }
        if (result.status === 'needs-login') {
          persistMetadata({ id: saved?.id, label, candidates });
          setPendingConnection({
            id: saved?.id ?? crypto.randomUUID(),
            label,
            candidates,
            relay: relayCandidateOf({ candidates }) ?? undefined,
            relayGrant: grant,
          });
          return;
        }

        // Connected. Persist a user-supplied token before switching so a cold
        // restart won't re-prompt.
        if (token && tokenIsNew && isCapacitorApp()) {
          await writeSecureToken(secureTokenKeyOf({ candidates }), token);
        }
        persistMetadata({ id: saved?.id, label, candidates, clientToken: token });
        switchToTransport(result.transport, token ?? null, {
          runtimeKey: secureTokenKeyOf({ candidates }),
          grant,
        });
        onConnected();
      } catch (error) {
        console.warn('[mobile-connect] connect threw', error);
        setError('That server URL is not valid.');
      } finally {
        endBusy('connect');
      }
    },
    [beginBusy, endBusy, onConnected, persistMetadata]
  );

  const redeemPairingConnection = React.useCallback(
    async (payload: PairingConnectionPayload) => {
      if (busyRef.current === 'pairing') return;
      setError(null);
      beginBusy('pairing');
      const deviceCandidates = pairingCandidatesToMobile(payload.candidates);
      let chosen: LiveTransport | null = null;
      let adopted = false;
      try {
        chosen = await establishLiveTransport(deviceCandidates);
        if (!chosen) {
          setError('Could not reach that PiChamber server.');
          return;
        }

        const redeemBody = JSON.stringify({
          pairingId: payload.pairingId,
          secret: payload.secret,
          clientLabel: 'PiChamber Mobile',
          clientKind: 'mobile',
          deviceName: 'PiChamber Mobile',
          devicePlatform: mobileDevicePlatform(),
          dedupeKey: mobileClientDedupeKey(),
        });
        const redeemInit = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: redeemBody,
        } as const;
        const response =
          chosen.kind === 'relay'
            ? await raceWithTimeout(
                RELAY_CONNECT_TIMEOUT_MS,
                chosen.tunnel
                  .fetch('/api/client-auth/pairing/redeem', redeemInit)
                  .catch(() => null)
              )
            : await requestWithTimeout(
                `${chosen.url}/api/client-auth/pairing/redeem`,
                redeemInit
              );
        if (!response?.ok) {
          setError('This server needs a password or client token.');
          return;
        }
        const result = (await response.json().catch(() => null)) as
          | PairingRedeemResponse
          | null;
        const issuedToken =
          typeof result?.clientToken === 'string'
            ? result.clientToken.trim()
            : '';
        if (!issuedToken) {
          setError('This server needs a password or client token.');
          return;
        }
        const serverLabel =
          typeof result?.server?.label === 'string' ? result.server.label : '';
        const label =
          payload.label ||
          serverLabel ||
          getConnectionLabel(
            connectionDisplayUrl({ candidates: deviceCandidates })
          );

        if (isCapacitorApp()) {
          const stored = await writeSecureToken(
            secureTokenKeyOf({ candidates: deviceCandidates }),
            issuedToken
          );
          if (!stored) {
            setError('This server needs a password or client token.');
            return;
          }
        }
        persistMetadata({
          label,
          candidates: deviceCandidates,
          clientToken: issuedToken,
        });
        switchToTransport(
          chosen.kind === 'relay'
            ? { kind: 'relay', relay: chosen.relay, tunnel: chosen.tunnel }
            : { kind: 'direct', url: chosen.url },
          issuedToken,
          { runtimeKey: secureTokenKeyOf({ candidates: deviceCandidates }) }
        );
        adopted = chosen.kind === 'relay';
        onConnected();
      } catch (error) {
        console.warn('[mobile-connect] pairing threw', error);
        setError('This server needs a password or client token.');
      } finally {
        if (!adopted && chosen?.kind === 'relay') chosen.tunnel.close();
        endBusy('pairing');
      }
    },
    [beginBusy, endBusy, onConnected, persistMetadata]
  );

  const submitPassword = React.useCallback(
    async (password: string) => {
      if (!pendingConnection || !password.trim() || busyRef.current === 'password')
        return;
      setError(null);
      beginBusy('password');
      const operation = passwordOperationRef.current.begin();
      const isCurrentOperation = () =>
        passwordOperationRef.current.isCurrent(operation);
      const { id, label, candidates } = pendingConnection;
      let chosen: LiveTransport | null = null;
      let adopted = false;
      try {
        chosen = await establishLiveTransport(candidates);
        if (!isCurrentOperation()) return;
        if (!chosen) {
          setError('Could not reach that PiChamber server.');
          return;
        }
        const loginInit = {
          method: 'POST',
          credentials: 'include' as const,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            password,
            trustDevice: true,
            issueClientToken: true,
            clientLabel: 'PiChamber Mobile',
            clientKind: 'mobile',
            devicePlatform: mobileDevicePlatform(),
            dedupeKey: mobileClientDedupeKey(),
          }),
        };
        logConnect('password:start', { transport: chosen.kind });
        const response =
          chosen.kind === 'relay'
            ? await raceWithTimeout(
                RELAY_CONNECT_TIMEOUT_MS,
                chosen.tunnel.fetch('/auth/session', loginInit).catch(() => null)
              )
            : await requestWithTimeout(`${chosen.url}/auth/session`, loginInit);
        if (!isCurrentOperation()) return;
        logConnect('password:done', {
          ok: response?.ok === true,
          status: response?.status ?? null,
        });
        if (!response?.ok) {
          setError('Could not unlock that server. Check the password.');
          return;
        }
        const body = (await response.json().catch(() => null)) as {
          clientToken?: unknown;
        } | null;
        if (!isCurrentOperation()) return;
        const issuedToken =
          typeof body?.clientToken === 'string' ? body.clientToken.trim() : '';
        logConnect('password:token', { issued: Boolean(issuedToken) });

        if (!issuedToken) {
          if (chosen.kind === 'direct' && !isCapacitorApp()) {
            persistMetadata({ id, label, candidates });
            setPendingConnection(null);
            switchToTransport(
              { kind: 'direct', url: chosen.url },
              null,
              { runtimeKey: secureTokenKeyOf({ candidates }) }
            );
            onConnected();
            return;
          }
          setError('This server needs a password or client token.');
          return;
        }

        if (isCapacitorApp()) {
          if (!isCurrentOperation()) return;
          await writeSecureToken(
            secureTokenKeyOf({ candidates }),
            issuedToken
          );
          if (!isCurrentOperation()) return;
        }
        if (!isCurrentOperation()) return;
        persistMetadata({ id, label, candidates, clientToken: issuedToken });
        setPendingConnection(null);
        switchToTransport(
          chosen.kind === 'relay'
            ? { kind: 'relay', relay: chosen.relay, tunnel: chosen.tunnel }
            : { kind: 'direct', url: chosen.url },
          issuedToken,
          { runtimeKey: secureTokenKeyOf({ candidates }) }
        );
        adopted = chosen.kind === 'relay';
        if (!isCurrentOperation()) return;
        onConnected();
      } catch (error) {
        if (!isCurrentOperation()) return;
        console.warn('[mobile-connect] password threw', error);
        setError('Could not unlock that server. Check the password.');
      } finally {
        if (!adopted && chosen?.kind === 'relay') chosen.tunnel.close();
        if (isCurrentOperation()) endBusy('password');
      }
    },
    [beginBusy, endBusy, onConnected, pendingConnection, persistMetadata]
  );

  const cancelPassword = React.useCallback(() => {
    passwordOperationRef.current.cancel();
    endBusy('password');
    setPendingConnection(null);
    setError(null);
  }, [endBusy]);

  const saveConnection = React.useCallback(
    async (input: MobileConnectInput): Promise<MobileSavedConnection | null> => {
      setError(null);
      let candidates = buildCandidatesFromInput(input);
      const existing = input.id
        ? connectionsRef.current.find(
            (connection) => connection.id === input.id
          ) ?? null
        : null;
      if (existing) {
        const inputDirects = candidates.filter(
          (c): c is Extract<MobileTransportCandidate, { kind: 'direct' }> =>
            c.kind === 'direct'
        );
        const preservedHttps = directCandidates(existing).filter(
          (c) =>
            c.url.startsWith('https://') &&
            !inputDirects.some((n) => isSameConnectionUrl(n.url, c.url))
        );
        const relay = relayCandidateOf(existing);
        candidates = [
          ...inputDirects,
          ...preservedHttps,
          ...(relay ? [{ kind: 'relay' as const, relay }] : []),
        ];
      }
      if (candidates.length === 0) {
        setError('Enter a server URL.');
        return null;
      }
      const clientToken = input.clientToken?.trim() || undefined;
      const label =
        input.label?.trim() ||
        getConnectionLabel(connectionDisplayUrl({ candidates }));
      if (isCapacitorApp()) {
        const nextKey = secureTokenKeyOf({ candidates });
        if (clientToken) {
          await writeSecureToken(nextKey, clientToken);
        } else if (existing?.hasToken) {
          const previousKey = secureTokenKeyOf(existing);
          if (previousKey && nextKey && previousKey !== nextKey) {
            const storedToken = await readSecureToken(previousKey);
            if (storedToken) await writeSecureToken(nextKey, storedToken);
          }
        }
      }
      const next = persistMetadata({
        id: input.id,
        label,
        candidates,
        clientToken,
      });
      return (
        next.find((connection) =>
          candidateSetsMatch(connection.candidates, candidates)
        ) ?? null
      );
    },
    [persistMetadata]
  );

  const removeConnection = React.useCallback(
    async (id: string): Promise<MobileSavedConnection | null> => {
      const removed =
        connectionsRef.current.find((connection) => connection.id === id) ??
        null;
      const next = await deleteMobileConnection(id);
      applyConnections(next);
      return removed;
    },
    [applyConnections]
  );

  return {
    connections,
    isBusy: busyOperation !== null,
    isPasswordBusy: busyOperation === 'password',
    error,
    pendingConnection,
    connect,
    redeemPairingConnection,
    submitPassword,
    cancelPassword,
    saveConnection,
    removeConnection,
    setError,
  };
};
