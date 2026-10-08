import { describe, expect, it, vi } from 'vitest';

import {
  buildTailscaleServeArgs,
  buildTailscaleUrl,
  checkTailscaleAuthGate,
  classifyApplyFailure,
  classifyServeMapping,
  conflictMessageForPort,
  extractApprovalUrl,
  findServeMappingForPort,
  isPermissionDeniedOutput,
  normalizeTailscaleConfig,
  parseTailscaleStatus,
  resolveTailscaleExecutable,
  tailscaleCommandForPlatform,
  validateTailscaleConfig,
} from './tailscale.js';
import { createTailscaleService } from './service.js';

describe('tailscale status parsing', () => {
  it('strips the trailing dot from DNSName and reports login state', () => {
    expect(parseTailscaleStatus(JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: 'machine.tail123.ts.net.', TailscaleIPs: ['100.64.0.1'] },
      CertDomains: ['machine.tail123.ts.net'],
    }))).toEqual({
      running: true,
      loggedIn: true,
      magicDnsName: 'machine.tail123.ts.net',
      httpsCertsAvailable: true,
    });
  });

  it('reports logged out when Self is missing', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'NoState' }))).toEqual({
      running: false,
      loggedIn: false,
      magicDnsName: null,
      httpsCertsAvailable: null,
    });
  });

  it('reports unknown cert availability when CertDomains is absent', () => {
    const parsed = parseTailscaleStatus(JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: 'machine.tail123.ts.net.' },
    }));
    expect(parsed.loggedIn).toBe(true);
    expect(parsed.httpsCertsAvailable).toBeNull();
  });

  it('never throws on malformed JSON', () => {
    expect(parseTailscaleStatus('not json{{{')).toEqual({
      running: false,
      loggedIn: false,
      magicDnsName: null,
      httpsCertsAvailable: null,
    });
  });
});

