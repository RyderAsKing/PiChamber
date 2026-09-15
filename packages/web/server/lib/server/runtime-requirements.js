import { spawnSync } from 'node:child_process';
import path from 'node:path';

const MIN_NODE_VERSION = { major: 22, minor: 19, patch: 0 };
const MIN_BUN_VERSION = { major: 1, minor: 4, patch: 0 };
const MIN_NODE_VERSION_STRING = '22.19.0';
const MIN_BUN_VERSION_STRING = '1.4.0';
const RUNTIME_PROBE_TIMEOUT_MS = 5000;
export const NO_SUPPORTED_RUNTIME_MESSAGE =
  `No supported server runtime found. Install Node.js ${MIN_NODE_VERSION_STRING} or newer, or Bun ${MIN_BUN_VERSION_STRING} or newer.`;
const NODE_PROBE_BIN = 'node';

export function getBunBinary(env = process.env) {
  if (env && typeof env.BUN_BINARY === 'string' && env.BUN_BINARY.trim().length > 0) {
    return env.BUN_BINARY.trim();
  }
  if (env && typeof env.BUN_INSTALL === 'string' && env.BUN_INSTALL.trim().length > 0) {
    return path.join(env.BUN_INSTALL.trim(), 'bin', 'bun');
  }
  return 'bun';
}

function hasExplicitBunOverride(env = process.env) {
  if (!env || typeof env !== 'object') return false;
  return (typeof env.BUN_BINARY === 'string' && env.BUN_BINARY.trim().length > 0)
    || (typeof env.BUN_INSTALL === 'string' && env.BUN_INSTALL.trim().length > 0);
}

function isBunRuntime(host = globalThis) {
  return typeof host?.Bun !== 'undefined';
}

function compareVersion(parsed, minimum) {
  if (parsed.major !== minimum.major) return parsed.major - minimum.major;
  if (parsed.minor !== minimum.minor) return parsed.minor - minimum.minor;
  return parsed.patch - minimum.patch;
}

// Strict stable parser: accepts only `X.Y.Z` with an optional leading `v`.
// Rejects empty, truncated, prerelease (`-rc.1`, `-canary`), and build
// metadata (`+build`) shapes so old/malformed/prerelease runtimes fail.
function parseStableVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = trimmed.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return { major, minor, patch };
}

export function isSupportedNodeVersion(value) {
  const parsed = parseStableVersion(value);
  if (!parsed) return false;
  return compareVersion(parsed, MIN_NODE_VERSION) >= 0;
}

export function isSupportedBunVersion(value) {
  const parsed = parseStableVersion(value);
  if (!parsed) return false;
  return compareVersion(parsed, MIN_BUN_VERSION) >= 0;
}

