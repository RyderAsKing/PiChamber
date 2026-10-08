import { describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveServerId } from './signing-key.js';
import { createRelayIdentityRuntime } from './identity.js';
import { createServerIdResolver } from './server-id.js';

const makeDataDir = () => mkdtemp(join(tmpdir(), 'pichamber-server-id-'));

const readSettings = async (dataDir) =>
  JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));

// File-backed accessors mirroring the CLI pair command, for cross-checking
// that the resolver and the relay identity runtime agree on the same file.
const fileBackedAccessors = (dataDir) => {
  const settingsPath = join(dataDir, 'settings.json');
  return {
    readSettingsFromDiskMigrated: async () => {
      try {
        return JSON.parse(await readFile(settingsPath, 'utf8'));
      } catch {
        return {};
      }
    },
    writeSettingsToDisk: async (settings) => {
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    },
  };
};

const generateSigningKey = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateJwk: privateKey.export({ format: 'jwk' }),
    publicJwk: publicKey.export({ format: 'jwk' }),
  };
};

describe('server id resolver', () => {
  it('returns the signing-key serverId for an existing settings file and preserves other keys', async () => {
    const dataDir = await makeDataDir();
    try {
      const relaySigningKey = generateSigningKey();
      await writeFile(
        join(dataDir, 'settings.json'),
        JSON.stringify({ theme: 'dark', relaySigningKey }, null, 2),
        'utf8',
      );

      const serverId = await createServerIdResolver({ dataDir, crypto }).getServerId();
      expect(serverId).toBe(deriveServerId({ crypto }, relaySigningKey.publicJwk));

      const stored = await readSettings(dataDir);
      expect(stored.theme).toBe('dark');
      expect(stored.relaySigningKey).toEqual(relaySigningKey);

      // Same file, same id as the CLI pairing-candidate identity.
      const relayIdentity = await createRelayIdentityRuntime({ crypto, ...fileBackedAccessors(dataDir) }).getRelayIdentity();
      expect(relayIdentity.serverId).toBe(serverId);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('generates once on first run and persists the key for later resolvers', async () => {
    const dataDir = await makeDataDir();
    try {
      const id = await createServerIdResolver({ dataDir, crypto }).getServerId();
      expect(typeof id).toBe('string');

      const stored = await readSettings(dataDir);
      expect(stored.relaySigningKey?.privateJwk).toBeDefined();
      expect(stored.relaySigningKey?.publicJwk).toBeDefined();
      expect(id).toBe(deriveServerId({ crypto }, stored.relaySigningKey.publicJwk));

      // No stray temp files from the atomic write; the settings file is owner-only.
      expect((await readdir(dataDir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
      expect((await stat(join(dataDir, 'settings.json'))).mode & 0o777).toBe(0o600);

      // A second resolver instance reads the persisted key, never regenerates.
      expect(await createServerIdResolver({ dataDir, crypto }).getServerId()).toBe(id);
      expect((await readSettings(dataDir)).relaySigningKey).toEqual(stored.relaySigningKey);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('shares one in-flight generation across concurrent first calls', async () => {
    const dataDir = await makeDataDir();
    try {
      let generations = 0;
      const countingCrypto = {
        ...crypto,
        generateKeyPairSync: (...args) => {
          generations += 1;
          return crypto.generateKeyPairSync(...args);
        },
      };
      const resolver = createServerIdResolver({ dataDir, crypto: countingCrypto });
      const [first, second] = await Promise.all([resolver.getServerId(), resolver.getServerId()]);
      expect(first).toBe(second);
      expect(generations).toBe(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects on a corrupt settings file and never overwrites it', async () => {
    const dataDir = await makeDataDir();
    try {
      await writeFile(join(dataDir, 'settings.json'), '{ not json', 'utf8');
      const resolver = createServerIdResolver({ dataDir, crypto });
      await expect(resolver.getServerId()).rejects.toThrow();
      // A retry still rejects (the failure cleared the in-flight promise)
      // and the corrupt file is left untouched — never clobbered with a key.
      await expect(resolver.getServerId()).rejects.toThrow();
      expect(await readFile(join(dataDir, 'settings.json'), 'utf8')).toBe('{ not json');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
