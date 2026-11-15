import { createHash } from 'node:crypto';
import { posix } from 'node:path';

/**
 * Sandbox launcher contract (see ../session-daemon/DOCUMENTATION.md).
 *
 * A launcher turns a daemon launch request into a command:
 *
 *   {
 *     id, platforms, transport: 'local-socket',
 *     probe(): Promise<{ available: true, version, capabilities } | { available: false, code }>,
 *     identity({ grants, network }): string,
 *     prepare({ argv, env, cwd, grants, network, tmpDir }): Promise<{ command, args, env, cleanup? }>,
 *   }
 *
 * Grants are structured, never raw user strings:
 *   { kind: 'read' | 'readWrite', path }          folder, recursive
 *   { kind: 'readFile' | 'readWriteFile', path }  single file
 *   { kind: 'unixSocketBind', dir }               bind sockets in a folder
 * Network:
 *   { mode: 'proxy', allowHosts: string[], allowLocalPorts: number[] } | { mode: 'none' }
 */

export class SandboxLaunchError extends Error {
  constructor(code) {
    super('The sandbox launch request is invalid.');
    this.code = code;
  }
}

const GRANT_KINDS = new Set(['read', 'readWrite', 'readFile', 'readWriteFile', 'unixSocketBind']);
const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const normalizePath = (value) => {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\0\n\r]/.test(value)) {
    throw new SandboxLaunchError('SANDBOX_INVALID_GRANT');
  }
  const normalized = posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

/** Validated, de-duplicated grants in a stable order. */
export const normalizeGrants = (grants) => {
  if (!Array.isArray(grants)) throw new SandboxLaunchError('SANDBOX_INVALID_GRANT');
  const seen = new Map();
  for (const grant of grants) {
    if (!grant || !GRANT_KINDS.has(grant.kind)) throw new SandboxLaunchError('SANDBOX_INVALID_GRANT');
    const path = normalizePath(grant.kind === 'unixSocketBind' ? grant.dir : grant.path);
    seen.set(`${grant.kind}\0${path}`, { kind: grant.kind, path });
  }
  return [...seen.values()].sort((a, b) => (a.kind === b.kind
    ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    : (a.kind < b.kind ? -1 : 1)));
};

export const normalizeNetwork = (network) => {
  if (network?.mode === 'none') return { mode: 'none' };
  if (network?.mode !== 'proxy') throw new SandboxLaunchError('SANDBOX_INVALID_NETWORK');
  const hosts = (network.allowHosts ?? []).map((host) => {
    const value = typeof host === 'string' ? host.trim().toLowerCase() : '';
    if (!HOST_PATTERN.test(value)) throw new SandboxLaunchError('SANDBOX_INVALID_NETWORK');
    return value;
  });
  const ports = (network.allowLocalPorts ?? []).map((port) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SandboxLaunchError('SANDBOX_INVALID_NETWORK');
    return port;
  });
  return {
    mode: 'proxy',
    allowHosts: [...new Set(hosts)].sort(),
    allowLocalPorts: [...new Set(ports)].sort((a, b) => a - b),
  };
};

/**
 * Short hash of everything that shapes a sandbox: launcher, its version, its
 * policy file, grants and network. It goes into the daemon profile key, so a
 * change in any of them starts a new daemon instead of reusing an old one.
 */
export const launchIdentity = ({ launcher, version, profile, grants, network }) => createHash('sha256')
  .update(JSON.stringify({
    launcher,
    version,
    profile,
    grants: normalizeGrants(grants),
    network: normalizeNetwork(network),
  }))
  .digest('hex')
  .slice(0, 12);
