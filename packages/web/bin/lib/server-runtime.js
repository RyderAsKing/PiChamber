import { spawnSync } from 'node:child_process';
import path from 'node:path';

const MIN_SUPPORTED_NODE_MAJOR = 22;
export const NO_SUPPORTED_RUNTIME_MESSAGE =
  'No supported server runtime found. Install Node.js 22 or newer, or Bun.';
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

function isBunRuntime(host = globalThis) {
  return typeof host.Bun !== 'undefined';
}

export function parseNodeMajorVersion(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^v?(\d+)/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}

export function isSupportedNodeVersion(value) {
  const major = parseNodeMajorVersion(value);
  return major !== null && major >= MIN_SUPPORTED_NODE_MAJOR;
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

function probeNodeVersion(nodeBin = NODE_PROBE_BIN, spawnSyncFn = spawnSync) {
  try {
    const result = spawnSyncFn(nodeBin, ['--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
    });
    if (!result || result.status !== 0) return null;
    const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function isBunInstalled(options = {}) {
  const bunBin = options.bunBin ?? getBunBinary(options.env ?? process.env);
  const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
  try {
    const result = spawnSyncFn(bunBin, ['--version'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return result?.status === 0;
  } catch {
    return false;
  }
}

export function findSupportedNodeExecutable(options = {}) {
  const current = getCurrentNodeExecutable(options);
  if (current) return current;
  const nodeBin = options.nodeBin ?? NODE_PROBE_BIN;
  const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
  const probedVersion = probeNodeVersion(nodeBin, spawnSyncFn);
  if (probedVersion && isSupportedNodeVersion(probedVersion)) return nodeBin;
  return null;
}

export function getPreferredServerRuntime(options = {}) {
  if (findSupportedNodeExecutable(options)) return 'node';
  if (isBunInstalled(options)) return 'bun';
  throw new Error(NO_SUPPORTED_RUNTIME_MESSAGE);
}

export function resolveServerExecutable(options = {}) {
  const nodeExecutable = findSupportedNodeExecutable(options);
  if (nodeExecutable) return { runtime: 'node', executable: nodeExecutable };
  const bunBin = options.bunBin ?? getBunBinary(options.env ?? process.env);
  if (isBunInstalled({ ...options, bunBin })) return { runtime: 'bun', executable: bunBin };
  throw new Error(NO_SUPPORTED_RUNTIME_MESSAGE);
}
