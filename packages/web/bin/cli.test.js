import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer } from 'http';
import net from 'net';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';

import { isModuleCliExecution, normalizeCliEntryPath } from './cli-entry.js';
import { requestJson } from './lib/cli-http.js';
import { inspectTunnelAttachability } from './lib/cli-lifecycle.js';
import { resolveTargetPort } from './lib/cli-api-target.js';
import { DEFAULT_TUNNEL_PROVIDER_CAPABILITIES } from './lib/cli-tunnel-capabilities.js';
import {
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_NGROK,
} from '../server/lib/tunnels/types.js';
import {
  assertAuthenticatedNetworkExposure,
  commands,
  discoverPiChamberInstanceOnPort,
  discoverLifecycleInstances,
  discoverRunningInstances,
  discoverUnconfirmedRegistryInstanceOnPort,
  ensureTunnelProfilesMigrated,
  generateUiPassword,
  getInstanceFilePath,
  getPidFilePath,
  isOpenchamberCmdline,
  isOpenchamberProcessRunning,
  isPiChamberCmdline,
  parseArgs,
  resolveServeHost,
  resolveServeUiPassword,
} from './cli.js';

async function withTempPiChamberDataDir(fn) {
  const previous = process.env.PICHAMBER_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-cli-test-'));
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

function createMockJsonResponse(body, ok = true) {
  return {
    ok,
    json: async () => body,
  };
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

async function startMockPiChamberServer(options = {}) {
  const runtime = options.runtime || 'web';
  const pid = Number.isFinite(options.pid) ? options.pid : null;
  let shutdownRequested = false;
  let closed = false;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/system/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runtime, pid }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/system/shutdown') {
      shutdownRequested = true;
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ ok: true }));
      try {
        server.close(() => {
          closed = true;
        });
      } catch {
        closed = true;
      }
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    get shutdownRequested() {
      return shutdownRequested;
    },
    close: async () => {
      if (closed || !server.listening) return;
      await new Promise((resolve) => {
        try {
          server.close(() => {
            closed = true;
            resolve();
          });
        } catch {
          closed = true;
          resolve();
        }
      });
    },
  };
}