describe('executable resolution', () => {
  it('uses tailscale on posix and tailscale.exe on Windows', () => {
    expect(tailscaleCommandForPlatform('darwin')).toBe('tailscale');
    expect(tailscaleCommandForPlatform('linux')).toBe('tailscale');
    expect(tailscaleCommandForPlatform('win32')).toBe('tailscale.exe');
  });

  it('falls back to the macOS app bundle location', () => {
    const resolved = resolveTailscaleExecutable({ platform: 'darwin', existsSync: () => false });
    expect(resolved.command).toBe('tailscale');
    expect(resolved.fallback).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    const bundled = resolveTailscaleExecutable({
      platform: 'darwin',
      existsSync: (candidate) => candidate === '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    });
    expect(bundled.command).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  });

  it('falls back to Program Files on Windows', () => {
    const resolved = resolveTailscaleExecutable({ platform: 'win32', env: {}, existsSync: () => false });
    expect(resolved.command).toBe('tailscale.exe');
    expect(resolved.fallback).toContain('Tailscale');
  });
});

describe('config validation', () => {
  it('accepts partial updates and normalizes defaults', () => {
    expect(validateTailscaleConfig({ enabled: true, mode: 'public', httpsPort: 8443 })).toEqual({ ok: true, errors: [] });
    expect(normalizeTailscaleConfig(null)).toEqual({ enabled: false, mode: 'private', httpsPort: 443 });
    expect(normalizeTailscaleConfig({ enabled: true })).toEqual({ enabled: true, mode: 'private', httpsPort: 443 });
  });

  it('rejects bad mode, port and enabled values', () => {
    expect(validateTailscaleConfig({ mode: 'funnel' }).ok).toBe(false);
    expect(validateTailscaleConfig({ httpsPort: 3000 }).ok).toBe(false);
    expect(validateTailscaleConfig({ httpsPort: '443' }).ok).toBe(false);
    expect(validateTailscaleConfig({ enabled: 'yes' }).ok).toBe(false);
  });
});

describe('auth gate', () => {
  it('allows anything while disabled', () => {
    expect(checkTailscaleAuthGate({ enabled: false, mode: 'public', uiPasswordConfigured: false }).allowed).toBe(true);
  });

  it('requires UI auth for private mode without the escape hatch', () => {
    const blocked = checkTailscaleAuthGate({ enabled: true, mode: 'private', uiPasswordConfigured: false, unsafeUnauthenticatedLanAllowed: false });
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('auth_required');
  });

  it('honors the escape hatch for private mode', () => {
    expect(checkTailscaleAuthGate({ enabled: true, mode: 'private', uiPasswordConfigured: false, unsafeUnauthenticatedLanAllowed: true }).allowed).toBe(true);
  });

  it('never honors the escape hatch for public mode', () => {
    const blocked = checkTailscaleAuthGate({ enabled: true, mode: 'public', uiPasswordConfigured: false, unsafeUnauthenticatedLanAllowed: true });
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('auth_required');
  });

  it('allows both modes with a UI password', () => {
    for (const mode of ['private', 'public']) {
      expect(checkTailscaleAuthGate({ enabled: true, mode, uiPasswordConfigured: true }).allowed).toBe(true);
    }
  });
});

describe('serve status conflict detection', () => {
  const serveStatus = {
    TCP: { 443: { HTTPS: true } },
    Web: {
      'machine.tail123.ts.net:443': {
        Handlers: { '/': 'http://127.0.0.1:3000/' },
      },
      'machine.tail123.ts.net:8443': {
        Handlers: { '/': 'http://127.0.0.1:9999' },
      },
    },
  };

  it('finds mappings keyed by <host>:<port>', () => {
    expect(findServeMappingForPort(serveStatus, 443)?.key).toBe('machine.tail123.ts.net:443');
    expect(findServeMappingForPort(serveStatus, 10000)).toBeNull();
  });

  it('recognizes our own mapping', () => {
    const mapping = findServeMappingForPort(serveStatus, 443);
    expect(classifyServeMapping({ mapping, httpsPort: 443, boundPort: 3000 }).kind).toBe('ours');
  });

  it('flags a foreign mapping as conflict-worthy', () => {
    const mapping = findServeMappingForPort(serveStatus, 8443);
    const classification = classifyServeMapping({ mapping, httpsPort: 8443, boundPort: 3000 });
    expect(classification.kind).toBe('foreign');
    expect(conflictMessageForPort(8443)).toContain('8443');
    expect(conflictMessageForPort(8443)).not.toContain('8443 or 8443');
  });

  it('treats absent mappings as free', () => {
    expect(classifyServeMapping({ mapping: null, httpsPort: 10000, boundPort: 3000 }).kind).toBe('absent');
  });
});

describe('approval and permission detection', () => {
  it('extracts the login approval URL from streamed output', () => {
    expect(extractApprovalUrl('visit https://login.tailscale.com/f/serve?node=abc123 to approve\nwaiting...'))
      .toBe('https://login.tailscale.com/f/serve?node=abc123');
    expect(extractApprovalUrl('visit https://login.tailscale.com/f/funnel?node=xyz to enable funnel.'))
      .toBe('https://login.tailscale.com/f/funnel?node=xyz');
    expect(extractApprovalUrl('all good, no url here')).toBeNull();
  });

  it('detects Linux operator permission errors', () => {
    expect(isPermissionDeniedOutput('Error: access denied: serve config denied')).toBe(true);
    expect(isPermissionDeniedOutput('failed: must be root or operator')).toBe(true);
    expect(isPermissionDeniedOutput('some other failure')).toBe(false);
    expect(classifyApplyFailure('Error: access denied').code).toBe('permission_denied');
    expect(classifyApplyFailure('tailscale is not logged in').code).toBe('not_logged_in');
    expect(classifyApplyFailure('visit https://login.tailscale.com/f/serve?node=x').code).toBe('needs_approval');
    expect(classifyApplyFailure('weird unknown boom')).toBeNull();
  });

  it('builds serve args and public URLs', () => {
    expect(buildTailscaleServeArgs({ mode: 'private', httpsPort: 443, localPort: 3000 }))
      .toEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:3000']);
    expect(buildTailscaleServeArgs({ mode: 'public', httpsPort: 8443, localPort: 3000 })[0]).toBe('funnel');
    expect(buildTailscaleUrl({ magicDnsName: 'm.ts.net', httpsPort: 443 })).toBe('https://m.ts.net');
    expect(buildTailscaleUrl({ magicDnsName: 'm.ts.net', httpsPort: 10000 })).toBe('https://m.ts.net:10000');
  });
});

const STATUS_JSON = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'mymachine.tailabc.ts.net.' },
  CertDomains: ['mymachine.tailabc.ts.net'],
});

