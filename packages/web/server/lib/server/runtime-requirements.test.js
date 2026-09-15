import { describe, expect, it } from 'vitest';

import {
  NO_SUPPORTED_RUNTIME_MESSAGE,
  assertCurrentRuntimeSupported,
  getBunBinary,
  isSupportedBunVersion,
  isSupportedNodeVersion,
  resolveServerExecutable,
} from './runtime-requirements.js';

function fakeSpawnSync({ nodeVersion = null, nodeStatus = 0, bunVersion = '1.4.2', bunStatus = 0 } = {}) {
  return (bin, _args, _options) => {
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

describe('stable version validation', () => {
  it('enforces stable Node >= 22.19.0', () => {
    expect(isSupportedNodeVersion('v22.19.0')).toBe(true);
    expect(isSupportedNodeVersion('22.19.0')).toBe(true);
    expect(isSupportedNodeVersion('v22.19.1')).toBe(true);
    expect(isSupportedNodeVersion('v24.14.1')).toBe(true);
    expect(isSupportedNodeVersion('v22.18.9')).toBe(false);
    expect(isSupportedNodeVersion('v22.14.0')).toBe(false);
    expect(isSupportedNodeVersion('v20.19.0')).toBe(false);
  });

  it('enforces stable Bun >= 1.4.0', () => {
    expect(isSupportedBunVersion('1.4.0')).toBe(true);
    expect(isSupportedBunVersion('1.4.2')).toBe(true);
    expect(isSupportedBunVersion('2.0.0')).toBe(true);
    expect(isSupportedBunVersion('1.3.14')).toBe(false);
  });

  it('rejects malformed, prerelease, and build metadata', () => {
    for (const malformed of [
      '',
      '   ',
      'v22',
      '22.19',
      'latest',
      'not-a-version',
      'v22.19.0-rc.1',
      '1.4.2-canary',
      'v22.19.0+build',
      '1.4.2+meta',
    ]) {
      expect(isSupportedNodeVersion(malformed)).toBe(false);
      expect(isSupportedBunVersion(malformed)).toBe(false);
    }
    for (const nonString of [null, undefined, 42, {}, []]) {
      expect(isSupportedNodeVersion(nonString)).toBe(false);
      expect(isSupportedBunVersion(nonString)).toBe(false);
    }
  });
});

describe('Bun binary resolution', () => {
  it('resolves BUN_BINARY and BUN_INSTALL with precedence', () => {
    expect(getBunBinary({ BUN_BINARY: '/custom/bun' })).toBe('/custom/bun');
    expect(getBunBinary({ BUN_INSTALL: '/home/user/.bun' })).toBe('/home/user/.bun/bin/bun');
    expect(getBunBinary({ BUN_BINARY: '/custom/bun', BUN_INSTALL: '/home/user/.bun' })).toBe('/custom/bun');
    expect(getBunBinary({})).toBe('bun');
  });
});

describe('Node-first automatic resolution', () => {
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

  it('prefers PATH Node when running under Bun', () => {
    const spawnSyncFn = fakeSpawnSync({ nodeVersion: 'v24.14.1', bunVersion: '1.4.2' });
    expect(resolveServerExecutable({
      isBun: true,
      nodeVersion: 'v26.3.0',
      bunVersion: '1.4.2',
      execPath: '/mock/bun',
      bunBin: '/mock/bun',
      spawnSyncFn,
      env: {},
    })).toEqual({ runtime: 'node', executable: 'node' });
  });

  it('falls back to the current Bun executable with no runtimes on PATH', () => {
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

  it('falls back to PATH Bun when not running under Bun', () => {
    const spawnSyncFn = fakeSpawnSync({ nodeVersion: null, bunVersion: '1.4.2' });
    expect(resolveServerExecutable({
      isBun: false,
      nodeVersion: 'v20.19.0',
      execPath: '/usr/bin/node',
      bunBin: '/mock/bun',
      spawnSyncFn,
      env: {},
    })).toEqual({ runtime: 'bun', executable: '/mock/bun' });
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
    })).toThrow(NO_SUPPORTED_RUNTIME_MESSAGE);
  });

  it('rejects old probe output during resolution', () => {
    const spawnSyncFn = fakeSpawnSync({ nodeVersion: 'v20.19.0', bunVersion: null, bunStatus: 1 });
    expect(() => resolveServerExecutable({
      isBun: false,
      nodeVersion: 'v20.19.0',
      execPath: '/usr/bin/node',
      spawnSyncFn,
      env: {},
    })).toThrow(NO_SUPPORTED_RUNTIME_MESSAGE);
  });

  it('bounds Node probe errors to Bun fallback', () => {
    const spawnSyncFn = (bin) => {
      if (String(bin).includes('bun')) return { status: 0, stdout: '1.4.2\n' };
      throw new Error('spawn ENOENT');
    };
    expect(resolveServerExecutable({
      isBun: false,
      nodeVersion: 'v20.19.0',
      execPath: '/usr/bin/node',
      bunBin: '/mock/bun',
      spawnSyncFn,
      env: {},
    })).toEqual({ runtime: 'bun', executable: '/mock/bun' });
  });
});

describe('explicit Bun overrides', () => {
  it('fails instead of falling back when explicit BUN_BINARY is old', () => {
    const spawnSyncFn = fakeSpawnSync({ nodeVersion: null, bunVersion: '1.3.14' });
    expect(() => resolveServerExecutable({
      isBun: true,
      nodeVersion: 'v26.3.0',
      bunVersion: '1.4.2',
      execPath: '/mock/current-bun',
      bunBin: '/mock/old-bun',
      spawnSyncFn,
      env: { BUN_BINARY: '/mock/old-bun' },
    })).toThrow(NO_SUPPORTED_RUNTIME_MESSAGE);
  });

  it('honors a supported explicit BUN_BINARY', () => {
    const spawnSyncFn = fakeSpawnSync({ nodeVersion: null, bunVersion: '1.4.2' });
    expect(resolveServerExecutable({
      isBun: false,
      nodeVersion: 'v20.19.0',
      execPath: '/usr/bin/node',
      bunBin: '/mock/new-bun',
      spawnSyncFn,
      env: { BUN_BINARY: '/mock/new-bun' },
    })).toEqual({ runtime: 'bun', executable: '/mock/new-bun' });
  });
});

describe('old Bun emulating new Node', () => {
  it('rejects old Bun even though emulated Node looks new', () => {
    expect(() => assertCurrentRuntimeSupported({
      isBun: true,
      nodeVersion: 'v26.3.0',
      bunVersion: '1.3.14',
      execPath: '/mock/bun',
    })).toThrow(/Bun 1\.3\.14/);
  });

  it('never reuses the current executable as Node when running under Bun', () => {
    const spawnSyncFn = fakeSpawnSync({ nodeVersion: 'v24.14.1', bunVersion: '1.4.2' });
    expect(resolveServerExecutable({
      isBun: true,
      nodeVersion: 'v26.3.0',
      bunVersion: '1.3.14',
      execPath: '/mock/bun-old',
      bunBin: '/mock/bun',
      spawnSyncFn,
      env: {},
    })).toEqual({ runtime: 'node', executable: 'node' });
  });
});

describe('resolver probe timeout', () => {
  it('passes a bounded timeout to spawnSync', () => {
    const calls = [];
    const spawnSyncFn = (bin, args, options) => {
      calls.push(options);
      return fakeSpawnSync({ nodeVersion: null, bunVersion: '1.4.2' })(bin, args, options);
    };
    resolveServerExecutable({
      isBun: false,
      nodeVersion: 'v20.19.0',
      execPath: '/usr/bin/node',
      bunBin: '/mock/bun',
      spawnSyncFn,
      env: {},
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const options of calls) {
      expect(Number.isFinite(options.timeout)).toBe(true);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.windowsHide).toBe(true);
    }
  });

  it('honors an explicit probe timeout', () => {
    const calls = [];
    const spawnSyncFn = (bin, args, options) => {
      calls.push(options);
      return { status: 1, stdout: '' };
    };
    expect(() => resolveServerExecutable({
      isBun: false,
      nodeVersion: 'v20.19.0',
      execPath: '/usr/bin/node',
      bunBin: '/mock/bun',
      spawnSyncFn,
      env: {},
      probeTimeoutMs: 1234,
    })).toThrow(NO_SUPPORTED_RUNTIME_MESSAGE);
    expect(calls.length).toBeGreaterThan(0);
    for (const options of calls) {
      expect(options.timeout).toBe(1234);
    }
  });
});

describe('current runtime validation without PATH probing', () => {
  it('validates supported Node and Bun executables', () => {
    expect(assertCurrentRuntimeSupported({
      isBun: false,
      nodeVersion: 'v24.14.1',
      execPath: '/usr/bin/node',
    })).toEqual({ runtime: 'node', executable: '/usr/bin/node' });
    expect(assertCurrentRuntimeSupported({
      isBun: true,
      nodeVersion: 'v26.3.0',
      bunVersion: '1.4.2',
      execPath: '/mock/bun',
    })).toEqual({ runtime: 'bun', executable: '/mock/bun' });
  });

  it('rejects old, malformed, and prerelease current runtimes', () => {
    expect(() => assertCurrentRuntimeSupported({
      isBun: false, nodeVersion: 'v20.19.0', execPath: '/usr/bin/node',
    })).toThrow(/Node\.js v20\.19\.0/);
    expect(() => assertCurrentRuntimeSupported({
      isBun: false, nodeVersion: 'not-a-version', execPath: '/usr/bin/node',
    })).toThrow(/Unsupported server runtime/);
    expect(() => assertCurrentRuntimeSupported({
      isBun: false, nodeVersion: 'v22.19.0-rc.1', execPath: '/usr/bin/node',
    })).toThrow(/Unsupported server runtime/);
    expect(() => assertCurrentRuntimeSupported({
      isBun: true, nodeVersion: 'v26.3.0', bunVersion: 'bad', execPath: '/mock/bun',
    })).toThrow(/Unsupported server runtime/);
    expect(() => assertCurrentRuntimeSupported({
      isBun: false, nodeVersion: 'v24.14.1', execPath: '   ',
    })).toThrow(/missing runtime executable/);
  });
});
