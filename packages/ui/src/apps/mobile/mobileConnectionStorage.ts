import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { isCapacitorApp } from '@/lib/platform';
import {
  MOBILE_CONNECTIONS_LIMIT,
  MOBILE_CONNECTIONS_STORAGE_KEY,
  MOBILE_SECURE_STORAGE_PREFIX,
  MOBILE_SECURE_TIMEOUT_MS,
  type MobileConnectInput,
  type MobileRelayConfig,
  type MobileSavedConnection,
  type MobileTransportCandidate,
} from './mobileConnectionTypes';

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export const normalizeConnectionUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
};

export const getConnectionLabel = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const getConnectionStorageKey = (url: string): string => {
  try {
    return normalizeConnectionUrl(url);
  } catch {
    return url.trim().replace(/\/+$/g, '');
  }
};

export const isSameConnectionUrl = (left: string, right: string): boolean =>
  getConnectionStorageKey(left) === getConnectionStorageKey(right);

// ---------------------------------------------------------------------------
// Relay helpers
// ---------------------------------------------------------------------------

export const relayConnectionRuntimeKey = (relay: MobileRelayConfig): string =>
  `relay:${relay.serverId}@${relay.relayUrl.trim()}`;

export const canonicalRelayUrl = (relay: MobileRelayConfig): string =>
  `relay://${relay.serverId}`;

export const directCandidates = (connection: {
  candidates: MobileTransportCandidate[];
}): Array<{ kind: 'direct'; url: string }> =>
  connection.candidates.filter(
    (c): c is { kind: 'direct'; url: string } => c.kind === 'direct'
  );

export const relayCandidateOf = (connection: {
  candidates: MobileTransportCandidate[];
}): MobileRelayConfig | null => {
  const found = connection.candidates.find((c) => c.kind === 'relay');
  return found && found.kind === 'relay' ? found.relay : null;
};

export const connectionDisplayUrl = (connection: {
  candidates: MobileTransportCandidate[];
}): string => {
  const direct = directCandidates(connection)[0];
  if (direct) return direct.url;
  const relay = relayCandidateOf(connection);
  return relay ? canonicalRelayUrl(relay) : '';
};

export const secureTokenKeyOf = (connection: {
  candidates: MobileTransportCandidate[];
}): string => {
  const relay = relayCandidateOf(connection);
  if (relay) return relayConnectionRuntimeKey(relay);
  const direct = directCandidates(connection)[0];
  return direct ? getConnectionStorageKey(direct.url) : '';
};

export const candidateSetsMatch = (
  a: MobileTransportCandidate[],
  b: MobileTransportCandidate[]
): boolean => {
  const aRelay = a.find((c) => c.kind === 'relay');
  const aServerId = aRelay && aRelay.kind === 'relay' ? aRelay.relay.serverId : null;
  const aUrls = new Set(
    a
      .filter((c) => c.kind === 'direct')
      .map((c) => getConnectionStorageKey((c as { url: string }).url))
  );
  return b.some((c) => {
    if (c.kind === 'relay')
      return aServerId !== null && c.relay.serverId === aServerId;
    return aUrls.has(getConnectionStorageKey(c.url));
  });
};

export const directCandidatesFromUrl = (url: string): MobileTransportCandidate[] => {
  const normalized = (() => {
    try {
      return normalizeConnectionUrl(url);
    } catch {
      return '';
    }
  })();
  return normalized ? [{ kind: 'direct', url: normalized }] : [];
};

export const buildCandidatesFromInput = (
  input: MobileConnectInput
): MobileTransportCandidate[] => {
  if (input.candidates && input.candidates.length > 0) return input.candidates;
  const list: MobileTransportCandidate[] = [];
  if (
    typeof input.url === 'string' &&
    input.url.trim() &&
    !/^relay:\/\//i.test(input.url.trim())
  ) {
    list.push(...directCandidatesFromUrl(input.url));
  }
  if (input.relay) list.push({ kind: 'relay', relay: input.relay });
  return list;
};

export const parseRelayConfig = (value: unknown): MobileRelayConfig | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.relayUrl !== 'string' || !record.relayUrl.trim()) return null;
  if (typeof record.serverId !== 'string' || !record.serverId.trim()) return null;
  const jwk = record.hostEncPubJwk;
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
  const key = jwk as Record<string, unknown>;
  if (key.kty !== 'EC' || key.crv !== 'P-256') return null;
  if (
    typeof key.x !== 'string' ||
    !key.x ||
    typeof key.y !== 'string' ||
    !key.y
  )
    return null;
  return {
    relayUrl: record.relayUrl,
    serverId: record.serverId,
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y },
  };
};

export const parseCandidate = (value: unknown): MobileTransportCandidate | null => {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (c.kind === 'direct') {
    return typeof c.url === 'string' && c.url.trim()
      ? { kind: 'direct', url: c.url }
      : null;
  }
  if (c.kind === 'relay') {
    const relay = parseRelayConfig(c.relay);
    return relay ? { kind: 'relay', relay } : null;
  }
  return null;
};