/** In-memory fs + scripted command runner for lifecycle tests. */
const createHarness = ({ handlers, port = 3000, uiPassword = 'secret' } = {}) => {
  const files = new Map();
  const calls = [];
  const fsPromises = {
    readFile: async (filePath) => {
      if (!files.has(filePath)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(filePath);
    },
    writeFile: async (filePath, content) => {
      files.set(filePath, String(content));
    },
    mkdir: async () => {},
    rename: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlink: async (filePath) => {
      if (!files.delete(filePath)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
    },
  };
  const runner = {
    runTailscale: async (args, { onOutput } = {}) => {
      calls.push(args);
      const handler = handlers[args.slice(1).join(' ')] || handlers['*'];
      const result = typeof handler === 'function' ? await handler(args, onOutput) : handler;
      if (result?.stream) {
        for (const chunk of result.stream) onOutput?.(chunk);
      }
      return result || { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
    },
  };
  const service = createTailscaleService({
    dataDir: '/data',
    getPort: () => port,
    isUiAuthEnabled: () => uiPassword !== null,
    isUnsafeUnauthenticatedLanAllowed: () => false,
    runner,
    fsPromises,
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
    logWarn: () => {},
  });
  return { service, calls, files, fsPromises };
};

describe('status auth gate', () => {
  it('reports per-mode auth-gate flags on the status model', async () => {
    const { service } = createHarness({ uiPassword: null });
    await service.loadConfig();
    const blocked = service.getStatus();
    expect(blocked.authGate).toEqual({ privateAllowed: false, publicAllowed: false });
    service.dispose();
  });

  it('honors the LAN escape hatch for private only', async () => {
    const fsPromises = {
      readFile: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; },
      writeFile: async () => {},
      mkdir: async () => {},
      rename: async () => {},
      unlink: async () => {},
    };
    const service = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => false,
      isUnsafeUnauthenticatedLanAllowed: () => true,
      runner: { runTailscale: async () => ({ ok: true, code: 0, stdout: '{}', stderr: '', spawnError: null, timedOut: false }) },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    expect(service.getStatus().authGate).toEqual({ privateAllowed: true, publicAllowed: false });
    service.dispose();
  });
});

describe('tailscale service lifecycle', () => {
  it('applies on start and probes to active', async () => {
    const { service, calls } = createHarness({
      handlers: {
        'status --json': { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false },
        'serve status --json': { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false },
      },
    });
    service.fetchImpl = undefined;
    const probing = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          calls.push(args);
          if (args.includes('status') && args.includes('--json') && !args.includes('serve')) {
            return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises: {
        readFile: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; },
        writeFile: async () => {},
        mkdir: async () => {},
        rename: async () => {},
        unlink: async () => {},
      },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ serverId: await probing.getServerId() }) }),
      logWarn: () => {},
    });
    await probing.loadConfig();
    const result = await probing.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(result.state).toBe('active');
    expect(result.url).toBe('https://mymachine.tailabc.ts.net');
    expect(calls.some((args) => args.includes('serve') && args.includes('--bg'))).toBe(true);
    expect(probing.getPairingCandidate()).toEqual({ type: 'tailscale', url: 'https://mymachine.tailabc.ts.net', mode: 'private', priority: 20 });
    probing.dispose();
    expect(service).toBeDefined();
  });

  it('reports conflict instead of overwriting a foreign mapping', async () => {
    const memFs = new Map();
    const fsPromises = {
      readFile: async (p) => {
        if (!memFs.has(p)) {
          const e = new Error('x');
          e.code = 'ENOENT';
          throw e;
        }
        return memFs.get(p);
      },
      writeFile: async (p, c) => {
        memFs.set(p, String(c));
      },
      mkdir: async () => {},
      rename: async (a, b) => {
        memFs.set(b, memFs.get(a));
        memFs.delete(a);
      },
      unlink: async () => {},
    };
    const service = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('serve') && args.includes('status')) {
            return {
              ok: true, code: 0, stdout: JSON.stringify({ Web: { 'm.tail.ts.net:443': { Handlers: { '/': 'http://127.0.0.1:9999' } } } }), stderr: '', spawnError: null, timedOut: false,
            };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    const result = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(result.state).toBe('conflict');
    expect(result.errorCode).toBe('conflict');
    expect(result.url).toBeNull();
    service.dispose();
  });

  it('blocks enabling without UI auth (public has no escape hatch)', async () => {
    const { service } = createHarness({ uiPassword: null });
    await service.loadConfig();
    await expect(service.setConfig({ enabled: true, mode: 'public', httpsPort: 443 })).rejects.toMatchObject({ code: 'auth_required' });
    service.dispose();
  });

  it('removes its own mapping on shutdown but never a foreign one', async () => {
    const removed = [];
    const memFs = new Map();
    const fsPromises = {
      readFile: async (p) => {
        if (!memFs.has(p)) {
          const e = new Error('x');
          e.code = 'ENOENT';
          throw e;
        }
        return memFs.get(p);
      },
      writeFile: async (p, c) => {
        memFs.set(p, String(c));
      },
      mkdir: async () => {},
      rename: async (a, b) => {
        memFs.set(b, memFs.get(a));
        memFs.delete(a);
      },
      unlink: async (p) => {
        memFs.delete(p);
      },
    };
    const service = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) {
            removed.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    service.dispose();
    // Re-create (simulates a restart): the persisted record drives removal.
    const service2 = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) {
            removed.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            // The persisted record still fronts this server: shutdown must
            // verify ownership, then remove it.
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: { 'mymachine.tailabc.ts.net:443': { Handlers: { '/': 'http://127.0.0.1:3000' } } } }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service2.loadConfig();
    await service2.shutdown();
    expect(removed.length).toBeGreaterThan(0);
    expect(removed[0]).toContain('off');
    service2.dispose();
  });

  it('surfaces needs-approval with the approval URL from streamed output', async () => {
    const memFs = new Map();
    const fsPromises = {
      readFile: async (p) => {
        if (!memFs.has(p)) {
          const e = new Error('x');
          e.code = 'ENOENT';
          throw e;
        }
        return memFs.get(p);
      },
      writeFile: async (p, c) => {
        memFs.set(p, String(c));
      },
      mkdir: async () => {},
      rename: async (a, b) => {
        memFs.set(b, memFs.get(a));
        memFs.delete(a);
      },
      unlink: async () => {},
    };
    const service = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args, { onOutput } = {}) => {
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('--bg')) {
            onOutput?.('visit https://login.tailscale.com/f/serve?node=n123 to approve\n');
            return { ok: false, code: 1, stdout: '', stderr: 'visit https://login.tailscale.com/f/serve?node=n123', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    const result = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(result.state).toBe('needs-approval');
    expect(result.approvalUrl).toBe('https://login.tailscale.com/f/serve?node=n123');
    service.dispose();
  });

  it('reports unavailable when the executable is missing', async () => {
    const { service } = createHarness({
      handlers: {
        '*': { ok: false, code: null, stdout: '', stderr: '', spawnError: 'spawn tailscale ENOENT', timedOut: false },
      },
    });
    await service.loadConfig();
    const result = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(result.state).toBe('unavailable');
    expect(result.errorCode).toBe('not_installed');
    service.dispose();
  });

  it('rejects enabling with an invalid port', async () => {
    const { service } = createHarness();
    await service.loadConfig();
    await expect(service.setConfig({ enabled: true, httpsPort: 3000 })).rejects.toMatchObject({ code: 'invalid_config' });
    service.dispose();
  });

  it('retry helper re-runs reconciliation', async () => {
    const spy = vi.fn();
    const { service } = createHarness({
      handlers: {
        '*': async () => {
          spy();
          return { ok: false, code: null, stdout: '', stderr: '', spawnError: 'spawn tailscale ENOENT', timedOut: false };
        },
      },
    });
    await service.loadConfig();
    await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    const before = spy.mock.calls.length;
    await service.retry();
    expect(spy.mock.calls.length).toBeGreaterThan(before);
    service.dispose();
  });
});

