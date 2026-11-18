import { describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn as spawnChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPiSessionDaemonSupervisor } from './supervisor.js';

const DAEMON_ENTRYPOINT = fileURLToPath(new URL('./daemon-process.js', import.meta.url));
const SERVER_PID = 1000;
const LAUNCHER_PID = 4242;
const DAEMON_PID = 4243;
// A process the sandbox would like the server to kill (the server itself,
// the main daemon, anything the user owns).
const VICTIM_PID = 777;

const exists = async (file) => access(file).then(() => true, () => false);

const argValue = (args, flag) => args[args.indexOf(flag) + 1];

/**
 * A fake host: a process table, a launcher that wraps the daemon command, and
 * a daemon whose health answer echoes whatever its state sidecar says, the
 * way a sandboxed daemon under an attacker's control would.
 */
const createWorld = async ({ withLauncher = true } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-launcher-stop-'));
  const dataDir = join(root, 'data');
  // Short on purpose: nothing binds it, but the path must stay local.
  const runtimeDir = await mkdtemp('/tmp/pls-');
  const processes = new Map([
    [1, { identity: 'start:1', alive: true }],
    [SERVER_PID, { identity: 'start:1000', alive: true }],
    [VICTIM_PID, { identity: 'start:777', alive: true }],
  ]);
  const signals = [];
  const requests = [];
  const processLike = {
    pid: SERVER_PID,
    execPath: '/opt/node/bin/node',
    versions: { node: '24.0.0' },
    kill(pid, signal) {
      if (signal !== 0) signals.push([pid, signal]);
      const entry = processes.get(pid);
      if (!entry?.alive) {
        const error = new Error('ESRCH');
        error.code = 'ESRCH';
        throw error;
      }
      if (signal === 'SIGTERM' && (pid === LAUNCHER_PID || pid === DAEMON_PID)) {
        // The launcher forwards SIGTERM to the daemon and exits after it.
        for (const own of [LAUNCHER_PID, DAEMON_PID]) {
          if (processes.has(own)) processes.get(own).alive = false;
        }
      }
      return true;
    },
  };
  const readProcessIdentity = async (pid) => {
    const entry = processes.get(pid);
    return entry?.alive ? entry.identity : null;
  };
  let stateFile;
  const spawn = (command, args) => {
    const daemonArgs = withLauncher ? args.slice(1) : args;
    stateFile = argValue(daemonArgs, '--state-file');
    processes.set(LAUNCHER_PID, { identity: 'start:4242', alive: true });
    processes.set(DAEMON_PID, { identity: 'start:4243', alive: true });
    const state = {
      protocolVersion: 1,
      pid: withLauncher ? DAEMON_PID : LAUNCHER_PID,
      endpoint: argValue(daemonArgs, '--endpoint'),
      profileKey: argValue(daemonArgs, '--profile-key'),
      serverInstanceId: argValue(daemonArgs, '--server-instance-id'),
      serverPid: Number(argValue(daemonArgs, '--server-pid')),
      daemonId: argValue(daemonArgs, '--daemon-id'),
      buildId: argValue(daemonArgs, '--build-id'),
      entrypoint: DAEMON_ENTRYPOINT,
      startedAt: new Date().toISOString(),
    };
    void mkdir(dirname(stateFile), { recursive: true }).then(() => writeFile(stateFile, JSON.stringify(state)));
    return { pid: LAUNCHER_PID, unref() {}, once() {} };
  };
  const request = async ({ command, payload }) => {
    requests.push({ command, payload });
    const daemonAlive = processes.get(DAEMON_PID)?.alive && processes.get(LAUNCHER_PID)?.alive;
    if (!daemonAlive || !stateFile) {
      const error = new Error('refused');
      error.code = 'DAEMON_CONNECTION_REFUSED';
      throw error;
    }
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (command === 'runtime.health') {
      return {
        state: 'ready',
        daemonPid: state.pid,
        profileKey: state.profileKey,
        daemonId: state.daemonId,
        serverInstanceId: state.serverInstanceId,
        serverPid: state.serverPid,
        buildId: state.buildId,
        capabilities: [],
      };
    }
    // runtime.shutdown is acknowledged but the daemon keeps running, so the
    // stop has to fall back to the signal.
    return {};
  };
  const supervisor = createPiSessionDaemonSupervisor({
    env: { PATH: process.env.PATH, PICHAMBER_DATA_DIR: dataDir, XDG_RUNTIME_DIR: runtimeDir },
    dataDir,
    port: 3000,
    cwd: root,
    platform: 'linux',
    processLike,
    request,
    spawn,
    wait: async () => {},
    startupTimeoutMs: 200,
    daemonReadyTimeoutMs: 2_000,
    readProcessIdentity,
    ...(withLauncher
      ? { launch: async ({ command, args, env }) => ({ command: '/usr/bin/fake-launcher', args: [command, ...args], env }) }
      : {}),
  });
  const forgeState = async (changes) => {
    const state = JSON.parse(await readFile(supervisor.paths.stateFile, 'utf8'));
    await writeFile(supervisor.paths.stateFile, JSON.stringify({ ...state, ...changes }));
  };
  return { root, dataDir, processes, signals, requests, supervisor, forgeState };
};

