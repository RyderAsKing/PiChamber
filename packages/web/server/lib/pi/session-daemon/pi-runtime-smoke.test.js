// Portable real-subprocess smoke for the pinned Pi SDK and foreground backend.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createPiSessionDaemonSupervisor } from './supervisor.js';

const HELP_TIMEOUT_MS = 20_000;
const RPC_TIMEOUT_MS = 20_000;
const BACKEND_READY_TIMEOUT_MS = 30_000;
const BACKEND_POLL_MS = 250;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

const roots = [];
const children = [];

const closePromises = new WeakMap();

const ensureCloseTracking = (child) => {
  let tracked = closePromises.get(child);
  if (!tracked) {
    tracked = new Promise((resolve, reject) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
      child.once('error', reject);
    });
    tracked.catch(() => {});
    closePromises.set(child, tracked);
  }
  return tracked;
};

// Truly observe `close`, never resolve early on `exitCode` and never resolve
// on timeout. Timeouts reject so cleanup cannot swallow a hung child.
const waitForClose = async (child, ms) => {
  const closePromise = ensureCloseTracking(child);
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Child process did not close within ${ms}ms (exitCode=${child.exitCode}, signal=${child.signalCode}).`));
    }, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([closePromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
};

// Signal only a directly-spawned child handle. Never resolve a PID from a
// log file or state sidecar into `process.kill`; stale PIDs must not be
// signaled. Only ESRCH (already dead) is ignored.
const signalOwnChild = (child, signal) => {
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    throw error;
  }
};

const withTimeout = async (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const untrack = (child) => {
  const index = children.indexOf(child);
  if (index !== -1) children.splice(index, 1);
};

afterEach(async () => {
  const pending = children.splice(0);
  for (const child of pending) {
    ensureCloseTracking(child);
    signalOwnChild(child, 'SIGTERM');
  }
  for (const child of pending) {
    try {
      await waitForClose(child, 5_000);
    } catch {
      signalOwnChild(child, 'SIGKILL');
      await waitForClose(child, 5_000);
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const resolveTestRuntime = () => {
  const override = typeof process.env.PICHAMBER_TEST_RUNTIME === 'string'
    ? process.env.PICHAMBER_TEST_RUNTIME.trim()
    : '';
  if (override.length === 0) return process.execPath;
  if (!isAbsolute(override)) throw new Error('PICHAMBER_TEST_RUNTIME must be an absolute path.');
  return override;
};

const resolvePiCli = async () => {
  const sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
  let dir = dirname(fileURLToPath(sdkUrl));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const raw = await readFile(join(dir, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.name === '@earendil-works/pi-coding-agent') {
        const bin = typeof parsed.bin === 'string' ? parsed.bin : parsed?.bin?.pi;
        if (typeof bin !== 'string' || bin.length === 0) throw new Error('Installed Pi package.json has no bin.pi entry.');
        const cliPath = resolve(dir, bin);
        await stat(cliPath);
        return { cliPath, packageJson: parsed };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR' && !(error instanceof SyntaxError)) throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate @earendil-works/pi-coding-agent package.json.');
};

const readPinnedPiVersion = async () => {
  const raw = await readFile(new URL('../../../../package.json', import.meta.url), 'utf8');
  const dep = JSON.parse(raw).dependencies?.['@earendil-works/pi-coding-agent'];
  if (typeof dep !== 'string' || dep.length === 0) throw new Error('Pinned Pi dependency is missing.');
  // The Pi SDK is pinned exactly (no ^/~); return the exact string so version
  // parity asserts exact equality instead of stripping a range prefix.
  return dep;
};

const makeIsolatedRoot = async (prefix) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const layout = {
    root,
    cwd: join(root, 'cwd'),
    home: join(root, 'home'),
    agentDir: join(root, 'agent'),
    sessionDir: join(root, 'sessions'),
    xdgRuntime: join(root, 'xdg-runtime'),
    xdgConfig: join(root, 'xdg-config'),
    xdgData: join(root, 'xdg-data'),
    xdgCache: join(root, 'xdg-cache'),
    tmp: join(root, 'tmp'),
  };
  await Promise.all([layout.cwd, layout.home, layout.agentDir, layout.sessionDir,
    layout.xdgRuntime, layout.xdgConfig, layout.xdgData, layout.xdgCache, layout.tmp]
    .map((dir) => mkdir(dir, { recursive: true })));
  return layout;
};

const buildIsolatedEnv = ({ runtime, layout, extra = {} }) => {
  const runtimeDir = dirname(runtime);
  const isWindows = process.platform === 'win32';
  const env = {
    PATH: isWindows && typeof process.env.PATH === 'string' && process.env.PATH.length > 0
      ? `${runtimeDir}${delimiter}${process.env.PATH}`
      : runtimeDir,
    HOME: layout.home,
    USERPROFILE: layout.home,
    TMPDIR: layout.tmp,
    TEMP: layout.tmp,
    TMP: layout.tmp,
    XDG_RUNTIME_DIR: layout.xdgRuntime,
    XDG_CONFIG_HOME: layout.xdgConfig,
    XDG_DATA_HOME: layout.xdgData,
    XDG_CACHE_HOME: layout.xdgCache,
    PI_CODING_AGENT_DIR: layout.agentDir,
    PI_CODING_AGENT_SESSION_DIR: layout.sessionDir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
    ...extra,
  };
  if (isWindows) {
    if (typeof process.env.SystemRoot === 'string' && process.env.SystemRoot.length > 0) env.SystemRoot = process.env.SystemRoot;
    if (typeof process.env.SystemDrive === 'string' && process.env.SystemDrive.length > 0) env.SystemDrive = process.env.SystemDrive;
    if (typeof process.env.PATHEXT === 'string' && process.env.PATHEXT.length > 0) env.PATHEXT = process.env.PATHEXT;
  }
  return env;
};

const allocateLoopbackPort = async () => {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((done) => server.close(done));
  if (!Number.isInteger(port) || port <= 0) throw new Error('Could not allocate a loopback port.');
  return port;
};

const realExec = async (value) => {
  try { return await realpath(value); } catch { return value; }
};

const normalizeArgv = (value) => String(value ?? '').replace(/\\/g, '/');

// Verified leftover-daemon shutdown using only the isolated root. Never
// resolves a PID from a log file into `process.kill`. Uses the owning
// supervisor's authenticated IPC (`runtime.shutdown` after identity checks)
// and only touches files under the isolated `dataDir`/runtime dir. Bounded;
// on failure the caller must preserve the isolated root (no state delete).
const stopIsolatedDaemon = async ({ layout, dataDir, daemonAgentDir, port }) => {
  const webPkg = JSON.parse(await readFile(new URL('../../../../package.json', import.meta.url), 'utf8'));
  const version = typeof webPkg?.version === 'string' && webPkg.version.length > 0 ? webPkg.version : 'unknown';
  const env = {
    PICHAMBER_DATA_DIR: dataDir,
    PICHAMBER_PI_AGENT_DIR: daemonAgentDir,
    XDG_RUNTIME_DIR: layout.xdgRuntime,
  };
  if (process.platform === 'win32') {
    if (typeof process.env.SystemRoot === 'string' && process.env.SystemRoot.length > 0) env.SystemRoot = process.env.SystemRoot;
    if (typeof process.env.SystemDrive === 'string' && process.env.SystemDrive.length > 0) env.SystemDrive = process.env.SystemDrive;
    if (typeof process.env.PATHEXT === 'string' && process.env.PATHEXT.length > 0) env.PATHEXT = process.env.PATHEXT;
  }
  const supervisor = createPiSessionDaemonSupervisor({ env, cwd: layout.cwd, dataDir, port, version });
  try {
    await stat(supervisor.paths.stateFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return { cleaned: true, reason: 'no-state' };
    throw error;
  }
  try {
    await withTimeout(supervisor.stop(), 15_000, 'Isolated daemon stop');
    return { cleaned: true, reason: 'stopped' };
  } catch (error) {
    // A new supervisor has a fresh instance id, so `stop` safely refuses with
    // OWNERSHIP_MISMATCH when the leftover daemon is still owned by the dead
    // backend. Claim (only succeeds when the recorded owner PID is dead) then
    // stop as the new owner. Any other error propagates without deleting state.
    if (error?.code !== 'DAEMON_OWNERSHIP_MISMATCH') throw error;
    await withTimeout(supervisor.start(), 20_000, 'Isolated daemon claim');
    await withTimeout(supervisor.stop(), 15_000, 'Isolated daemon stop after claim');
    return { cleaned: true, reason: 'claimed-stopped' };
  }
};

describe('portable Pi runtime smoke', () => {
  it('imports the Pi SDK in the selected runtime with pinned version parity', async () => {
    const runtime = resolveTestRuntime();
    const sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
    const pinned = await readPinnedPiVersion();
    const layout = await makeIsolatedRoot('pichamber-pi-sdk-');
    const probe = join(layout.root, 'sdk-probe.mjs');
    await writeFile(probe, [
      `import * as PiSdk from ${JSON.stringify(sdkUrl)};`,
      'process.stdout.write(JSON.stringify({ version: PiSdk.VERSION,',
      '  createAgentSession: typeof PiSdk.createAgentSession,',
      '  SessionManager: typeof PiSdk.SessionManager,',
      '  ModelRuntime: typeof PiSdk.ModelRuntime }));',
      '',
    ].join('\n'));
    const result = spawnSync(runtime, [probe], {
      cwd: layout.cwd,
      env: buildIsolatedEnv({ runtime, layout }),
      timeout: HELP_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(String(result.stderr ?? '')).toBe('');
    const out = JSON.parse(String(result.stdout ?? ''));
    expect(out.createAgentSession).toBe('function');
    expect(out.SessionManager).toBe('function');
    expect(out.ModelRuntime).toBe('function');
    expect(out.version).toBe(pinned);
    const { packageJson } = await resolvePiCli();
    expect(out.version).toBe(packageJson.version);
  }, 30_000);

  it('resolves the installed Pi CLI through package.json bin.pi', async () => {
    const { cliPath, packageJson } = await resolvePiCli();
    expect(isAbsolute(cliPath)).toBe(true);
    expect(cliPath).toContain('cli.js');
    expect(typeof (packageJson.bin?.pi ?? packageJson.bin)).toBe('string');
  });

  it('runs bin.pi --help to success with EOF in an isolated subprocess', async () => {
    const runtime = resolveTestRuntime();
    const { cliPath } = await resolvePiCli();
    const layout = await makeIsolatedRoot('pichamber-pi-help-');
    const result = spawnSync(runtime, [cliPath, '--help'], {
      cwd: layout.cwd,
      env: buildIsolatedEnv({ runtime, layout }),
      timeout: HELP_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('--mode');
    expect(result.stdout).toContain('rpc');
    expect(String(result.stderr ?? '')).toBe('');
  }, 30_000);

  it('runs bin.pi rpc get_state with id runtime-smoke to success', async () => {
    const runtime = resolveTestRuntime();
    const { cliPath } = await resolvePiCli();
    const layout = await makeIsolatedRoot('pichamber-pi-rpc-');
    const result = spawnSync(runtime, [cliPath, '--mode', 'rpc', '--no-session', '--offline'], {
      cwd: layout.cwd,
      env: buildIsolatedEnv({ runtime, layout }),
      input: `${JSON.stringify({ type: 'get_state', id: 'runtime-smoke' })}\n`,
      timeout: RPC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(String(result.stderr ?? '')).toBe('');
    const frames = String(result.stdout ?? '')
      .split('\n')
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    const response = frames.find((frame) => frame?.id === 'runtime-smoke');
    expect(response).toMatchObject({ type: 'response', command: 'get_state', success: true, id: 'runtime-smoke' });
    expect(response?.data).toMatchObject({ isStreaming: false });
  }, 30_000);

  it('starts a credential-free foreground backend on the selected runtime', async () => {
    const runtime = resolveTestRuntime();
    const pichamberCli = fileURLToPath(new URL('../../../../bin/cli.js', import.meta.url));
    await stat(pichamberCli);
    const layout = await makeIsolatedRoot('pichamber-backend-smoke-');
    const dataDir = join(layout.root, 'data');
    const daemonAgentDir = join(layout.root, 'daemon-agent');
    await mkdir(dataDir, { recursive: true });
    await mkdir(daemonAgentDir, { recursive: true });
    const port = await allocateLoopbackPort();
    const probeFile = join(layout.root, 'runtime-probe.mjs');
    const probeLog = join(layout.root, 'runtime-probe.log');
    await writeFile(probeFile, [
      "import fs from 'node:fs';",
      'const out = process.env.PICHAMBER_RUNTIME_PROBE_FILE;',
      'if (out) {',
      '  const line = JSON.stringify({ pid: process.pid, execPath: process.execPath, argv1: process.argv[1] ?? null }) + "\\n";',
      '  fs.appendFileSync(out, line);',
      '}',
      '',
    ].join('\n'));
    const probeUrl = pathToFileURL(probeFile).href;
    const env = buildIsolatedEnv({
      runtime,
      layout,
      extra: {
        PICHAMBER_DATA_DIR: dataDir,
        PICHAMBER_PI_AGENT_DIR: daemonAgentDir,
        PICHAMBER_RUNTIME_PROBE_FILE: probeLog,
        NODE_OPTIONS: `--import ${probeUrl}`,
        BUN_OPTIONS: `--import ${probeUrl}`,
      },
    });
    if (process.platform !== 'win32') env.PATH = '';
    const child = spawn(runtime, [
      '--import', probeFile,
      pichamberCli, 'serve',
      '--foreground',
      '--port', String(port),
      '--host', '127.0.0.1',
      '--api-only',
    ], {
      cwd: layout.cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    ensureCloseTracking(child);
    let serverOutput = '';
    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const onData = (chunk) => {
      serverOutput += chunk;
      if (serverOutput.length > MAX_BUFFER_BYTES) {
        try {
          signalOwnChild(child, 'SIGKILL');
        } catch (error) {
          if (error?.code !== 'ESRCH') spawnError ??= error;
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const deadline = Date.now() + BACKEND_READY_TIMEOUT_MS;
    let runtimeJson = null;
    let lastError = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null || spawnError) {
        throw new Error(`Foreground backend exited early (code ${child.exitCode ?? child.signalCode ?? spawnError?.message}). Output: ${serverOutput.slice(0, 2000)}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/pi/runtime`, { signal: AbortSignal.timeout(5_000) });
        const text = await response.text();
        if (response.status === 200) {
          runtimeJson = JSON.parse(text);
          break;
        }
        lastError = new Error(`Unexpected /api/pi/runtime status ${response.status}: ${text.slice(0, 500)}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((done) => setTimeout(done, BACKEND_POLL_MS));
    }
    try {
      expect(runtimeJson).toMatchObject({ state: 'ready', protocolVersion: 1 });
      expect(runtimeJson.capabilities).toEqual(expect.arrayContaining(['sessions.list']));
      expect(JSON.stringify(runtimeJson)).not.toContain(dataDir);
      expect(JSON.stringify(runtimeJson)).not.toContain('credential');
      const probeText = await readFile(probeLog, 'utf8');
      const records = probeText.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
      const parent = records.find((record) => normalizeArgv(record.argv1).endsWith('bin/cli.js'));
      const daemon = records.find((record) => normalizeArgv(record.argv1).endsWith('daemon-process.js'));
      expect(parent).toBeDefined();
      expect(daemon).toBeDefined();
      const expectedExec = await realExec(runtime);
      expect(await realExec(parent.execPath)).toBe(expectedExec);
      expect(await realExec(daemon.execPath)).toBe(expectedExec);
    } finally {
      try {
        signalOwnChild(child, 'SIGTERM');
        try {
          await waitForClose(child, 20_000);
        } catch {
          signalOwnChild(child, 'SIGKILL');
          await waitForClose(child, 5_000);
        }
        await stopIsolatedDaemon({ layout, dataDir, daemonAgentDir, port });
        await waitForClose(child, 5_000);
      } catch (error) {
        // Preserve the isolated root when verified cleanup cannot complete;
        // deleting live daemon state would orphan or corrupt the leftover.
        const rootIndex = roots.indexOf(layout.root);
        if (rootIndex !== -1) roots.splice(rootIndex, 1);
        throw error;
      }
      untrack(child);
    }
    if (!runtimeJson) throw lastError ?? new Error('Foreground backend never reported /api/pi/runtime ready.');
  }, 60_000);
});