export const migrateLegacyCandidates = (
  c: Record<string, unknown>
): MobileTransportCandidate[] => {
  if (c.mode === 'relay') {
    const relay = parseRelayConfig(c.relay);
    return relay ? [{ kind: 'relay', relay }] : [];
  }
  return typeof c.url === 'string' ? directCandidatesFromUrl(c.url) : [];
};

export const serializeCandidate = (c: MobileTransportCandidate): unknown =>
  c.kind === 'relay'
    ? {
        kind: 'relay',
        relay: {
          relayUrl: c.relay.relayUrl,
          serverId: c.relay.serverId,
          hostEncPubJwk: c.relay.hostEncPubJwk,
        },
      }
    : { kind: 'direct', url: c.url };

export const readConnections = (): MobileSavedConnection[] => {
  if (typeof window === 'undefined') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      window.localStorage.getItem(MOBILE_CONNECTIONS_STORAGE_KEY) || '[]'
    );
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const native = isCapacitorApp();
  return parsed
    .flatMap((item): MobileSavedConnection[] => {
      if (!item || typeof item !== 'object') return [];
      const c = item as Record<string, unknown>;
      if (typeof c.id !== 'string') return [];
      const candidates = Array.isArray(c.candidates)
        ? c.candidates
            .map(parseCandidate)
            .filter((x): x is MobileTransportCandidate => Boolean(x))
        : migrateLegacyCandidates(c);
      if (candidates.length === 0) return [];
      const inlineToken =
        typeof c.clientToken === 'string' && c.clientToken.trim()
          ? c.clientToken
          : undefined;
      const label =
        typeof c.label === 'string' && c.label.trim()
          ? c.label
          : getConnectionLabel(connectionDisplayUrl({ candidates }));
      const base: MobileSavedConnection = {
        id: c.id,
        label,
        candidates,
        lastUsedAt: typeof c.lastUsedAt === 'number' ? c.lastUsedAt : 0,
      };
      if (native)
        return [
          { ...base, hasToken: Boolean(c.hasToken) || Boolean(inlineToken) },
        ];
      return [
        { ...base, clientToken: inlineToken, hasToken: Boolean(inlineToken) },
      ];
    })
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
};

export const writeConnections = (connections: MobileSavedConnection[]): void => {
  if (typeof window === 'undefined') return;
  const native = isCapacitorApp();
  const serialized = connections.slice(0, MOBILE_CONNECTIONS_LIMIT).map((c) => {
    const shared = {
      id: c.id,
      label: c.label,
      candidates: c.candidates.map(serializeCandidate),
      lastUsedAt: c.lastUsedAt,
    };
    return native
      ? { ...shared, hasToken: Boolean(c.hasToken || c.clientToken) }
      : { ...shared, clientToken: c.clientToken };
  });
  try {
    window.localStorage.setItem(
      MOBILE_CONNECTIONS_STORAGE_KEY,
      JSON.stringify(serialized)
    );
  } catch (error) {
    console.warn('[mobile-storage] failed to persist connection metadata', error);
  }
};

export const upsertConnectionInList = (
  connections: MobileSavedConnection[],
  draft: {
    id?: string;
    label: string;
    candidates: MobileTransportCandidate[];
    clientToken?: string;
    hasToken?: boolean;
  }
): MobileSavedConnection[] => {
  const existing = connections.find(
    (item) =>
      (draft.id && item.id === draft.id) ||
      candidateSetsMatch(item.candidates, draft.candidates)
  );
  const native = isCapacitorApp();
  const next: MobileSavedConnection = {
    id: draft.id || existing?.id || crypto.randomUUID(),
    label: draft.label,
    candidates: draft.candidates,
    lastUsedAt: Date.now(),
    ...(native
      ? {
          hasToken:
            draft.hasToken ??
            (Boolean(draft.clientToken) || existing?.hasToken || false),
        }
      : {
          clientToken: draft.clientToken ?? existing?.clientToken,
          hasToken: Boolean(draft.clientToken ?? existing?.clientToken),
        }),
  };
  return [
    next,
    ...connections.filter(
      (item) =>
        item.id !== next.id &&
        !candidateSetsMatch(item.candidates, draft.candidates)
    ),
  ].slice(0, MOBILE_CONNECTIONS_LIMIT);
};

// ---------------------------------------------------------------------------
// Secure token storage
// ---------------------------------------------------------------------------

type NativeSecureStorage = {
  internalSetItem: (options: {
    prefixedKey: string;
    data: string;
    sync: boolean;
    access: number;
  }) => Promise<void>;
  internalGetItem: (options: {
    prefixedKey: string;
    sync: boolean;
  }) => Promise<{ data: string | null }>;
  internalRemoveItem: (options: {
    prefixedKey: string;
    sync: boolean;
  }) => Promise<{ success: boolean }>;
};

const nativeSecure = SecureStorage as unknown as NativeSecureStorage;
const KEYCHAIN_ACCESS_WHEN_UNLOCKED = 0;