async function allocateLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForTcpPort(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(250, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// Spawn a long-lived child whose argv[1] is a recognized PiChamber source
// entrypoint path so /proc-style cmdline readers can confirm identity. The
// fixture deliberately uses the same entrypoint shape as a source checkout;
// a mere `pichamber` argument is not accepted.
function writePiChamberLikeScript(name, extraCode = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pichamber-cli-fixture-${name}-`));
  const filePath = path.join(
    dir,
    'PiChamber',
    'packages',
    'web',
    name === 'hung' ? 'server' : 'bin',
    name === 'hung' ? 'index.js' : 'cli.js',
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n${extraCode}`);
  fs.chmodSync(filePath, 0o755);
  return { dir, filePath };
}

let idleFixture = null;
function spawnPiChamberLikeIdleProcess() {
  if (!idleFixture) idleFixture = writePiChamberLikeScript('idle');
  const { filePath } = idleFixture;
  const child = spawn(process.execPath, [filePath, 'serve', '--idle'], { stdio: 'ignore' });
  const originalKill = child.kill.bind(child);
  child.kill = (signal) => {
    try { fs.rmSync(idleFixture?.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    idleFixture = null;
    return originalKill(signal);
  };
  return child;
}

let hungFixture = null;
function spawnPiChamberLikeHungServer(port) {
  if (!hungFixture) {
    hungFixture = writePiChamberLikeScript('hung', `
      const net = require('net');
      const sockets = new Set();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      server.listen(${port}, '127.0.0.1');
      setInterval(() => {}, 1000);
    `);
  } else if (hungFixture.dir) {
    // Port may differ across tests; rewrite the listen port on the existing
    // fixture. The script is a no-op until the listen line executes, so a
    // fresh spawn per port keeps the test deterministic.
    try { fs.rmSync(hungFixture.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    hungFixture = writePiChamberLikeScript('hung', `
      const net = require('net');
      const sockets = new Set();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      server.listen(${port}, '127.0.0.1');
      setInterval(() => {}, 1000);
    `);
  }
  const { filePath } = hungFixture;
  const child = spawn(process.execPath, [filePath, 'serve', '--hung'], { stdio: 'ignore' });
  const originalKill = child.kill.bind(child);
  child.kill = (signal) => {
    try { fs.rmSync(hungFixture?.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    hungFixture = null;
    return originalKill(signal);
  };
  return child;
}

describe('cli args', () => {
  it('loads fallback tunnel provider capabilities for CLI startup', () => {
    expect(DEFAULT_TUNNEL_PROVIDER_CAPABILITIES.map((provider) => provider.provider)).toEqual([
      TUNNEL_PROVIDER_CLOUDFLARE,
      TUNNEL_PROVIDER_NGROK,
    ]);
  });

  it('accepts legacy daemon flags as no-ops', () => {
    expect(parseArgs(['serve', '--daemon']).removedFlagErrors).toEqual([]);
    expect(parseArgs(['serve', '-d']).removedFlagErrors).toEqual([]);
  });

  it('parses explicit connect-url server overrides', () => {
    const parsed = parseArgs(['connect-url', '--server', 'https://pichamber.example.com', '--port', '3002']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.server).toBe('https://pichamber.example.com');
    expect(parsed.options.port).toBe(3002);
  });

  it('parses connect-url server-url alias', () => {
    const parsed = parseArgs(['connect-url', '--server-url=http://homebridge:3002']);

    expect(parsed.options.server).toBe('http://homebridge:3002');
  });

  it('parses connect-url --relay flag', () => {
    const parsed = parseArgs(['connect-url', '--relay', '--name', 'My laptop']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.relay).toBe(true);
    expect(parsed.options.name).toBe('My laptop');
  });

  it('parses connect-url api-only help', () => {
    const parsed = parseArgs(['connect-url', '--api-only', '--help']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.helpRequested).toBe(true);
  });

  it('parses startup api-only option', () => {
    const parsed = parseArgs(['startup', 'enable', '--api-only', '--port', '3002']);

    expect(parsed.command).toBe('startup');
    expect(parsed.startupAction).toBe('enable');
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.options.port).toBe(3002);
  });

  it('parses tunnel auto-start server options', () => {
    const parsed = parseArgs(['tunnel', 'start', '--port', '3002', '--api-only', '--lan', '--ui-password', 'secret']);

    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('start');
    expect(parsed.options.port).toBe(3002);
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.options.host).toBe('0.0.0.0');
    expect(parsed.options.uiPassword).toBe('secret');
  });

  it('maps --lan to wildcard bind host', () => {
    const parsed = parseArgs(['serve', '--lan', '--port', '3002']);

    expect(parsed.options.host).toBe('0.0.0.0');
    expect(parsed.options.lan).toBe(true);
  });

  it('supports --hostname as top-level bind alias', () => {
    const parsed = parseArgs(['serve', '--hostname', '0.0.0.0']);

    expect(parsed.options.host).toBe('0.0.0.0');
  });

  it('keeps --hostname for tunnel commands', () => {
    const parsed = parseArgs(['tunnel', 'start', '--hostname', 'app.example.com']);

    expect(parsed.options.hostname).toBe('app.example.com');
    expect(parsed.options.host).toBeUndefined();
  });
});

describe('cli API target resolution', () => {
  it('uses an explicit port without discovery', async () => {
    await expect(resolveTargetPort(
      { explicitPort: true, port: 4567 },
      {
        discoverDesktopInstance: async () => { throw new Error('should not discover desktop'); },
        discoverLifecycleInstances: async () => { throw new Error('should not discover lifecycle'); },
      },
    )).resolves.toBe(4567);
  });

  it('prefers a desktop instance when no port is explicit', async () => {
    await expect(resolveTargetPort({}, {
      discoverDesktopInstance: async () => ({ port: 4500 }),
      discoverLifecycleInstances: async () => [{ port: 3001 }],
      isServerHealthReady: async () => false,
    })).resolves.toBe(4500);
  });

  it('uses the only discovered lifecycle instance', async () => {
    await expect(resolveTargetPort({}, {
      discoverDesktopInstance: async () => null,
      discoverLifecycleInstances: async () => [{ port: 3002 }],
      isServerHealthReady: async () => false,
    })).resolves.toBe(3002);
  });

  it('uses healthy default port when discovery finds no instances', async () => {
    await expect(resolveTargetPort({}, {
      discoverDesktopInstance: async () => null,
      discoverLifecycleInstances: async () => [],
      isServerHealthReady: async (port) => port === 3000,
    })).resolves.toBe(3000);
  });

  it('fails when multiple non-default instances are running', async () => {
    await expect(resolveTargetPort({}, {
      discoverDesktopInstance: async () => null,
      discoverLifecycleInstances: async () => [{ port: 3001 }, { port: 3002 }],
      isServerHealthReady: async () => false,
    })).rejects.toThrow('Multiple PiChamber instances are running');
  });
});

describe('network-exposed auth validation', () => {
  it('allows loopback without a UI password', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '127.0.0.1' })).not.toThrow();
    expect(() => assertAuthenticatedNetworkExposure({ host: 'localhost' })).not.toThrow();
    expect(() => assertAuthenticatedNetworkExposure({ host: '::1' })).not.toThrow();
  });

  it('requires a UI password for LAN and wildcard bind hosts', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0' })).toThrow(/refuses to bind/);
    expect(() => assertAuthenticatedNetworkExposure({ host: '192.168.1.10' })).toThrow(/refuses to bind/);
  });

  it('allows network-exposed bind hosts with a UI password', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0', uiPassword: 'secret' })).not.toThrow();
  });

  it('allows explicit unsafe LAN override from process env only', () => {
    const previous = process.env.PICHAMBER_ALLOW_UNAUTHENTICATED_LAN;
    process.env.PICHAMBER_ALLOW_UNAUTHENTICATED_LAN = 'true';
    try {
      expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0' })).not.toThrow();
    } finally {
      if (typeof previous === 'string') {
        process.env.PICHAMBER_ALLOW_UNAUTHENTICATED_LAN = previous;
      } else {
        delete process.env.PICHAMBER_ALLOW_UNAUTHENTICATED_LAN;
      }
    }
  });
});