function probeVersionOutput(bin, spawnSyncFn = spawnSync, timeoutMs = RUNTIME_PROBE_TIMEOUT_MS) {
  if (typeof bin !== 'string' || bin.trim().length === 0) return null;
  const runner = typeof spawnSyncFn === 'function' ? spawnSyncFn : spawnSync;
  try {
    const result = runner(bin.trim(), ['--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
      timeout: timeoutMs,
    });
    if (!result || result.error || result.status !== 0) return null;
    const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function resolveProbeTimeout(options = {}) {
  const candidate = options.probeTimeoutMs ?? options.timeoutMs ?? RUNTIME_PROBE_TIMEOUT_MS;
  return Number.isFinite(candidate) && candidate > 0 ? candidate : RUNTIME_PROBE_TIMEOUT_MS;
}

function getCurrentNodeExecutable(options = {}) {
  const isBun = options.isBun ?? isBunRuntime(options.globalRef ?? globalThis);
  if (isBun) return null;
  const nodeVersion = options.nodeVersion ?? process.version;
  if (!isSupportedNodeVersion(nodeVersion)) return null;
  const execPath = options.execPath ?? process.execPath;
  if (typeof execPath !== 'string' || execPath.trim().length === 0) return null;
  return execPath;
}

function getCurrentBunExecutable(options = {}) {
  const globalRef = options.globalRef ?? globalThis;
  const isBun = options.isBun ?? isBunRuntime(globalRef);
  if (!isBun) return null;
  const bunVersion = options.bunVersion ?? globalRef?.Bun?.version;
  if (!isSupportedBunVersion(bunVersion)) return null;
  const execPath = options.execPath ?? process.execPath;
  if (typeof execPath !== 'string' || execPath.trim().length === 0) return null;
  return execPath;
}

function findSupportedNodeExecutable(options = {}) {
  const current = getCurrentNodeExecutable(options);
  if (current) return current;
  const nodeBin = options.nodeBin ?? NODE_PROBE_BIN;
  const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
  // Bounded: probe errors (ENOENT, timeout, non-zero) return null so
  // resolution falls through to Bun instead of throwing.
  const probedVersion = probeVersionOutput(nodeBin, spawnSyncFn, resolveProbeTimeout(options));
  if (probedVersion && isSupportedNodeVersion(probedVersion)) return nodeBin;
  return null;
}

function isBunInstalled(options = {}) {
  const bunBin = options.bunBin ?? getBunBinary(options.env ?? process.env);
  const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
  const probedVersion = probeVersionOutput(bunBin, spawnSyncFn, resolveProbeTimeout(options));
  if (!probedVersion) return false;
  return isSupportedBunVersion(probedVersion);
}

function getCurrentRuntime(options = {}) {
  const globalRef = options.globalRef ?? globalThis;
  const isBun = options.isBun ?? isBunRuntime(globalRef);
  const execPath = options.execPath ?? process.execPath;
  const nodeVersion = options.nodeVersion ?? process.version;
  const bunVersion = options.bunVersion ?? globalRef?.Bun?.version;
  if (isBun) {
    return { kind: 'bun', isBun: true, bunVersion, nodeVersion, execPath };
  }
  return { kind: 'node', isBun: false, nodeVersion, bunVersion: undefined, execPath };
}

export function resolveServerExecutable(options = {}) {
  const nodeExecutable = findSupportedNodeExecutable(options);
  if (nodeExecutable) return { runtime: 'node', executable: nodeExecutable };
  const env = options.env ?? process.env;
  const bunBin = options.bunBin ?? getBunBinary(env);
  if (hasExplicitBunOverride(env)) {
    if (isBunInstalled({ ...options, bunBin })) return { runtime: 'bun', executable: bunBin };
    throw new Error(NO_SUPPORTED_RUNTIME_MESSAGE);
  }
  // No explicit override: prefer the current supported Bun executable before
  // probing PATH. bin/cli.js always passes a default BUN_BIN (`bun`) even
  // without overrides, so an explicit options.bunBin must not shadow a
  // supported off-PATH current Bun here. Explicit BUN_BINARY/BUN_INSTALL
  // already returned above.
  const currentBun = getCurrentBunExecutable(options);
  if (currentBun) return { runtime: 'bun', executable: currentBun };
  if (isBunInstalled({ ...options, bunBin })) return { runtime: 'bun', executable: bunBin };
  throw new Error(NO_SUPPORTED_RUNTIME_MESSAGE);
}

// Explicit foreground, startup enable, and in-process server startup validate
// only the current executable. They never probe PATH and never silently
// switch runtimes, so a supported absolute Bun exec works with an empty PATH
// and an old/malformed/prerelease current runtime fails deterministically.
export function assertCurrentRuntimeSupported(options = {}) {
  const current = getCurrentRuntime(options);
  const execPath = typeof current.execPath === 'string' ? current.execPath.trim() : '';
  if (execPath.length === 0) {
    throw new Error(`${NO_SUPPORTED_RUNTIME_MESSAGE} (missing runtime executable)`);
  }
  if (current.kind === 'bun') {
    if (isSupportedBunVersion(current.bunVersion)) {
      return { runtime: 'bun', executable: execPath };
    }
    const actual = typeof current.bunVersion === 'string' && current.bunVersion.trim().length > 0
      ? current.bunVersion.trim()
      : 'unknown';
    throw new Error(
      `Unsupported server runtime: Bun ${actual} is not supported. Install Bun ${MIN_BUN_VERSION_STRING} or newer, or Node.js ${MIN_NODE_VERSION_STRING} or newer.`,
    );
  }
  if (isSupportedNodeVersion(current.nodeVersion)) {
    return { runtime: 'node', executable: execPath };
  }
  const actual = typeof current.nodeVersion === 'string' && current.nodeVersion.trim().length > 0
    ? current.nodeVersion.trim()
    : 'unknown';
  throw new Error(
    `Unsupported server runtime: Node.js ${actual} is not supported. Install Node.js ${MIN_NODE_VERSION_STRING} or newer, or Bun ${MIN_BUN_VERSION_STRING} or newer.`,
  );
}
