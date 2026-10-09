// Host-local relay identity store.
//
// Holds ONLY the two long-lived relay identity keypairs:
// `relaySigningKey` (ECDSA P-256; defines serverId) and `relayEncryptionKey`
// (ECDH P-256; the E2EE trust anchor). Backed by the dedicated host-local file
// `<dataDir>/relay-identity.json` — never `<dataDir>/settings.json`.
//
// settings.json is portable (copied between hosts) and is rewritten by the UI
// settings store on every UI settings write, so host identity keys must not
// live there: a UI save would delete them and the next start would generate a
// new keypair, changing serverId and orphaning every paired device.
//
// Migration: installs whose settings.json still holds a key keep their
// serverId — when relay-identity.json does not exist (ENOENT), reads fall back
// to the two keys in settings.json and copy them into relay-identity.json right
// away, because the next UI settings save rewrites settings.json without them.
// The server resolves its identity at startup so this copy happens before
// anything else touches settings.json. This store never writes to or modifies
// settings.json.

import fs from 'node:fs';
import path from 'node:path';

const IDENTITY_FILE_NAME = 'relay-identity.json';
const SETTINGS_FILE_NAME = 'settings.json';

const pickIdentityKeys = (value) => {
  const picked = {};
  if (value && typeof value === 'object') {
    if (value.relaySigningKey !== undefined) picked.relaySigningKey = value.relaySigningKey;
    if (value.relayEncryptionKey !== undefined) picked.relayEncryptionKey = value.relayEncryptionKey;
  }
  return picked;
};

/**
 * @param {{
 *   dataDir: string,
 *   fsPromises?: Pick<typeof fs.promises, 'readFile' | 'writeFile' | 'mkdir' | 'rename'>,
 * }} deps
 * @returns {{
 *   readSettingsFromDiskMigrated: () => Promise<object>,
 *   writeSettingsToDisk: (settings: object) => Promise<void>,
 *   readSettingsStrict: () => Promise<object>,
 * }}
 */
export const createRelayIdentityStore = ({ dataDir, fsPromises = fs.promises }) => {
  const identityPath = path.join(dataDir, IDENTITY_FILE_NAME);
  const settingsPath = path.join(dataDir, SETTINGS_FILE_NAME);

  // Persists ONLY the two identity keys from the merged settings object the
  // callers pass — nothing else may be persisted here. Atomic (temp file +
  // rename in the same dir) so a crash never leaves a half-written store.
  const writeSettingsToDisk = async (settings) => {
    const serialized = JSON.stringify(pickIdentityKeys(settings), null, 2);
    const tmpPath = `${identityPath}.tmp-${process.pid}`;
    await fsPromises.mkdir(path.dirname(identityPath), { recursive: true });
    await fsPromises.writeFile(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });
    await fsPromises.rename(tmpPath, identityPath);
  };

  // Copies legacy keys found in settings.json into relay-identity.json.
  // Best-effort: on failure the keys are still returned, and the next read
  // retries the copy while settings.json still holds them.
  const adoptLegacyKeys = async (keys) => {
    if (Object.keys(keys).length === 0) return keys;
    try {
      await writeSettingsToDisk(keys);
    } catch {
    }
    return keys;
  };

  // Lenient like the previous settings.json accessor: any read/parse failure
  // maps to `{}`. ENOENT of the identity file falls back to the legacy
  // settings.json keys (migration); nothing else falls back.
  const readSettingsFromDiskMigrated = async () => {
    try {
      return JSON.parse(await fsPromises.readFile(identityPath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') return {};
      let legacy;
      try {
        legacy = pickIdentityKeys(JSON.parse(await fsPromises.readFile(settingsPath, 'utf8')));
      } catch {
        return {};
      }
      return adoptLegacyKeys(legacy);
    }
  };

  // Regeneration gate: ENOENT of relay-identity.json falls back to
  // settings.json (where settings ENOENT means first run → `{}`); any OTHER
  // read error or a JSON parse error of either file THROWS, so a corrupt
  // store is never clobbered with a fresh key (a new key means a new
  // serverId, orphaning every previously paired device).
  const readSettingsStrict = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(identityPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      let settingsRaw;
      try {
        settingsRaw = await fsPromises.readFile(settingsPath, 'utf8');
      } catch (settingsError) {
        if (settingsError?.code === 'ENOENT') return {};
        throw settingsError;
      }
      return adoptLegacyKeys(pickIdentityKeys(JSON.parse(settingsRaw)));
    }
    return JSON.parse(raw);
  };

  return { readSettingsFromDiskMigrated, writeSettingsToDisk, readSettingsStrict };
};
