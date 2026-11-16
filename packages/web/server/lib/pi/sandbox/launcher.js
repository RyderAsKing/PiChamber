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

// Hosts a sandboxed agent may reach through nono's proxy. The PiChamber
// server's own API is on the same machine, so anything that could name it
// (loopback, local names, raw IPs) is refused, as are names too broad or
// too long to be public host names.
const isRefusedHost = (value) => {
  const name = value.startsWith('*.') ? value.slice(2) : value;
  if (value.length > 253) return true;
  const labels = name.split('.');
  // One label (`localhost`, `com`), or one label under a wildcard (`*.com`).
  if (labels.length < 2) return true;
  if (labels.some((label) => label.length > 63)) return true;
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')) return true;
  // IP literals in any spelling a resolver takes (`127.0.0.1`, `1.2.3.0x4`):
  // no public top-level name starts with a digit.
  if (/^\d/.test(labels[labels.length - 1])) return true;
  return false;
};

/** Whether `host` is a name `normalizeNetwork` accepts as an allowed host. */
export const isAllowedSandboxHost = (host) => {
  const value = typeof host === 'string' ? host.trim().toLowerCase() : '';
  return HOST_PATTERN.test(value) && !isRefusedHost(value);
};

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
    if (!isAllowedSandboxHost(host)) throw new SandboxLaunchError('SANDBOX_INVALID_NETWORK');
    return host.trim().toLowerCase();
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