describe('serve UI password resolution', () => {
  it('keeps a configured password untouched', () => {
    expect(resolveServeUiPassword({ uiPassword: 'secret', explicitUiPassword: true }))
      .toEqual({ password: 'secret', generated: false });
  });

  it('generates a password for an explicit --ui-password flag without a value', () => {
    const resolved = resolveServeUiPassword({ uiPassword: '', explicitUiPassword: true });
    expect(resolved.generated).toBe(true);
    expect(typeof resolved.password).toBe('string');
    expect(resolved.password.length).toBe(16);
  });

  it('does not generate a password when the flag is absent', () => {
    expect(resolveServeUiPassword({ uiPassword: undefined, explicitUiPassword: false }))
      .toEqual({ password: undefined, generated: false });
  });

  it('generates passwords from an ambiguity-free charset', () => {
    const resolved = resolveServeUiPassword({ uiPassword: '', explicitUiPassword: true });
    expect(resolved.password).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
    expect(resolved.password).not.toMatch(/[0O1Il]/);
  });

  it('generates distinct passwords on repeated calls', () => {
    const a = generateUiPassword();
    const b = generateUiPassword();
    expect(a).not.toBe(b);
  });

  it('parses --ui-password without a value as explicit but empty', () => {
    const parsed = parseArgs(['serve', '--ui-password']);
    expect(parsed.options.explicitUiPassword).toBe(true);
    expect(parsed.options.uiPassword).toBe('');
  });
});