describe('tailscale exact port matching (F14)', () => {
  const webFor = (keys) => ({ Web: Object.fromEntries(keys.map((key) => [key, { Handlers: { '/': 'x' } }])) });
  it('matches <host>:<port> exactly and never by suffix', () => {
    const status = webFor(['m.tail.ts.net:443', 'm.tail.ts.net:8443', 'm.tail.ts.net:4433']);
    expect(findServeMappingForPort(status, 443)?.key).toBe('m.tail.ts.net:443');
    expect(findServeMappingForPort(status, 8443)?.key).toBe('m.tail.ts.net:8443');
    expect(findServeMappingForPort(status, 10000)).toBeNull();
    // 443 must not match :4433; a bare port key still matches.
    expect(findServeMappingForPort(webFor(['m.tail.ts.net:4433']), 443)).toBeNull();
    expect(findServeMappingForPort(webFor(['443']), 443)?.key).toBe('443');
    expect(findServeMappingForPort(null, 443)).toBeNull();
  });
});

describe('tailscale blocked-state cleanup (F2)', () => {
  it('removes its own live mapping before reporting blocked', async () => {
    const removed = [];
    const memFs = new Map();
    const fsPromises = {
      readFile: async (p) => {
        if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
        return memFs.get(p);
      },
      writeFile: async (p, c) => { memFs.set(p, String(c)); },
      mkdir: async () => {},
      rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
      unlink: async (p) => { memFs.delete(p); },
    };
    const oursStatus = (port, localPort) => JSON.stringify({
      Web: { [`mymachine.tailabc.ts.net:${port}`]: { Handlers: { '/': `http://127.0.0.1:${localPort}` } } },
    });
    const runner = {
      runTailscale: async (args) => {
        if (args.includes('off')) {
          removed.push(args);
          return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
        }
        if (args.includes('serve') && args.includes('status')) {
          return { ok: true, code: 0, stdout: oursStatus(443, 3000), stderr: '', spawnError: null, timedOut: false };
        }
        return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
      },
    };
    // First enable with a password so the record + mapping exist.
    const enabled = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner,
      fsPromises,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ serverId: await enabled.getServerId() }) }),
      logWarn: () => {},
    });
    await enabled.loadConfig();
    const active = await enabled.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(active.state).toBe('active');
    enabled.dispose();
    // Restart without the password: reconcile must remove the own mapping,
    // then report blocked.
    const blocked = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => false,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner,
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await blocked.loadConfig();
    const result = await blocked.reconcile();
    expect(result.state).toBe('blocked');
    expect(result.errorCode).toBe('auth_required');
    expect(removed.some((args) => args.includes('serve') && args.includes('off'))).toBe(true);
    blocked.dispose();
  });
});

