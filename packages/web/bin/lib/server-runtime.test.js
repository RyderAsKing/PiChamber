import { describe, expect, it } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import {
  assertCurrentRuntimeSupported,
  isSupportedNodeVersion,
  resolveServerExecutable,
} from './server-runtime.js';

function fakeSpawnSync({ nodeVersion = null, nodeStatus = 0, bunVersion = '1.4.2', bunStatus = 0 } = {}) {
  return (bin) => {
    const normalized = String(bin);
    if (normalized === 'node' || normalized.endsWith('/node') || normalized === '/mock/node') {
      if (nodeVersion === null || nodeStatus !== 0) return { status: 1, stdout: '' };
      return { status: 0, stdout: `${nodeVersion}\n` };
    }
    if (normalized.includes('bun')) {
      if (bunStatus !== 0 || bunVersion === null) return { status: 1, stdout: '' };
      return { status: 0, stdout: `${bunVersion}\n` };
    }
    return { status: 1, stdout: '' };
  };
}

async function withTempPiChamberDataDir(fn) {
  const previous = process.env.PICHAMBER_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-runtime-test-'));
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

async function allocateLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function createReadyChild(pid, readyPort, delayMs = 10) {
  const handlers = new Map();
  const child = {
    pid,
    connected: true,
    disconnect() {
      child.connected = false;
    },
    unref() {},
    on(event, callback) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(callback);
      return child;
    },
  };
  setTimeout(() => {
    for (const callback of handlers.get('message') || []) {
      callback({ type: 'pichamber:ready', port: readyPort });
    }
  }, delayMs);
  return child;
}

describe('stable version checks', () => {
  it('accepts stable Node 22.19.0 and newer', () => {
    expect(isSupportedNodeVersion('v22.19.0')).toBe(true);
    expect(isSupportedNodeVersion('v22.19.1')).toBe(true);
    expect(isSupportedNodeVersion('v24.14.1')).toBe(true);
    expect(isSupportedNodeVersion('v22.18.9')).toBe(false);
    expect(isSupportedNodeVersion('v22.14.0')).toBe(false);
    expect(isSupportedNodeVersion('v20.19.0')).toBe(false);
  });

  it('rejects malformed and prerelease shapes', () => {
    expect(isSupportedNodeVersion('v22')).toBe(false);
    expect(isSupportedNodeVersion('not-a-version')).toBe(false);
    expect(isSupportedNodeVersion('v22.19.0-rc.1')).toBe(false);
  });
});

describe('background runtime selection', () => {
  it('prefers the current Node executable without probing PATH', () => {
    const spawnSyncFn = () => {
      throw new Error('should not probe when current Node is supported');
    };
    expect(resolveServerExecutable({
      isBun: false,
      nodeVersion: 'v24.14.1',
      execPath: '/usr/bin/node',
      spawnSyncFn,
      env: {},
    })).toEqual({ runtime: 'node', executable: '/usr/bin/node' });
  });

  it('selects PATH Node under a Bun parent when Node is available', () => {
    const spawnSyncFn = fakeSpawnSync({ nodeVersion: 'v22.19.0', bunVersion: '1.4.2', bunStatus: 0 });
    const resolved = resolveServerExecutable({
      isBun: true,
      nodeVersion: 'v26.3.0',
      bunVersion: '1.4.2',
      execPath: '/mock/bun',
      bunBin: '/mock/bun',
      spawnSyncFn,
      env: {},
    });
    expect(resolved).toEqual({ runtime: 'node', executable: 'node' });
    expect(resolved.executable).not.toContain('bun');
  });

  it('falls back to current Bun with no runtimes on PATH', () => {
    const spawnSyncFn = () => ({ status: 1, stdout: '' });
    expect(resolveServerExecutable({
      isBun: true,
      nodeVersion: 'v26.3.0',
      bunVersion: '1.4.2',
      execPath: '/mock/current-bun',
      spawnSyncFn,
      env: {},
    })).toEqual({ runtime: 'bun', executable: '/mock/current-bun' });
  });

  it('falls back to Bun when Node is older than 22.19.0', () => {
    const spawnSyncFn = fakeSpawnSync({ nodeVersion: 'v20.19.0', bunVersion: '1.4.2', bunStatus: 0 });
    expect(resolveServerExecutable({
      isBun: false,
      nodeVersion: 'v20.19.0',
      execPath: '/usr/bin/node',
      bunBin: 'bun',
      spawnSyncFn,
      env: {},
    })).toEqual({ runtime: 'bun', executable: 'bun' });
  });

  it('fails deterministically when neither runtime is usable', () => {
    const spawnSyncFn = fakeSpawnSync({ nodeVersion: null, bunStatus: 1, bunVersion: null });
    expect(() => resolveServerExecutable({
      isBun: false,
      nodeVersion: 'v20.19.0',
      execPath: '/usr/bin/node',
      bunBin: '/mock/bun',
      spawnSyncFn,
      env: {},
    })).toThrow(/No supported server runtime/);
  });

  it('rejects old Bun even when it emulates new Node', () => {
    expect(() => assertCurrentRuntimeSupported({
      isBun: true,
      nodeVersion: 'v26.3.0',
      bunVersion: '1.3.14',
      execPath: '/mock/bun',
    })).toThrow(/Bun 1\.3\.14/);
  });
});

