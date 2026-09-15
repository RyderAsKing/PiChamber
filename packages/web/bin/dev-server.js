#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isModuleCliExecution } from './cli-entry.js';
import { resolveServerExecutable } from './lib/server-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEV_SERVER_PATH = path.join(__dirname, '..', 'server', 'index.js');

// Conventional shell exit codes for signal termination (128 + signal number).
// Matches scripts/dev-web-*.mjs precedent (SIGINT 130, SIGTERM 143, SIGHUP 129).
export const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGUSR1: 138,
  SIGUSR2: 140,
  SIGTERM: 143,
};

const BASE_LIFECYCLE_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
const USR_LIFECYCLE_SIGNALS = ['SIGUSR1', 'SIGUSR2'];

function getLifecycleSignals(processRef) {
  const platform = processRef?.platform ?? process.platform;
  if (platform === 'win32') return [...BASE_LIFECYCLE_SIGNALS];
  return [...BASE_LIFECYCLE_SIGNALS, ...USR_LIFECYCLE_SIGNALS];
}

export function resolveSignalExitCode(signal) {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}

export function forwardSignalToChild(child, signal) {
  if (!child || typeof child.kill !== 'function') return false;
  if (child.exitCode !== null && child.exitCode !== undefined) return false;
  if (child.signalCode !== null && child.signalCode !== undefined) return false;
  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

function buildDevServerCommand(resolved, serverPath = DEV_SERVER_PATH, serverArgs = []) {
  return { executable: resolved.executable, args: [serverPath, ...serverArgs] };
}

function resolveDevServerCommand({
  resolveFn = resolveServerExecutable,
  serverPath = DEV_SERVER_PATH,
  serverArgs = [],
} = {}) {
  const resolved = resolveFn();
  return {
    runtime: resolved.runtime,
    executable: resolved.executable,
    args: [serverPath, ...serverArgs],
  };
}

function startDevServerChild({
  spawnFn = spawn,
  resolveFn = resolveServerExecutable,
  serverPath = DEV_SERVER_PATH,
  serverArgs = [],
  env = process.env,
} = {}) {
  const command = resolveDevServerCommand({ resolveFn, serverPath, serverArgs });
  const child = spawnFn(command.executable, command.args, { stdio: 'inherit', env });
  return { command, child };
}

// Single-child lifecycle: forward parent signals to the direct backend child
// and propagate the backend exit. Direct child.kill only — no process-tree
// framework. The backend owns its detached Pi session daemon via authenticated
// IPC (supervisor stop), so killing the whole tree would terminate a daemon
// that is intentionally detached. The backend handles SIGINT/SIGTERM
// gracefully; SIGUSR2/SIGHUP/SIGQUIT terminate with default semantics.
//
// SIGINT process-group double delivery: Ctrl+C in a terminal delivers SIGINT
// to the whole foreground group, so launcher and backend both receive it.
// Forwarding is idempotent (second kill is a harmless no-op when the backend
// already exited) and the launcher waits for the backend exit instead of
// exiting immediately, so the backend is never orphaned. The launcher's own
// signal code takes precedence over the backend's exit code to preserve
// Ctrl+C (130) semantics even when the backend exits 0 after graceful
// shutdown.
//
// Nodemon restart (dev:server:watch): nodemon's default signal is SIGUSR2. It
// kills its whole subtree (launcher and backend) with SIGUSR2 via psTree, so
// the backend usually already received SIGUSR2 directly. Forwarding is a
// redundant backup for missed delivery; the launcher then exits 140 after the
// backend exits, letting nodemon restart.
export function attachDevServerLifecycle({
  child,
  command,
  processRef = process,
  exitFn = (code) => process.exit(code),
  logger = console,
} = {}) {
  if (!child || typeof child.on !== 'function') {
    throw new Error('attachDevServerLifecycle requires a child process with .on()');
  }
  let settled = false;
  let pendingSignalCode = null;
  const executableLabel = command?.executable ?? 'dev server';
  const exitOnce = (code) => {
    if (settled) return;
    settled = true;
    exitFn(code);
  };

  child.on('error', (error) => {
    logger.error(
      `Error: failed to start dev server with ${executableLabel}: ${error instanceof Error ? error.message : String(error)}`,
    );
    exitOnce(1);
  });

  child.on('exit', (code, signal) => {
    if (pendingSignalCode !== null) {
      exitOnce(pendingSignalCode);
      return;
    }
    if (signal) {
      exitOnce(resolveSignalExitCode(signal));
      return;
    }
    exitOnce(typeof code === 'number' ? code : 1);
  });

  for (const signal of getLifecycleSignals(processRef)) {
    try {
      processRef.on(signal, () => {
        if (settled) return;
        if (pendingSignalCode === null) {
          pendingSignalCode = resolveSignalExitCode(signal);
        }
        forwardSignalToChild(child, signal);
      });
    } catch {
      // Unsupported signal on this platform (e.g. SIGUSR2 on Windows).
    }
  }

  return {
    getPendingSignalCode: () => pendingSignalCode,
    isSettled: () => settled,
  };
}

async function main({
  processRef = process,
  exitFn = (code) => process.exit(code),
  spawnFn = spawn,
  resolveFn = resolveServerExecutable,
  serverArgs = process.argv.slice(2),
  logger = console,
  env = processRef?.env ?? process.env,
} = {}) {
  let started;
  try {
    started = startDevServerChild({ spawnFn, resolveFn, serverArgs, env });
  } catch (error) {
    logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    exitFn(1);
    return;
  }
  const { command, child } = started;
  logger.log(`[pichamber] dev server runtime: ${command.runtime} (${command.executable})`);
  attachDevServerLifecycle({ child, command, processRef, exitFn, logger });
}

const isDevServerExecution = isModuleCliExecution(process.argv[1], import.meta.url, fs.realpathSync);

if (isDevServerExecution) {
  await main();
}

export { DEV_SERVER_PATH, buildDevServerCommand, resolveDevServerCommand, startDevServerChild };
