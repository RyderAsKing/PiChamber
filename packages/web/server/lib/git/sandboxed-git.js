import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Where git for a sandboxed project runs (#248). The server sets a resolver
 * that maps a folder to its project's sandbox:
 *
 *   resolver(directory) -> null                      unsandboxed: git runs as before
 *                        | { binDir, prepare }        sandboxed: git runs through the launcher
 *                        | throws SANDBOX_UNAVAILABLE  sandboxed, launcher unusable: git does not run
 *
 * `prepare({ argv, env })` returns `{ command, args, env }`, the launcher's
 * short-lived sandboxed process. `binDir` is a folder the sandbox cannot
 * write; the git wrapper script simple-git runs lives there.
 *
 * The resolver is module state set once by the server (`index.js`, from
 * the sandbox manager's `gitSandboxForDirectory`), not injected: every
 * git process goes through `service.js`, a module of free functions used
 * directly by the git, fs, GitHub and STT routes, so injecting it would
 * turn that whole module into a factory. Without a resolver (tests, a
 * server with no sandbox manager) git runs unsandboxed.
 */
let resolver = null;

export const setGitSandboxResolver = (next) => {
  resolver = typeof next === 'function' ? next : null;
};

const resolveDirectory = (directory) => {
  const value = String(directory || '').trim();
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
};

const sandboxFor = async (directory) => (resolver ? resolver(resolveDirectory(directory)) : null);

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const writeWrapper = async (binDir, command, args) => {
  const content = `#!/bin/sh\nexec ${[command, ...args].map(shellQuote).join(' ')} "$@"\n`;
  const name = `git-${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
  const target = path.join(binDir, name);
  try {
    if (await readFile(target, 'utf8') === content) return target;
  } catch {
    // not written yet
  }
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o700 });
  await chmod(temporary, 0o700);
  await rename(temporary, target);
  return target;
};

/**
 * The git binary and environment for a folder. Unsandboxed folders get the
 * inputs back; sandboxed ones get a wrapper that starts git through the
 * launcher, so repo config (core.fsmonitor, hooks, aliases) runs sandboxed.
 */
export const resolveGitInvocation = async (directory, { binary, env }) => {
  const sandbox = await sandboxFor(directory);
  if (!sandbox) return { binary, env, sandboxed: false };
  const prepared = await sandbox.prepare({ argv: [binary], env });
  return { binary: await writeWrapper(sandbox.binDir, prepared.command, prepared.args), env: prepared.env, sandboxed: true };
};

/**
 * A non-git command (a repo hook, a worktree start command) for a folder:
 * `{ command, args, env }` through the launcher when the folder is sandboxed,
 * unchanged otherwise.
 */
export const resolveProjectCommand = async (directory, { command, args, env }) => {
  const sandbox = await sandboxFor(directory);
  if (!sandbox) return { command, args, env };
  return sandbox.prepare({ argv: [command, ...args], env });
};

/** Throws SANDBOX_UNAVAILABLE when a folder's project sandbox cannot run git. */
export const assertGitSandboxUsable = async (directory) => {
  if (typeof directory !== 'string' || !directory.trim()) return;
  await sandboxFor(directory);
};