describe('serve host resolution', () => {
  it('uses PICHAMBER_HOST when --host is not provided', () => {
    const previous = process.env.PICHAMBER_HOST;
    process.env.PICHAMBER_HOST = '192.0.2.20';
    try {
      expect(resolveServeHost(undefined)).toBe('192.0.2.20');
    } finally {
      if (typeof previous === 'string') {
        process.env.PICHAMBER_HOST = previous;
      } else {
        delete process.env.PICHAMBER_HOST;
      }
    }
  });

  it('prefers explicit --host over PICHAMBER_HOST', () => {
    const previous = process.env.PICHAMBER_HOST;
    process.env.PICHAMBER_HOST = '192.0.2.20';
    try {
      expect(resolveServeHost('192.0.2.21')).toBe('192.0.2.21');
    } finally {
      if (typeof previous === 'string') {
        process.env.PICHAMBER_HOST = previous;
      } else {
        delete process.env.PICHAMBER_HOST;
      }
    }
  });
});

describe('compatibility exports', () => {
  it('allows tunnel profile migration before command options are initialized', async () => {
    await withTempPiChamberDataDir(async () => {
      const store = ensureTunnelProfilesMigrated();

      expect(store).toEqual({ version: 1, profiles: [] });
    });
  });

  it('includes ngrok in fallback tunnel providers when no server is reachable', async () => {
    await withTempPiChamberDataDir(async () => {
      const port = await allocateLoopbackPort();
      const output = await captureStdout(async () => {
        await commands.tunnel({ json: true, explicitPort: true, port }, 'providers');
      });

      const body = JSON.parse(output);
      expect(body.source).toBe('fallback');
      expect(body.providers.map((entry) => entry.provider)).toContain('ngrok');
    });
  });

  it('supports ngrok quick dry-run with an explicit port', async () => {
    await withTempPiChamberDataDir(async () => {
      const output = await captureStdout(async () => {
        await commands.tunnel({
          json: true,
          dryRun: true,
          explicitPort: true,
          port: 3003,
          provider: 'ngrok',
          mode: 'quick',
        }, 'start');
      });

      const body = JSON.parse(output);
      expect(body).toEqual(expect.objectContaining({
        ok: true,
        dryRun: true,
        provider: 'ngrok',
        mode: 'quick',
      }));
    });
  });
});

describe('CLI HTTP helpers', () => {
  it('retries UI-authenticated API requests with the stored instance password', async () => {
    await withTempPiChamberDataDir(async () => {
      const port = 45678;
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, uiPassword: 'secret' }, null, 2));
      const originalFetch = globalThis.fetch;
      const calls = [];
      globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url).endsWith('/auth/session')) {
          expect(JSON.parse(options.body)).toEqual({ password: 'secret' });
          return {
            ok: true,
            headers: { get: (name) => name.toLowerCase() === 'set-cookie' ? 'oc_ui_session=session-token; Path=/; HttpOnly' : null },
            json: async () => ({ authenticated: true }),
          };
        }
        if (options.headers?.Cookie === 'oc_ui_session=session-token') {
          return createMockJsonResponse({ ok: true });
        }
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'UI authentication required', locked: true }),
        };
      };

      try {
        const { response, body } = await requestJson(port, '/api/pichamber/tunnel/start', {
          method: 'POST',
          body: JSON.stringify({ provider: 'ngrok', mode: 'quick' }),
        });

        expect(response.ok).toBe(true);
        expect(body).toEqual({ ok: true });
        expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
          '/api/pichamber/tunnel/start',
          '/auth/session',
          '/api/pichamber/tunnel/start',
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

});

