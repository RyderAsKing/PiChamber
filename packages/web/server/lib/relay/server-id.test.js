import { describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveServerId } from './signing-key.js';
import { createRelayIdentityRuntime } from './identity.js';
import { createRelayIdentityStore } from './identity-store.js';
import { createServerIdResolver } from './server-id.js';

const makeDataDir = () => mkdtemp(join(tmpdir(), 'pichamber-server-id-'));

const readIdentity = async (dataDir) =>
  JSON.parse(await readFile(join(dataDir, 'relay-identity.json'), 'utf8'));

const readSettings = async (dataDir) =>
  JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));

const generateSigningKey = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateJwk: privateKey.export({ format: 'jwk' }),
    publicJwk: publicKey.export({ format: 'jwk' }),
  };
};

describe('server id resolver', () => {
  it('migrates a legacy settings.json key (same serverId) without touching settings.json', async () => {
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

      // Legacy settings.json is never modified by identity reads.
      const stored = await readSettings(dataDir);
      expect(stored.theme).toBe('dark');
      expect(stored.relaySigningKey).toEqual(relaySigningKey);

      // Same store, same id as the CLI pairing-candidate identity — which
      // persists the migrated key into relay-identity.json on its first write.
      const relayIdentity = await createRelayIdentityRuntime({
        crypto,
        ...createRelayIdentityStore({ dataDir }),
      }).getRelayIdentity();
      expect(relayIdentity.serverId).toBe(serverId);
      expect((await readIdentity(dataDir)).relaySigningKey).toEqual(relaySigningKey);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('generates once on first run and persists the key for later resolvers', async () => {
    const dataDir = await makeDataDir();
    try {
      const id = await createServerIdResolver({ dataDir, crypto }).getServerId();
      expect(typeof id).toBe('string');

      const stored = await readIdentity(dataDir);
      expect(stored.relaySigningKey?.privateJwk).toBeDefined();
      expect(stored.relaySigningKey?.publicJwk).toBeDefined();
      expect(id).toBe(deriveServerId({ crypto }, stored.relaySigningKey.publicJwk));

      // No stray temp files from the atomic write; the identity file is owner-only.
      expect((await readdir(dataDir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
      expect((await stat(join(dataDir, 'relay-identity.json'))).mode & 0o777).toBe(0o600);

      // Identity never touches the portable settings file.
      await expect(readFile(join(dataDir, 'settings.json'), 'utf8')).rejects.toThrow();

      // A second resolver instance reads the persisted key, never regenerates.
      expect(await createServerIdResolver({ dataDir, crypto }).getServerId()).toBe(id);
      expect((await readIdentity(dataDir)).relaySigningKey).toEqual(stored.relaySigningKey);
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

  it('rejects on a corrupt identity file and never overwrites it', async () => {
    const dataDir = await makeDataDir();
    try {
      await writeFile(join(dataDir, 'relay-identity.json'), '{ not json', 'utf8');
      const resolver = createServerIdResolver({ dataDir, crypto });
      await expect(resolver.getServerId()).rejects.toThrow();
      // A retry still rejects (the failure cleared the in-flight promise)
      // and the corrupt file is left untouched — never clobbered with a key.
      await expect(resolver.getServerId()).rejects.toThrow();
      expect(await readFile(join(dataDir, 'relay-identity.json'), 'utf8')).toBe('{ not json');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects on a corrupt legacy settings.json and never overwrites it', async () => {
    const dataDir = await makeDataDir();
    try {
      await writeFile(join(dataDir, 'settings.json'), '{ not json', 'utf8');
      const resolver = createServerIdResolver({ dataDir, crypto });
      await expect(resolver.getServerId()).rejects.toThrow();
      expect(await readFile(join(dataDir, 'settings.json'), 'utf8')).toBe('{ not json');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