describe('tailscale shutdown ownership verification (F3)', () => {
  const memFsFor = () => {
    const memFs = new Map();
    return {
      memFs,
      fsPromises: {
        readFile: async (p) => {
          if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
          return memFs.get(p);
        },
        writeFile: async (p, c) => { memFs.set(p, String(c)); },
        mkdir: async () => {},
        rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
        unlink: async (p) => { memFs.delete(p); },
      },
    };
  };
  const mappingPath = '/data/tailscale-mapping.json';

  it('leaves a foreign mapping alone on shutdown', async () => {
    const { memFs, fsPromises } = memFsFor();
    memFs.set(mappingPath, JSON.stringify({ httpsPort: 443, mode: 'private', localPort: 3000 }));
    const removed = [];
    const service = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) {
            removed.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: { 'other.tail.ts.net:443': { Handlers: { '/': 'http://127.0.0.1:9999' } } } }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    await service.shutdown();
    expect(removed).toEqual([]);
    service.dispose();
  });

  it('issues no off and keeps the record when the status query fails', async () => {
    const { memFs, fsPromises } = memFsFor();
    memFs.set(mappingPath, JSON.stringify({ httpsPort: 443, mode: 'private', localPort: 3000 }));
    const removed = [];
    const warnings = [];
    const service = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) {
            removed.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: false, code: 1, stdout: '', stderr: 'boom', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: (message) => warnings.push(String(message)),
    });
    await service.loadConfig();
    await service.shutdown();
    expect(removed).toEqual([]);
    expect(warnings.some((message) => /status query failed/i.test(message))).toBe(true);
    // Record kept for next-start stale cleanup.
    expect(memFs.has(mappingPath)).toBe(true);
    service.dispose();
  });
});