describe('launcher daemon stop', () => {
  it('keeps the launcher record and operation lock outside the profile folder the sandbox can write', async () => {
    const world = await createWorld();
    const { paths } = world.supervisor;
    expect(paths.lockFile).toBe(join(world.dataDir, 'pi', 'launchers', paths.profileKey, 'operation.lock'));
    expect(paths.launcherFile).toBe(join(world.dataDir, 'pi', 'launchers', paths.profileKey, 'launcher.json'));
    expect(paths.lockFile.startsWith(`${paths.profileDir}/`)).toBe(false);

    await expect(world.supervisor.start()).resolves.toMatchObject({ state: 'ready', reused: false });
    expect(JSON.parse(await readFile(paths.launcherFile, 'utf8'))).toMatchObject({
      pid: LAUNCHER_PID,
      identity: 'start:4242',
      profileKey: paths.profileKey,
      serverInstanceId: paths.serverInstanceId,
    });
  });

  it('never signals a foreign pid written into the state sidecar', async () => {
    const world = await createWorld();
    await world.supervisor.start();
    // The sandbox rewrites its sidecar; the health answer echoes it.
    await world.forgeState({ pid: VICTIM_PID });

    await expect(world.supervisor.stop()).resolves.toEqual({ state: 'stopped' });
    expect(world.signals.filter(([pid]) => pid === VICTIM_PID)).toEqual([]);
    expect(world.processes.get(VICTIM_PID).alive).toBe(true);
    expect(world.signals).toEqual([[LAUNCHER_PID, 'SIGTERM']]);
  });

  it('asks for the authenticated shutdown, then signals the recorded launcher and removes its record', async () => {
    const world = await createWorld();
    await world.supervisor.start();

    await expect(world.supervisor.stop()).resolves.toEqual({ state: 'stopped' });
    expect(world.requests.map(({ command }) => command)).toContain('runtime.shutdown');
    expect(world.signals).toEqual([[LAUNCHER_PID, 'SIGTERM']]);
    expect(world.processes.get(LAUNCHER_PID).alive).toBe(false);
    expect(await exists(world.supervisor.paths.launcherFile)).toBe(false);
    expect(await exists(world.supervisor.paths.stateFile)).toBe(false);
  });

  it('stops the recorded launcher even when the sandbox removed its credential and sidecar', async () => {
    const world = await createWorld();
    await world.supervisor.start();
    await rm(world.supervisor.paths.credentialFile);
    await rm(world.supervisor.paths.stateFile);

    await expect(world.supervisor.stop()).resolves.toEqual({ state: 'stopped' });
    expect(world.signals).toEqual([[LAUNCHER_PID, 'SIGTERM']]);
  });

  it('signals nothing when the recorded pid now belongs to another process', async () => {
    const world = await createWorld();
    await world.supervisor.start();
    // The launcher exited and its pid went to an unrelated process.
    world.processes.set(LAUNCHER_PID, { identity: 'start:9999', alive: true });
    world.processes.get(DAEMON_PID).alive = false;

    await expect(world.supervisor.stop()).resolves.toEqual({ state: 'stopped' });
    expect(world.signals).toEqual([]);
    expect(world.processes.get(LAUNCHER_PID).alive).toBe(true);
    expect(await exists(world.supervisor.paths.launcherFile)).toBe(false);
  });

  it('signals nothing for a launcher daemon without a record, whatever its sidecar says', async () => {
    const world = await createWorld();
    await world.supervisor.start();
    await rm(world.supervisor.paths.launcherFile);
    await world.forgeState({ pid: VICTIM_PID });

    // The victim stays alive, so the wait for the forged pid times out.
    await expect(world.supervisor.stop()).rejects.toMatchObject({ code: 'DAEMON_STOP_TIMEOUT' });
    expect(world.signals).toEqual([]);
  });

  it('refuses to stop a launcher daemon whose record names another server instance', async () => {
    const world = await createWorld();
    await world.supervisor.start();
    const record = JSON.parse(await readFile(world.supervisor.paths.launcherFile, 'utf8'));
    await writeFile(world.supervisor.paths.launcherFile, JSON.stringify({ ...record, serverInstanceId: 'newer-instance' }));

    await expect(world.supervisor.stop()).rejects.toMatchObject({ code: 'DAEMON_OWNERSHIP_MISMATCH' });
    expect(world.signals).toEqual([]);
  });

  it('is not blocked by an operation lock planted in the profile folder', async () => {
    const world = await createWorld();
    const { paths } = world.supervisor;
    await mkdir(paths.profileDir, { recursive: true });
    // pid 1 is alive, so this lock would never be stolen.
    await writeFile(join(paths.profileDir, 'operation.lock'), JSON.stringify({ pid: 1 }));

    await expect(world.supervisor.start()).resolves.toMatchObject({ state: 'ready' });
    await expect(world.supervisor.stop()).resolves.toEqual({ state: 'stopped' });
    expect(world.signals).toEqual([[LAUNCHER_PID, 'SIGTERM']]);
  });

  it('does not start a second daemon beside a recorded launcher that is still running', async () => {
    const world = await createWorld();
    await world.supervisor.start();
    // The daemon stops answering and its sidecar is gone, but the launcher runs.
    world.processes.get(DAEMON_PID).alive = false;
    await rm(world.supervisor.paths.stateFile);

    await expect(world.supervisor.start()).rejects.toMatchObject({ code: 'DAEMON_UNAVAILABLE' });
    expect(world.signals).toEqual([]);
  });
});

