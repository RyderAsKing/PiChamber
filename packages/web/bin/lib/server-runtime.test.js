import { describe, expect, it } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import {
  NO_SUPPORTED_RUNTIME_MESSAGE,
  findSupportedNodeExecutable,
  getPreferredServerRuntime,
  isSupportedNodeVersion,
  parseNodeMajorVersion,
  resolveServerExecutable,
} from './server-runtime.js';

function fakeSpawnSync({ nodeVersion = null, nodeStatus = 0, bunStatus = 0 } = {}) {
  return (bin) => {
    const normalized = String(bin);
    if (normalized === 'node' || normalized.endsWith('/node') || normalized === '/mock/node') {
      if (nodeVersion === null || nodeStatus !== 0) return { status: 1, stdout: '' };
      return { status: 0, stdout: `${nodeVersion}\n` };
    }
    if (normalized.includes('bun')) {
      return bunStatus === 0 ? { status: 0, stdout: '1.3.14\n' } : { status: 1, stdout: '' };
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

describe('parseNodeMajorVersion', () => {
  it('parses common version shapes', () => {
    expect(parseNodeMajorVersion('v22.14.0')).toBe(22);
    expect(parseNodeMajorVersion('22.1.0')).toBe(22);
    expect(parseNodeMajorVersion('v20.19.0\n')).toBe(20);
    expect(parseNodeMajorVersion('')).toBeNull();
    expect(parseNodeMajorVersion(null)).toBeNull();
  });

  it('accepts Node 22 and newer', () => {
    expect(isSupportedNodeVersion('v22.0.0')).toBe(true);
    expect(isSupportedNodeVersion('v24.14.1')).toBe(true);
    expect(isSupportedNodeVersion('v20.19.0')).toBe(false);
  });
});

describe('getPreferredServerRuntime', () => {
  it('prefers the current Node executable on supported Node', () => {
    const spawnSyncFn = () => {
      throw new Error('should not probe when current Node is supported');
    };
    expect(getPreferredServerRuntime({
      isBun: false,
      nodeVersion: 'v22.14.0',
      execPath: '/usr/bin/node',
      spawnSyncFn,
    })).toBe('node');
    expect(findSupportedNodeExecutable({
      isBun: false,
      nodeVersion: 'v22.14.0',
      execPath: '/usr/bin/node',
      spawnSyncFn,
    })).toBe('/usr/bin/node');
  });

  it('selects PATH Node under a Bun parent when Node is available', () => {
    const spawnSyncFn = fakeSpawnSync({ nodeVersion: 'v22.17.0', bunStatus: 0 });
    expect(getPreferredServerRuntime({
      isBun: true,
      nodeVersion: 'v22.10.0',
      execPath: '/home/user/.bun/bin/bun',
      bunBin: '/home/user/.bun/bin/bun',
      spawnSyncFn,
    })).toBe('node');
    const resolved = resolveServerExecutable({
      isBun: true,
      nodeVersion: 'v22.10.0',
      execPath: '/home/user/.bun/bin/bun',
      bunBin: '/home/user/.bun/bin/bun',
      spawnSyncFn,
    });
    expect(resolved).toEqual({ runtime: 'node', executable: 'node' });
    expect(resolved.executable).not.toContain('bun');
  });

  it('falls back to Bun when Node is missing', () => {
    const spawnSyncFn = fakeSpawnSync({ nodeVersion: null, bunStatus: 0 });
    expect(getPreferredServerRuntime({
      isBun: true,
      execPath: '/home/user/.bun/bin/bun',
      bunBin: '/mock/bun',
      spawnSyncFn,
    })).toBe('bun');
    expect(resolveServerExecutable({
      isBun: true,
      execPath: '/home/user/.bun/bin/bun',
      bunBin: '/mock/bun',
      spawnSyncFn,
    })).toEqual({ runtime: 'bun', executable: '/mock/bun' });
  });

  it('falls back to Bun when Node is older than 22', () => {
    const spawnSyncFn = fakeSpawnSync({ nodeVersion: 'v20.19.0', bunStatus: 0 });
    expect(getPreferredServerRuntime({
      isBun: false,
      nodeVersion: 'v20.19.0',
      execPath: '/usr/bin/node',
      bunBin: 'bun',
      spawnSyncFn,
    })).toBe('bun');
    expect(resolveServerExecutable({
      isBun: false,
      nodeVersion: 'v20.19.0',
      execPath: '/usr/bin/node',
      bunBin: 'bun',
      spawnSyncFn,
    })).toEqual({ runtime: 'bun', executable: 'bun' });
  });

  it('fails deterministically when neither runtime is usable', () => {
    const spawnSyncFn = fakeSpawnSync({ nodeVersion: null, bunStatus: 1 });
    expect(() => getPreferredServerRuntime({
      isBun: false,
      nodeVersion: 'v20.19.0',
      execPath: '/usr/bin/node',
      bunBin: '/mock/bun',
      spawnSyncFn,
    })).toThrow(NO_SUPPORTED_RUNTIME_MESSAGE);
    expect(() => resolveServerExecutable({
      isBun: false,
      nodeVersion: 'v20.19.0',
      execPath: '/usr/bin/node',
      bunBin: '/mock/bun',
      spawnSyncFn,
    })).toThrow(NO_SUPPORTED_RUNTIME_MESSAGE);
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
          throw new Error(NO_SUPPORTED_RUNTIME_MESSAGE);
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
      })).rejects.toThrow(NO_SUPPORTED_RUNTIME_MESSAGE);
    });
  });
});
