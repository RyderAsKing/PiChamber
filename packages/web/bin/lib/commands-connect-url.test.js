import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConnectUrlCommand } from './commands-connect-url.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { getInstanceFilePath, readInstanceOptions, writeInstanceOptions } from './cli-process.js';

async function withTempPiChamberDataDir(fn) {
  const previous = process.env.PICHAMBER_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-connect-url-test-'));
  process.env.PICHAMBER_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (typeof previous === 'string') {
      process.env.PICHAMBER_DATA_DIR = previous;
    } else {
      delete process.env.PICHAMBER_DATA_DIR;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk, encoding, callback) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

const withRelayEnv = async (value, fn) => {
  const previous = process.env.PICHAMBER_RELAY_URL;
  if (value === undefined) {
    delete process.env.PICHAMBER_RELAY_URL;
  } else {
    process.env.PICHAMBER_RELAY_URL = value;
  }
  try {
    return await fn();
  } finally {
    if (typeof previous === 'string') {
      process.env.PICHAMBER_RELAY_URL = previous;
    } else {
      delete process.env.PICHAMBER_RELAY_URL;
    }
  }
};

const runConnectUrl = (options) => {
  const command = createConnectUrlCommand({ serveCommand: async () => {} });
  // Loopback bind keeps server-URL resolution local: no LAN detection, no
  // network. The temp data dir has no registry, so the serve mock auto-starts.
  return command({ port: 45671, host: '127.0.0.1', ...options });
};

describe('connect-url relay candidate', () => {
  it('emits a direct-only link without generating relay identity keys when no relay URL is configured', async () => {
    await withTempPiChamberDataDir(async (dir) => {
      await withRelayEnv(undefined, async () => {
        const output = await captureStdout(() => runConnectUrl({ json: true }));
        const body = JSON.parse(output);

        expect(body.candidates).toHaveLength(1);
        expect(body.candidates[0].type).not.toBe('relay');
        // No relay URL configured: identity key generation must not run, so
        // the settings file stays untouched.
        expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false);
      });
    });
  });

  it('fails deterministically when --relay has no relay URL configured', async () => {
    for (const mode of [{}, { json: true }, { quiet: true }]) {
      await withTempPiChamberDataDir(async () => {
        await withRelayEnv(undefined, async () => {
          const error = await runConnectUrl({ relay: true, ...mode }).then(
            () => null,
            (caught) => caught,
          );

          expect(error).toBeInstanceOf(TunnelCliError);
          expect(error.exitCode).toBe(EXIT_CODE.USAGE_ERROR);
          expect(error.message).toContain('PICHAMBER_RELAY_URL');
        });
      });
    }
  });

  it('uses PICHAMBER_RELAY_URL for the relay candidate when set', async () => {
    await withTempPiChamberDataDir(async () => {
      await withRelayEnv('wss://relay.example.test/ws', async () => {
        const output = await captureStdout(() => runConnectUrl({ json: true, relay: true }));
        const body = JSON.parse(output);
        const relay = body.candidates.find((candidate) => candidate.type === 'relay');

        expect(relay).toMatchObject({
          relayUrl: 'wss://relay.example.test/ws',
          priority: 30,
        });
        expect(typeof relay.serverId).toBe('string');
      });
    });
  });

  it('ignores an invalid PICHAMBER_RELAY_URL instead of emitting a relay candidate', async () => {
    await withTempPiChamberDataDir(async () => {
      await withRelayEnv('https://relay.example.test/ws', async () => {
        const output = await captureStdout(() => runConnectUrl({ json: true }));
        const body = JSON.parse(output);

        expect(body.candidates.some((candidate) => candidate.type === 'relay')).toBe(false);
      });
    });
  });
});

const withPublicUrlEnv = async (value, fn) => {
  const previous = process.env.PICHAMBER_PUBLIC_URL;
  if (value === undefined) {
    delete process.env.PICHAMBER_PUBLIC_URL;
  } else {
    process.env.PICHAMBER_PUBLIC_URL = value;
  }
  try {
    return await fn();
  } finally {
    if (typeof previous === 'string') {
      process.env.PICHAMBER_PUBLIC_URL = previous;
    } else {
      delete process.env.PICHAMBER_PUBLIC_URL;
    }
  }
};