describe.runIf(process.platform === 'linux')('launcher identity on Linux', () => {
  it('records a real launcher by its /proc start time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-launcher-identity-'));
    const dataDir = join(root, 'data');
    const runtimeDir = await mkdtemp('/tmp/pli-');
    let child;
    const supervisor = createPiSessionDaemonSupervisor({
      env: { PATH: process.env.PATH, PICHAMBER_DATA_DIR: dataDir, XDG_RUNTIME_DIR: runtimeDir },
      dataDir,
      port: 3000,
      cwd: root,
      platform: 'linux',
      // A stand-in launcher that never answers, so the start times out and
      // signals the child it spawned.
      spawn: (_command, _args, options) => {
        child = spawnChildProcess('sleep', ['30'], { ...options, stdio: 'ignore' });
        return child;
      },
      request: async () => {
        const error = new Error('refused');
        error.code = 'DAEMON_CONNECTION_REFUSED';
        throw error;
      },
      wait: (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
      startupTimeoutMs: 500,
      daemonReadyTimeoutMs: 300,
      launch: async ({ command, args, env }) => ({ command, args, env }),
    });

    await expect(supervisor.start()).rejects.toMatchObject({ code: 'DAEMON_START_TIMEOUT' });
    const record = JSON.parse(await readFile(supervisor.paths.launcherFile, 'utf8'));
    const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8').catch(() => '');
    expect(record.pid).toBe(child.pid);
    expect(record.identity).toMatch(/^linux-start:\d+$/);
    if (stat) expect(record.identity).toBe(`linux-start:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`);
    child.kill('SIGKILL');
  });
});

describe('main daemon stop', () => {
  it('still signals the pid in its state sidecar and keeps its lock in the profile folder', async () => {
    const world = await createWorld({ withLauncher: false });
    const { paths } = world.supervisor;
    expect(paths.lockFile).toBe(join(paths.profileDir, 'operation.lock'));
    expect(paths.launcherFile).toBeUndefined();

    await world.supervisor.start();
    await expect(world.supervisor.stop()).resolves.toEqual({ state: 'stopped' });
    expect(world.requests.map(({ command }) => command)).toContain('runtime.shutdown');
    expect(world.signals).toEqual([[LAUNCHER_PID, 'SIGTERM']]);
    expect(await exists(join(world.dataDir, 'pi', 'launchers'))).toBe(false);
  });
});