describe('cli entry detection', () => {
  const modulePath = '/tmp/pichamber/bin/cli.js';
  const moduleUrl = pathToFileURL(modulePath).href;

  it('resolves symlinked entry paths before comparing', () => {
    const symlinkPath = '/usr/local/bin/pichamber';
    const realpath = (filePath) => {
      if (filePath === path.resolve(symlinkPath)) {
        return modulePath;
      }
      return filePath;
    };

    expect(isModuleCliExecution(symlinkPath, moduleUrl, realpath)).toBe(true);
  });

  it('falls back to resolved paths when realpath fails', () => {
    const realpath = () => {
      throw new Error('realpath unavailable');
    };

    expect(isModuleCliExecution(modulePath, moduleUrl, realpath)).toBe(true);
  });

  it('returns false for non-matching entry path', () => {
    expect(isModuleCliExecution('/tmp/other-cli.js', moduleUrl)).toBe(false);
  });

  it('returns false for empty entry path', () => {
    expect(isModuleCliExecution('', moduleUrl)).toBe(false);
  });

  it('returns false when module url is not provided', () => {
    expect(isModuleCliExecution(modulePath)).toBe(false);
  });

  it('accepts wrapper binary name fallback when requested', () => {
    const wrapperPath = '/home/user/.local/bin/pichamber';
    expect(isModuleCliExecution(wrapperPath, moduleUrl, undefined, 'pichamber')).toBe(true);
  });

  it('normalizes direct paths when realpath fails', () => {
    const unresolvedPath = './packages/web/bin/cli.js';
    const realpath = () => {
      throw new Error('no symlink resolution');
    };

    expect(normalizeCliEntryPath(unresolvedPath, realpath)).toBe(path.resolve(unresolvedPath));
  });
});

describe('isPiChamberCmdline (and legacy isOpenchamberCmdline alias)', () => {
  it('accepts PiChamber package entrypoints (Unix + Windows paths)', () => {
    expect(isPiChamberCmdline('node /usr/local/lib/node_modules/@pichamber/web/bin/cli.js serve')).toBe(true);
    expect(isPiChamberCmdline('node /usr/local/lib/node_modules/@pichamber/web/server/index.js --port 9090')).toBe(true);
    // Quoted Windows path with spaces in the install location.
    expect(isPiChamberCmdline('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@pichamber\\web\\server\\index.js" --port 9090')).toBe(true);
    // Direct executable invocation on unix / windows must occupy argv[0].
    expect(isPiChamberCmdline('/usr/local/bin/pichamber serve --port 3000')).toBe(true);
    expect(isPiChamberCmdline('C:\\Users\\u\\AppData\\Roaming\\npm\\pichamber.cmd serve')).toBe(true);
  });

  it('accepts PiChamber source-checkout entrypoints', () => {
    expect(isPiChamberCmdline('bun /home/u/projects/PiChamber/packages/web/bin/cli.js serve')).toBe(true);
    expect(isPiChamberCmdline('node /home/u/projects/PiChamber/packages/web/server/index.js --port 3001')).toBe(true);
  });

  it('rejects recycled and unrelated processes (issue #1721)', () => {
    expect(isPiChamberCmdline('node /home/herjarsa/npm-global/bin/agentmemory')).toBe(false);
    expect(isPiChamberCmdline('node /usr/lib/node_modules/npm/bin/npm-cli.js install')).toBe(false);
    expect(isPiChamberCmdline('vi /tmp/pichamber-notes.md')).toBe(false);
    expect(isPiChamberCmdline('ssh pichamber@example.com')).toBe(false);
    expect(isPiChamberCmdline('node /home/u/.npm-global/lib/node_modules/some-pichamber-helper/index.js')).toBe(false);
    expect(isPiChamberCmdline('/bin/sh -c "echo pichamber"')).toBe(false);
    expect(isPiChamberCmdline('node /tmp/unrelated.js pichamber')).toBe(false);
    expect(isPiChamberCmdline('python task.py --label pichamber')).toBe(false);
    expect(isPiChamberCmdline('node /usr/local/bin/pichamber.cmd serve')).toBe(false);
    expect(isPiChamberCmdline('node ./cli.js serve')).toBe(false);
    expect(isPiChamberCmdline('node ./server/index.js')).toBe(false);
    expect(isPiChamberCmdline('')).toBe(false);
    expect(isPiChamberCmdline(null)).toBe(false);
  });

  it('no longer accepts legacy openchamber-checkout package paths', () => {
    expect(isPiChamberCmdline('bun /home/u/projects/openchamber/packages/web/server/index.js --port 3001')).toBe(false);
    expect(isPiChamberCmdline('node /home/u/.npm-global/lib/node_modules/openchamber/server/index.js')).toBe(false);
  });

  it('keeps the legacy alias compatible with current PiChamber callers', () => {
    expect(isOpenchamberCmdline('node /usr/local/lib/node_modules/@pichamber/web/bin/cli.js serve')).toBe(true);
    expect(isOpenchamberCmdline('node /home/herjarsa/npm-global/bin/agentmemory')).toBe(false);
  });
});

