// Server-side resolver for the ONE stable server identity (`serverId`).
//
// The identity is the hash of the public relay signing key:
// `deriveServerId({ crypto }, publicJwk)` = base64url(SHA-256(canonical public
// JWK)), from the keypair stored as `settings.relaySigningKey` in
// `<PiChamber data dir>/settings.json` — the same file the CLI
// (`pichamber pair` → `buildRelayPairingCandidate` →
// `createRelayIdentityRuntime(...).getRelayIdentity()`) reads, so the server
// and the CLI always report the same id. It is exposed unauthenticated on
// `/health` and `/api/version` and on
// `GET /api/client-auth/connection/candidates` so clients can verify that a
// learned/probed address belongs to the expected server BEFORE sending a
// bearer token there. The Tailscale probe compares against this same id —
// there is no separate identity file.

import fs from 'node:fs';
import path from 'node:path';

import { deriveServerId, getOrCreateRelaySigningKeypair } from './signing-key.js';

/**
 * @param {{
 *   dataDir: string,
 *   crypto: typeof import('node:crypto'),
 *   fsPromises?: Pick<typeof fs.promises, 'readFile' | 'writeFile' | 'mkdir' | 'rename'>,
 * }} deps
 * @returns {{ getServerId: () => Promise<string> }}
 */
export const createServerIdResolver = ({ dataDir, crypto, fsPromises = fs.promises }) => {
  const settingsPath = path.join(dataDir, 'settings.json');

  // Lenient like the CLI accessor: missing/unreadable → `{}`.
  const readSettingsFromDiskMigrated = async () => {
    try {
      return JSON.parse(await fsPromises.readFile(settingsPath, 'utf8'));
    } catch {
      return {};
    }
  };

  // Regeneration gate: ENOENT → `{}` (first run); any other read error or a
  // JSON parse error THROWS, so a corrupt settings.json is never clobbered
  // with a fresh key (a new key means a new serverId, orphaning every
  // previously paired device).
  const readSettingsStrict = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(settingsPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
    return JSON.parse(raw);
  };

  // Same file the CLI writes, same pretty-print; atomic (temp file + rename
  // in the same dir) so a crash never leaves a half-written settings.json.
  const writeSettingsToDisk = async (settings) => {
    const serialized = JSON.stringify(settings, null, 2);
    const tmpPath = `${settingsPath}.tmp-${process.pid}`;
    await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
    await fsPromises.writeFile(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });
    await fsPromises.rename(tmpPath, settingsPath);
  };

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