describe('pair public URL', () => {
  it('leads with PICHAMBER_PUBLIC_URL and drops the loopback server URL', async () => {
    await withTempPiChamberDataDir(async () => {
      await withRelayEnv(undefined, async () => {
        await withPublicUrlEnv('https://pichamber.example.com', async () => {
          const body = JSON.parse(await captureStdout(() => runConnectUrl({ json: true })));

          expect(body.publicUrl).toBe('https://pichamber.example.com');
          expect(body.candidates).toEqual([
            { type: 'tunnel', url: 'https://pichamber.example.com', priority: 10 },
          ]);
        });
      });
    });
  });

  it('keeps a reachable server URL after the public URL', async () => {
    await withTempPiChamberDataDir(async () => {
      await withRelayEnv(undefined, async () => {
        await withPublicUrlEnv(undefined, async () => {
          const body = JSON.parse(await captureStdout(() => runConnectUrl({
            json: true,
            host: 'http://192.168.1.20:3000',
            publicUrl: 'https://pichamber.example.com',
          })));

          expect(body.candidates).toEqual([
            { type: 'tunnel', url: 'https://pichamber.example.com', priority: 10 },
            { type: 'lan', url: 'http://192.168.1.20:3000', priority: 10 },
          ]);
        });
      });
    });
  });

  it('stores serve --public-url in the instance file and reuses it in pair', async () => {
    await withTempPiChamberDataDir(async () => {
      await withRelayEnv(undefined, async () => {
        await withPublicUrlEnv(undefined, async () => {
          const instanceFilePath = await getInstanceFilePath(45671);
          writeInstanceOptions(instanceFilePath, {
            port: 45671,
            host: '127.0.0.1',
            publicUrl: 'https://pichamber.example.com',
          });
          expect(readInstanceOptions(instanceFilePath).publicUrl).toBe('https://pichamber.example.com');

          const body = JSON.parse(await captureStdout(() => runConnectUrl({ json: true })));
          expect(body.publicUrl).toBe('https://pichamber.example.com');
          expect(body.candidates[0]).toEqual({ type: 'tunnel', url: 'https://pichamber.example.com', priority: 10 });
        });
      });
    });
  });

  it('prefers the running server\'s stored value over PICHAMBER_PUBLIC_URL, as restart does', async () => {
    await withTempPiChamberDataDir(async () => {
      await withRelayEnv(undefined, async () => {
        await withPublicUrlEnv('https://other.example.com', async () => {
          writeInstanceOptions(await getInstanceFilePath(45671), {
            port: 45671,
            host: '127.0.0.1',
            publicUrl: 'https://pichamber.example.com',
          });
          const body = JSON.parse(await captureStdout(() => runConnectUrl({ json: true })));
          expect(body.publicUrl).toBe('https://pichamber.example.com');
        });
      });
    });
  });

  it('lets --server replace every direct address', async () => {
    await withTempPiChamberDataDir(async () => {
      await withRelayEnv(undefined, async () => {
        await withPublicUrlEnv('https://pichamber.example.com', async () => {
          const body = JSON.parse(await captureStdout(() => runConnectUrl({
            json: true,
            server: 'https://other.example.com',
          })));

          expect(body.publicUrl).toBeNull();
          expect(body.candidates).toEqual([
            { type: 'tunnel', url: 'https://other.example.com', priority: 10 },
          ]);
        });
      });
    });
  });

  it('fails as a usage error on an invalid PICHAMBER_PUBLIC_URL in every mode', async () => {
    for (const mode of [{}, { json: true }, { quiet: true }]) {
      await withTempPiChamberDataDir(async () => {
        await withPublicUrlEnv('https://example.com/pichamber', async () => {
          const error = await runConnectUrl(mode).then(() => null, (caught) => caught);

          expect(error).toBeInstanceOf(TunnelCliError);
          expect(error.exitCode).toBe(EXIT_CODE.USAGE_ERROR);
          expect(error.message).toContain('PICHAMBER_PUBLIC_URL');
        });
      });
    }
  });
});