export const prefixedTokenKey = (key: string): string =>
  `${MOBILE_SECURE_STORAGE_PREFIX}token.${encodeURIComponent(key)}`;

const withTimeout = async <T,>(operation: Promise<T>, fallback: T): Promise<T> => {
  let timeoutId: number | undefined;
  const timeout = new Promise<T>((resolve) => {
    timeoutId = window.setTimeout(
      () => resolve(fallback),
      MOBILE_SECURE_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([operation.catch(() => fallback), timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
};

const boundedSecure = async <T,>(
  label: string,
  run: () => Promise<T>,
  fallback: T
): Promise<T> => {
  if (!isCapacitorApp()) return fallback;
  return withTimeout(
    run().catch((error) => {
      console.warn(`[mobile-storage] ${label} failed`, error);
      return fallback;
    }),
    fallback
  );
};

export const readSecureToken = async (key: string): Promise<string | undefined> => {
  const value = await boundedSecure(
    'secure:read',
    async () =>
      (
        await nativeSecure.internalGetItem({
          prefixedKey: prefixedTokenKey(key),
          sync: false,
        })
      ).data,
    null
  );
  return typeof value === 'string' && value.trim() ? value : undefined;
};

export const writeSecureToken = async (
  key: string,
  token: string
): Promise<boolean> => {
  return boundedSecure(
    'secure:write',
    async () => {
      await nativeSecure.internalSetItem({
        prefixedKey: prefixedTokenKey(key),
        data: token,
        sync: false,
        access: KEYCHAIN_ACCESS_WHEN_UNLOCKED,
      });
      return true;
    },
    false
  );
};

export const deleteSecureToken = async (key: string): Promise<void> => {
  await boundedSecure(
    'secure:delete',
    async () => {
      await nativeSecure.internalRemoveItem({
        prefixedKey: prefixedTokenKey(key),
        sync: false,
      });
      return true;
    },
    false
  );
};

export const migrateLegacyInlineTokenRecords = async (
  records: unknown[],
  migrateToken: (url: string, token: string) => Promise<boolean>
): Promise<{ records: unknown[]; migrated: number; failed: number }> => {
  let migrated = 0;
  let failed = 0;
  const next = await Promise.all(
    records.map(async (item) => {
      if (!item || typeof item !== 'object') return item;
      const record = item as Record<string, unknown>;
      const url = typeof record.url === 'string' ? record.url : null;
      const token =
        typeof record.clientToken === 'string' ? record.clientToken.trim() : '';
      if (!url || !token) return item;
      if (!(await migrateToken(url, token))) {
        failed += 1;
        return item;
      }
      migrated += 1;
      const { clientToken: _removed, ...metadata } = record;
      void _removed;
      return { ...metadata, hasToken: true };
    })
  );
  return { records: next, migrated, failed };
};

export const migrateLegacyInlineTokens = async (): Promise<void> => {
  if (typeof window === 'undefined' || !isCapacitorApp()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      window.localStorage.getItem(MOBILE_CONNECTIONS_STORAGE_KEY) || '[]'
    );
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  const legacy = parsed.filter(
    (item): item is { url: string; clientToken: string } =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as { url?: unknown }).url === 'string' &&
      typeof (item as { clientToken?: unknown }).clientToken === 'string' &&
      Boolean((item as { clientToken: string }).clientToken.trim())
  );
  if (legacy.length === 0) return;
  const result = await migrateLegacyInlineTokenRecords(
    parsed,
    async (url, token) => {
      const key = getConnectionStorageKey(url);
      if (!(await writeSecureToken(key, token))) return false;
      return (await readSecureToken(key)) === token;
    }
  );
  if (result.migrated > 0) {
    try {
      window.localStorage.setItem(
        MOBILE_CONNECTIONS_STORAGE_KEY,
        JSON.stringify(result.records)
      );
    } catch (error) {
      console.warn('[mobile-storage] failed to finalize secure token migration', error);
    }
  }
};

export const loadMobileConnections = async (): Promise<MobileSavedConnection[]> => {
  await migrateLegacyInlineTokens();
  return readConnections();
};

export const upsertMobileConnection = async (connection: {
  id?: string;
  label: string;
  candidates: MobileTransportCandidate[];
  clientToken?: string;
}): Promise<MobileSavedConnection[]> => {
  const next = upsertConnectionInList(readConnections(), connection);
  writeConnections(next);
  if (isCapacitorApp() && connection.clientToken) {
    await writeSecureToken(
      secureTokenKeyOf({ candidates: connection.candidates }),
      connection.clientToken
    );
  }
  return next;
};

export const deleteMobileConnection = async (
  id: string
): Promise<MobileSavedConnection[]> => {
  const connections = readConnections();
  const removed = connections.find((connection) => connection.id === id) ?? null;
  const next = connections.filter((connection) => connection.id !== id);
  writeConnections(next);
  if (removed && isCapacitorApp())
    await deleteSecureToken(secureTokenKeyOf(removed));
  return next;
};
