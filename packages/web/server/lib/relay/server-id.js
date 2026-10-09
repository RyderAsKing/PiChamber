// Server-side resolver for the ONE stable server identity (`serverId`).
//
// The identity is the hash of the public relay signing key:
// `deriveServerId({ crypto }, publicJwk)` = base64url(SHA-256(canonical public
// JWK)), from the keypair stored as `relaySigningKey` in the host-local
// `<PiChamber data dir>/relay-identity.json` (see `identity-store.js`) — the
// same store the CLI (`pichamber pair` → `buildRelayPairingCandidate` →
// `createRelayIdentityRuntime(...).getRelayIdentity()`) uses, so the server
// and the CLI always report the same id. It is exposed unauthenticated on
// `/health` and `/api/version` and on
// `GET /api/client-auth/connection/candidates` so clients can verify that a
// learned/probed address belongs to the expected server BEFORE sending a
// bearer token there. The Tailscale probe compares against this same id —
// resolved from `relay-identity.json` via the injected `getServerId`.
// settings.json is portable (copied between hosts) and is rewritten by the
// UI settings store, so it must never hold host identity keys.

import fs from 'node:fs';

import { deriveServerId, getOrCreateRelaySigningKeypair } from './signing-key.js';
import { createRelayIdentityStore } from './identity-store.js';

/**
 * @param {{
 *   dataDir: string,
 *   crypto: typeof import('node:crypto'),
 *   fsPromises?: Pick<typeof fs.promises, 'readFile' | 'writeFile' | 'mkdir' | 'rename'>,
 * }} deps
 * @returns {{ getServerId: () => Promise<string> }}
 */
export const createServerIdResolver = ({ dataDir, crypto, fsPromises = fs.promises }) => {
  // Host-local identity store (relay-identity.json, with settings.json
  // migration fallback) — the same store the CLI pairing command uses.
  const { readSettingsFromDiskMigrated, writeSettingsToDisk, readSettingsStrict } =
    createRelayIdentityStore({ dataDir, fsPromises });

  let cachedServerId = null;
  let inflightServerId = null;

  const getServerId = () => {
    if (cachedServerId) return Promise.resolve(cachedServerId);
    if (inflightServerId) return inflightServerId;
    inflightServerId = (async () => {
      try {
        const { publicJwk } = await getOrCreateRelaySigningKeypair({
          crypto,
          readSettingsFromDiskMigrated,
          writeSettingsToDisk,
          readSettingsStrict,
        });
        cachedServerId = deriveServerId({ crypto }, publicJwk);
        return cachedServerId;
      } catch (error) {
        // Let a later call retry; callers treat a throwing getServerId as "no id".
        inflightServerId = null;
        throw error;
      }
    })();
    return inflightServerId;
  };

  return { getServerId };
};
