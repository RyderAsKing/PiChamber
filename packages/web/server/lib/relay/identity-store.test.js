import { describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveServerId } from './signing-key.js';
import { createRelayIdentityRuntime } from './identity.js';
import { createRelayIdentityStore } from './identity-store.js';
import { createServerIdResolver } from './server-id.js';
import { createPiUiSettingsStore } from '../pi/ui-settings-store.js';

const makeDataDir = () => mkdtemp(join(tmpdir(), 'pichamber-relay-identity-'));

const readIdentity = async (dataDir) =>
  JSON.parse(await readFile(join(dataDir, 'relay-identity.json'), 'utf8'));

const generateSigningKey = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateJwk: privateKey.export({ format: 'jwk' }),
    publicJwk: publicKey.export({ format: 'jwk' }),
  };
};

describe('relay identity store', () => {
  it('round-trips only the two identity keys with mode 0600 and never modifies settings.json', async () => {
    const dataDir = await makeDataDir();
    try {
      const settingsPath = join(dataDir, 'settings.json');
      await writeFile(settingsPath, JSON.stringify({ theme: 'dark', fontSize: 14 }, null, 2), 'utf8');
      const before = await readFile(settingsPath, 'utf8');

      const store = createRelayIdentityStore({ dataDir });
      await store.writeSettingsToDisk({
        theme: 'dark',
        fontSize: 14,
        privateRelay: { enabled: true },
        relaySigningKey: generateSigningKey(),
        relayEncryptionKey: generateSigningKey(),
      });

      const persisted = await readIdentity(dataDir);
      expect(Object.keys(persisted).sort()).toEqual(['relayEncryptionKey', 'relaySigningKey']);
      expect(persisted.relaySigningKey.privateJwk).toBeDefined();
      expect(persisted.relayEncryptionKey.privateJwk).toBeDefined();

      // Atomic write leaves no temp files; the identity file is owner-only.
      expect((await readdir(dataDir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
      expect((await stat(join(dataDir, 'relay-identity.json'))).mode & 0o777).toBe(0o600);

      // settings.json is never written to or modified.
      expect(await readFile(settingsPath, 'utf8')).toBe(before);

      // Lenient + strict reads agree with what was written.
      expect(await store.readSettingsFromDiskMigrated()).toEqual(persisted);
      expect(await store.readSettingsStrict()).toEqual(persisted);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('migrates keys present only in settings.json into relay-identity.json on read', async () => {
    const dataDir = await makeDataDir();
    try {
      const relaySigningKey = generateSigningKey();
      await writeFile(
        join(dataDir, 'settings.json'),
        JSON.stringify({ theme: 'dark', relaySigningKey }, null, 2),
        'utf8',
      );

      const store = createRelayIdentityStore({ dataDir });
      // Lenient read falls back to the legacy keys so serverId is stable.
      const migrated = await store.readSettingsFromDiskMigrated();
      expect(migrated.relaySigningKey).toEqual(relaySigningKey);
      // The fallback copies the key into relay-identity.json right away: the
      // next UI settings save rewrites settings.json without it.
      expect((await readIdentity(dataDir)).relaySigningKey).toEqual(relaySigningKey);
      expect((await stat(join(dataDir, 'relay-identity.json'))).mode & 0o777).toBe(0o600);

      // Strict read sees the same key (no regeneration gate trip).
      expect((await store.readSettingsStrict()).relaySigningKey).toEqual(relaySigningKey);

      // A later write keeps the migrated key alongside the new one.
      await store.writeSettingsToDisk({ ...migrated, relayEncryptionKey: generateSigningKey() });
      const persisted = await readIdentity(dataDir);
      expect(persisted.relaySigningKey).toEqual(relaySigningKey);
      expect(persisted.relayEncryptionKey.privateJwk).toBeDefined();

      // Legacy settings.json still holds its copy; the store never edits it.
      expect(JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')).relaySigningKey)
        .toEqual(relaySigningKey);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('missing everywhere reads lenient {}, corrupt identity file throws strict with no regeneration', async () => {
    const dataDir = await makeDataDir();
    try {
      const store = createRelayIdentityStore({ dataDir });
      // ENOENT of both files: lenient and strict both yield `{}` (first run).
      expect(await store.readSettingsFromDiskMigrated()).toEqual({});
      expect(await store.readSettingsStrict()).toEqual({});

      await writeFile(join(dataDir, 'relay-identity.json'), '{ not json', 'utf8');
      // Lenient maps the corrupt store to `{}`...
      expect(await store.readSettingsFromDiskMigrated()).toEqual({});
      // ...but strict THROWS so callers never regenerate over a corrupt store.
      await expect(store.readSettingsStrict()).rejects.toThrow();
      // Nothing regenerated or clobbered the corrupt file.
      expect(await readFile(join(dataDir, 'relay-identity.json'), 'utf8')).toBe('{ not json');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('REGRESSION: a UI settings write no longer changes serverId; CLI and server resolvers agree', async () => {
    const dataDir = await makeDataDir();
    try {
      const before = await createServerIdResolver({ dataDir, crypto }).getServerId();
      expect(typeof before).toBe('string');

      // Simulate the exact bug: a UI settings save rewrites settings.json.
      const uiStore = createPiUiSettingsStore({ file: join(dataDir, 'settings.json') });
      await uiStore.write({ fontSize: 15 });
      expect(JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')).fontSize).toBe(15);

      // A FRESH resolver (new process) must return the SAME serverId.
      const after = await createServerIdResolver({ dataDir, crypto }).getServerId();
      expect(after).toBe(before);

      // The CLI path (createRelayIdentityRuntime over the identity store)
      // agrees with the server resolver.
      const cliIdentity = await createRelayIdentityRuntime({
        crypto,
        ...createRelayIdentityStore({ dataDir }),
      }).getRelayIdentity();
      expect(cliIdentity.serverId).toBe(before);
      expect(deriveServerId({ crypto }, (await readIdentity(dataDir)).relaySigningKey.publicJwk))
        .toBe(before);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('REGRESSION: an upgraded install keeps its serverId across a UI settings save', async () => {
    const dataDir = await makeDataDir();
    try {
      // Pre-fix layout: the key lives only in an unmarked settings.json.
      const relaySigningKey = generateSigningKey();
      await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ relaySigningKey }, null, 2), 'utf8');
      const legacyId = deriveServerId({ crypto }, relaySigningKey.publicJwk);

      // Server start resolves the identity, which migrates the key.
      expect(await createServerIdResolver({ dataDir, crypto }).getServerId()).toBe(legacyId);

      // The UI settings store rewrites settings.json without the key.
      await createPiUiSettingsStore({ file: join(dataDir, 'settings.json') }).write({ fontSize: 15 });
      expect(JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')).relaySigningKey).toBeUndefined();

      // Next start: same serverId, read from relay-identity.json.
      expect(await createServerIdResolver({ dataDir, crypto }).getServerId()).toBe(legacyId);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