describe('isOpenchamberProcessRunning', () => {
  it('returns false for a dead PID', () => {
    expect(isOpenchamberProcessRunning(2147483646)).toBe(false);
  });

  // Identity verification is available on Linux (/proc) and macOS (ps); on those
  // platforms a live but unrelated process (a recycled stale PID) must read as
  // not-running so it can't trip the "already running" guard (issue #1721).
  it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
    'returns false for a live non-PiChamber PID',
    async () => {
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(isOpenchamberProcessRunning(child.pid)).toBe(false);
      } finally {
        child.kill('SIGKILL');
      }
    }
  );
});

describe('lifecycle instance discovery', () => {
  it('does not attribute a desktop runtime response to a different explicit port', async () => {
    await withTempPiChamberDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123 }, null, 2));

      const instance = await discoverPiChamberInstanceOnPort(3003, {
        fetchImpl: async () => createMockJsonResponse({ runtime: 'desktop', pid: 934 }),
      });

      expect(instance).toBeNull();
    });
  });

  it('attributes a desktop runtime response to its configured desktop port', async () => {
    await withTempPiChamberDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123 }, null, 2));

      const instance = await discoverPiChamberInstanceOnPort(57123, {
        fetchImpl: async () => createMockJsonResponse({ runtime: 'desktop', pid: 934 }),
      });

      expect(instance).toEqual(expect.objectContaining({
        port: 57123,
        pid: 934,
        runtime: 'desktop',
      }));
    });
  });

  it('does not mark tunnel attachability as desktop for a different explicit port', async () => {
    await withTempPiChamberDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123 }, null, 2));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => createMockJsonResponse({ runtime: 'desktop', pid: 934 });
      try {
        const attachability = await inspectTunnelAttachability(3004, { requireHealthy: false });

        expect(attachability.reason).not.toBe('desktop');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it('keeps pid and instance files when live port probe confirms a cmdline mismatch', async () => {
    await withTempPiChamberDataDir(async () => {
      const port = 45123;
      const pid = 12345;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon', startedAt: 123 }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse({ runtime: 'web', pid }),
        getOpenchamberProcessState: () => 'mismatched',
      });

      expect(instances).toEqual([
        expect.objectContaining({ port, pid, runtime: 'web', source: 'registry+probe' }),
      ]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('removes stale pid and instance files when a cmdline mismatch is not confirmed by live probe', async () => {
    await withTempPiChamberDataDir(async () => {
      const port = 45124;
      const pid = 12346;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse(null, false),
        getOpenchamberProcessState: () => 'mismatched',
      });

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(false);
      expect(fs.existsSync(instanceFile)).toBe(false);
    });
  });

  it('preserves matched pid and instance files when the recorded port probe is inconclusive', async () => {
    await withTempPiChamberDataDir(async () => {
      const port = 45126;
      const pid = 12347;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse(null, false),
        getOpenchamberProcessState: () => 'matched',
      });

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('preserves unknown-identity pid and instance files when the recorded port probe is inconclusive', async () => {
    await withTempPiChamberDataDir(async () => {
      const port = 45129;
      const pid = 12350;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse(null, false),
        getOpenchamberProcessState: () => 'unknown',
      });

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('uses the live system-info pid instead of a stale PiChamber-looking pid-file pid', async () => {
    await withTempPiChamberDataDir(async () => {
      const port = 45127;
      const stalePid = 12348;
      const livePid = 54321;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(stalePid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse({ runtime: 'web', pid: livePid }),
        getOpenchamberProcessState: () => 'matched',
      });

      expect(instances).toEqual([
        expect.objectContaining({ port, pid: livePid, runtime: 'web', source: 'registry+probe' }),
      ]);
    });
  });

  it('uses the explicit host when probing a pid-file entry without a stored host', async () => {
    await withTempPiChamberDataDir(async () => {
      const port = 45128;
      const pid = 12349;
      const host = '192.0.2.10';
      const urls = [];
      fs.writeFileSync(await getPidFilePath(port), String(pid));
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port, host },
        {
          fetchImpl: async (url) => {
            urls.push(String(url));
            return createMockJsonResponse({ runtime: 'web', pid });
          },
          getOpenchamberProcessState: () => 'matched',
        },
      );

      expect(instances).toEqual([
        expect.objectContaining({ port, pid, runtime: 'web', source: 'registry+probe' }),
      ]);
      expect(new URL(urls[0]).hostname).toBe(host);
    });
  });

  it('tries loopback before treating an explicit-host pid-file probe as inconclusive', async () => {
    await withTempPiChamberDataDir(async () => {
      const port = 45130;
      const pid = 12351;
      const host = '192.0.2.11';
      const urls = [];
      fs.writeFileSync(await getPidFilePath(port), String(pid));
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port, host },
        {
          fetchImpl: async (url) => {
            urls.push(String(url));
            return new URL(String(url)).hostname === '127.0.0.1'
              ? createMockJsonResponse({ runtime: 'web', pid })
              : createMockJsonResponse(null, false);
          },
          getOpenchamberProcessState: () => 'matched',
        },
      );

      expect(urls.map((url) => new URL(url).hostname)).toContain(host);
      expect(urls.map((url) => new URL(url).hostname)).toContain('127.0.0.1');
      expect(instances).toEqual([
        expect.objectContaining({ port, pid, runtime: 'web', source: 'registry+probe' }),
      ]);
    });
  });

  it('does not accept a fallback loopback probe with a different pid for a concrete host registry', async () => {
    await withTempPiChamberDataDir(async () => {
      const port = 45131;
      const pid = 12352;
      const otherPid = 54322;
      const host = '192.0.2.12';
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, host, launchMode: 'daemon' }, null, 2));

      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port, host },
        {
          fetchImpl: async (url) => {
            return new URL(String(url)).hostname === '127.0.0.1'
              ? createMockJsonResponse({ runtime: 'web', pid: otherPid })
              : createMockJsonResponse(null, false);
          },
          getOpenchamberProcessState: () => 'matched',
        },
      );

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('discovers an explicit live PiChamber port without a pid-file registry entry', async () => {
    await withTempPiChamberDataDir(async () => {
      const port = 45125;
      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port },
        { fetchImpl: async () => createMockJsonResponse({ runtime: 'web', pid: null }) },
      );

      expect(instances).toEqual([
        expect.objectContaining({ port, pid: null, runtime: 'web', source: 'probe' }),
      ]);
    });
  });

  it('cleans a matched pid-file entry without stopping it when the recorded port is free', async () => {
    await withTempPiChamberDataDir(async () => {
      const port = await allocateLoopbackPort();
      const child = spawnPiChamberLikeIdleProcess();
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        fs.writeFileSync(pidFile, String(child.pid));
        fs.writeFileSync(instanceFile, JSON.stringify({ port, host: '127.0.0.1', launchMode: 'daemon' }, null, 2));

        const instance = await discoverUnconfirmedRegistryInstanceOnPort(port, { host: '127.0.0.1' });

        expect(instance).toBeNull();
        expect(fs.existsSync(pidFile)).toBe(false);
        expect(fs.existsSync(instanceFile)).toBe(false);
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill('SIGKILL');
      }
    });
  });
});