describe('tailscale unknown-vs-absent status queries (F4)', () => {
  const memFsFor = () => {
    const memFs = new Map();
    return {
      memFs,
      fsPromises: {
        readFile: async (p) => {
          if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
          return memFs.get(p);
        },
        writeFile: async (p, c) => { memFs.set(p, String(c)); },
        mkdir: async () => {},
        rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
        unlink: async (p) => { memFs.delete(p); },
      },
    };
  };
  const mappingPath = '/data/tailscale-mapping.json';

  it('refuses to apply on a failed status query and never clears the record', async () => {
    const { memFs, fsPromises } = memFsFor();
    const applied = [];
    const removed = [];
    const service = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('--bg')) {
            applied.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('off')) {
            removed.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: false, code: 1, stdout: '', stderr: 'boom', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    const result = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(result.state).toBe('error');
    expect(result.errorCode).toBe('status_query_failed');
    expect(applied).toEqual([]);
    expect(removed).toEqual([]);
    expect(memFs.has(mappingPath)).toBe(false);
    service.dispose();
  });

  it('ends a public-to-private switch in error with the old funnel record kept', async () => {
    const { memFs, fsPromises } = memFsFor();
    // Stale public record from a previous run; the funnel status query fails.
    memFs.set(mappingPath, JSON.stringify({ httpsPort: 443, mode: 'public', localPort: 3000 }));
    const applied = [];
    const service = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('--bg')) {
            applied.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args[0] === 'tailscale' && args[1] === 'funnel' && args.includes('status')) {
            return { ok: false, code: 1, stdout: '', stderr: 'boom', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    // Bypass setConfig persistence: enable private directly, so reconcile
    // must first clean the stale public record (whose query fails).
    const { persistTailscaleConfigForStartup } = await import('./service.js');
    await persistTailscaleConfigForStartup({
      dataDir: '/data',
      patch: { enabled: true, mode: 'private', httpsPort: 443 },
      fsPromises,
      uiPasswordConfigured: true,
    });
    await service.loadConfig();
    const result = await service.reconcile();
    expect(result.state).toBe('error');
    expect(result.errorCode).toBe('status_query_failed');
    // No new mapping applied; the old funnel record stays for cleanup.
    expect(applied).toEqual([]);
    expect(memFs.has(mappingPath)).toBe(true);
    service.dispose();
  });
});

describe('tailscale generation bump cancels in-flight apply (F6)', () => {
  it('aborts the stale apply and removes the mapping it created', async () => {
    const memFs = new Map();
    const mappingPath = '/data/tailscale-mapping.json';
    const fsPromises = {
      readFile: async (p) => {
        if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
        return memFs.get(p);
      },
      writeFile: async (p, c) => { memFs.set(p, String(c)); },
      mkdir: async () => {},
      rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
      unlink: async (p) => { memFs.delete(p); },
    };
    const removed = [];
    let apply443Started = null;
    const apply443Aborted = [];
    const serveWeb = () => JSON.stringify({
      Web: { 'mymachine.tailabc.ts.net:443': { Handlers: { '/': 'http://127.0.0.1:3000' } } },
    });
    const runner = {
      runTailscale: (args, { signal } = {}) => {
        if (args.includes('--bg') && args.includes('--https=443')) {
          apply443Started?.();
          // Block until the generation bump aborts this apply.
          return new Promise((resolve) => {
            const done = (aborted) => resolve({
              ok: false, code: aborted ? null : 0, stdout: '', stderr: '', spawnError: aborted ? 'aborted' : null, timedOut: false,
            });
            if (signal?.aborted) return done(true);
            signal?.addEventListener?.('abort', () => done(true), { once: true });
            apply443Aborted.push(signal);
          });
        }
        if (args.includes('off')) {
          removed.push(args);
          return Promise.resolve({ ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false });
        }
        if (args.includes('serve') && args.includes('status')) {
          return Promise.resolve({ ok: true, code: 0, stdout: serveWeb(), stderr: '', spawnError: null, timedOut: false });
        }
        return Promise.resolve({ ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false });
      },
    };
    const service = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner,
      fsPromises,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ serverId: await service.getServerId() }) }),
      logWarn: () => {},
    });
    await service.loadConfig();
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    apply443Started = startedResolve;
    const first = service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    await started;
    // Generation bump while the 443 apply is in flight.
    const second = service.setConfig({ enabled: true, mode: 'private', httpsPort: 8443 });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    // The superseded reconcile resolves (never hangs on the killed apply).
    expect(firstResult).toBeDefined();
    expect(apply443Aborted.length).toBe(1);
    expect(apply443Aborted[0]?.aborted).toBe(true);
    // The stale 443 mapping (still live, pointing at our port) is removed;
    // the live generation owns 8443.
    expect(removed.some((args) => args.includes('--https=443') && args.includes('off'))).toBe(true);
    expect(secondResult.state).toBe('active');
    expect(secondResult.url).toBe('https://mymachine.tailabc.ts.net:8443');
    service.dispose();
  });
});