describe('serve executable selection', () => {
  it('spawns the resolved Node executable in background mode', async () => {
    await withTempPiChamberDataDir(async () => {
      const { createServeCommand } = await import('./commands-serve.js');
      const port = await allocateLoopbackPort();
      let spawnedBin = null;
      let spawnedArgs = null;
      const spawnFn = (bin, args) => {
        spawnedBin = bin;
        spawnedArgs = args;
        return createReadyChild(process.pid, port);
      };
      const serve = createServeCommand({
        serverPath: path.join(os.tmpdir(), 'fake-server-index.js'),
        resolveServerExecutable: () => ({ runtime: 'node', executable: '/mock/node' }),
        spawnFn,
        setForegroundServerActive() {},
        setForegroundShutdown() {},
      });
      const result = await serve({
        explicitPort: true,
        port,
        host: '127.0.0.1',
        quiet: true,
        suppressQuietOutput: true,
        suppressUiPasswordWarning: true,
        suppressStartupSummary: true,
      });
      expect(result).toBe(port);
      expect(spawnedBin).toBe('/mock/node');
      expect(spawnedArgs[0]).toContain('fake-server-index.js');
    });
  });

  it('spawns the Bun fallback executable when Node is unavailable', async () => {
    await withTempPiChamberDataDir(async () => {
      const { createServeCommand } = await import('./commands-serve.js');
      const port = await allocateLoopbackPort();
      let spawnedBin = null;
      const spawnFn = (bin) => {
        spawnedBin = bin;
        return createReadyChild(process.pid, port);
      };
      const serve = createServeCommand({
        serverPath: path.join(os.tmpdir(), 'fake-server-index.js'),
        resolveServerExecutable: () => ({ runtime: 'bun', executable: '/mock/bun' }),
        spawnFn,
        setForegroundServerActive() {},
        setForegroundShutdown() {},
      });
      await serve({
        explicitPort: true,
        port,
        host: '127.0.0.1',
        quiet: true,
        suppressQuietOutput: true,
        suppressUiPasswordWarning: true,
        suppressStartupSummary: true,
      });
      expect(spawnedBin).toBe('/mock/bun');
    });
  });

  it('surfaces the deterministic error when neither runtime is usable', async () => {
    await withTempPiChamberDataDir(async () => {
      const { createServeCommand } = await import('./commands-serve.js');
      const port = await allocateLoopbackPort();
      const serve = createServeCommand({
        serverPath: path.join(os.tmpdir(), 'fake-server-index.js'),
        resolveServerExecutable: () => {
          throw new Error('No supported server runtime found. Install Node.js 22.19.0 or newer, or Bun 1.4.0 or newer.');
        },
        spawnFn: () => {
          throw new Error('should not spawn without a runtime');
        },
        setForegroundServerActive() {},
        setForegroundShutdown() {},
      });
      await expect(serve({
        explicitPort: true,
        port,
        host: '127.0.0.1',
        quiet: true,
        suppressQuietOutput: true,
        suppressUiPasswordWarning: true,
        suppressStartupSummary: true,
      })).rejects.toThrow(/No supported server runtime/);
    });
  });
});

describe('foreground current-runtime validation', () => {
  it('rejects unsupported current runtime without probing PATH', async () => {
    await withTempPiChamberDataDir(async () => {
      const { createServeCommand } = await import('./commands-serve.js');
      const port = await allocateLoopbackPort();
      let resolveCalls = 0;
      let spawnCalls = 0;
      const serve = createServeCommand({
        serverPath: path.join(os.tmpdir(), 'fake-server-index.js'),
        resolveServerExecutable: () => {
          resolveCalls += 1;
          throw new Error('foreground must not probe PATH runtimes');
        },
        assertCurrentRuntime: () => {
          throw new Error('Unsupported server runtime: Node.js v20.19.0 is not supported. Install Node.js 22.19.0 or newer, or Bun 1.4.0 or newer.');
        },
        spawnFn: () => {
          spawnCalls += 1;
          throw new Error('foreground must stay inline and never spawn');
        },
        setForegroundServerActive() {},
        setForegroundShutdown() {},
      });
      await expect(serve({
        explicitPort: true,
        port,
        host: '127.0.0.1',
        foreground: true,
        quiet: true,
        suppressQuietOutput: true,
        suppressUiPasswordWarning: true,
        suppressStartupSummary: true,
      })).rejects.toThrow(/Unsupported server runtime/);
      expect(resolveCalls).toBe(0);
      expect(spawnCalls).toBe(0);
    });
  });

  it('validates supported absolute Bun exec without PATH runtimes', () => {
    expect(assertCurrentRuntimeSupported({
      isBun: true,
      nodeVersion: 'v26.3.0',
      bunVersion: '1.4.2',
      execPath: '/mock/current-bun',
    })).toEqual({ runtime: 'bun', executable: '/mock/current-bun' });
  });

  it('rejects old Bun foreground even when emulated Node looks new', () => {
    expect(() => assertCurrentRuntimeSupported({
      isBun: true,
      nodeVersion: 'v26.3.0',
      bunVersion: '1.3.14',
      execPath: '/mock/old-bun',
    })).toThrow(/Bun 1\.3\.14/);
  });
});