describe('lifecycle commands with unmanaged explicit ports', () => {
  it('serve refuses to start on a live PiChamber port without requiring pid files', async () => {
    await withTempPiChamberDataDir(async () => {
      const server = await startMockPiChamberServer();
      try {
        await expect(commands.serve({ explicitPort: true, port: server.port, quiet: true })).rejects.toThrow(
          /already running on port/
        );
      } finally {
        await server.close();
      }
    });
  });

  it('status --port reports a live unmanaged server when the registry is empty', async () => {
    await withTempPiChamberDataDir(async () => {
      const server = await startMockPiChamberServer();
      try {
        const output = await captureStdout(() => commands.status({ explicitPort: true, port: server.port, json: true }));
        const payload = JSON.parse(output);
        expect(payload.state).toBe('running');
        expect(payload.runningCount).toBe(1);
        expect(payload.instances).toEqual([
          expect.objectContaining({ runtime: 'unmanaged', port: server.port, pid: null }),
        ]);
      } finally {
        await server.close();
      }
    });
  });

  it('stop --port reaches unmanaged shutdown when the registry is empty', async () => {
    await withTempPiChamberDataDir(async () => {
      const server = await startMockPiChamberServer();
      try {
        await commands.stop({ explicitPort: true, port: server.port, quiet: true, suppressQuietOutput: true });
        expect(server.shutdownRequested).toBe(true);
      } finally {
        await server.close();
      }
    });
  });

  it('stop --port can recover a matched pid-file instance whose HTTP endpoint is unresponsive', async () => {
    await withTempPiChamberDataDir(async () => {
      const port = await allocateLoopbackPort();
      const child = spawnPiChamberLikeHungServer(port);
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      try {
        expect(await waitForTcpPort(port)).toBe(true);
        fs.writeFileSync(pidFile, String(child.pid));
        fs.writeFileSync(instanceFile, JSON.stringify({ port, host: '127.0.0.1', launchMode: 'daemon' }, null, 2));

        await commands.stop({ explicitPort: true, port, host: '127.0.0.1', quiet: true, suppressQuietOutput: true });

        expect(fs.existsSync(pidFile)).toBe(false);
        expect(fs.existsSync(instanceFile)).toBe(false);
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      } finally {
        child.kill('SIGKILL');
      }
    });
  });

  it('plain stop ignores a stale CLI registry entry that resolves to desktop runtime', async () => {
    await withTempPiChamberDataDir(async () => {
      const server = await startMockPiChamberServer({ runtime: 'desktop' });
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      const pidFile = await getPidFilePath(server.port);
      const instanceFile = await getInstanceFilePath(server.port);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        fs.writeFileSync(pidFile, String(child.pid));
        fs.writeFileSync(instanceFile, JSON.stringify({ port: server.port, launchMode: 'daemon' }, null, 2));

        await commands.stop({ quiet: true, suppressQuietOutput: true });

        expect(server.shutdownRequested).toBe(false);
        expect(fs.existsSync(pidFile)).toBe(false);
        expect(fs.existsSync(instanceFile)).toBe(false);
      } finally {
        child.kill('SIGKILL');
        await server.close();
      }
    });
  });

  it('restart --port restarts a live unmanaged server through the shared explicit-port discovery path', async () => {
    await withTempPiChamberDataDir(async () => {
      const server = await startMockPiChamberServer();
      const calls = [];
      const host = '127.0.0.1';
      try {
        const output = await captureStdout(() => commands.restart.call({
          stop: async (options) => {
            calls.push(['stop', options.port, options.host]);
          },
          serve: async (options) => {
            calls.push(['serve', options.port, options.host]);
            return options.port;
          },
        }, { explicitPort: true, port: server.port, host, json: true }));

        const payload = JSON.parse(output);
        expect(calls).toEqual([
          ['stop', server.port, host],
          ['serve', server.port, host],
        ]);
        expect(payload.restartedCount).toBe(1);
        expect(payload.results).toEqual([
          expect.objectContaining({ fromPort: server.port, toPort: server.port, ok: true }),
        ]);
      } finally {
        await server.close();
      }
    });
  });
});
