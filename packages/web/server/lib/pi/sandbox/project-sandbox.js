import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readlink, rm, stat, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPiSessionDirectory } from '../session-daemon/session-jsonl.js';
import { scopedLeaseDir } from '../session-daemon/session-lease.js';
import { normalizeNetwork, SandboxLaunchError } from './launcher.js';

// Pi reads these single files from its agent folder. They are granted
// read-only on the real file and reached through a symlink in the shadow
// folder, so Pi's lock folders land in the shadow, not beside the real file.
const PI_CONFIG_FILES = ['settings.json', 'auth.json', 'models.json', 'trust.json', 'mcp.json'];
const PI_RESOURCE_FOLDERS = ['extensions', 'prompts', 'themes', 'skills', 'tools', 'bin'];
const REFUSED_PORTS = new Set([80, 443]);

const WEB_PACKAGE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const isWithin = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const overlaps = (a, b) => isWithin(a, b) || isWithin(b, a);

const sandboxProjectKey = (projectRoot) => createHash('sha256')
  .update(resolve(projectRoot))
  .digest('hex')
  .slice(0, 12);

const realpathOr = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Folders the daemon process itself needs to read: the runtime (the real
 * Node install prefix, or the Electron app folder) and the PiChamber install
 * with the Pi SDK.
 */
const resolveDaemonReadRoots = ({
  execPath = process.execPath,
  electron = Boolean(process.versions?.electron),
  resolveSdk = () => fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')),
} = {}) => {
  const runtime = realpathOr(execPath);
  const roots = [electron ? dirname(runtime) : dirname(dirname(runtime))];
  const webRoot = realpathOr(WEB_PACKAGE_ROOT);
  roots.push(webRoot);
  const sdk = realpathOr(resolveSdk());
  if (!isWithin(webRoot, sdk)) {
    // Hoisted or isolated installs keep dependencies in an outer
    // node_modules; grant the outermost one that holds the SDK.
    const marker = `${sep}node_modules${sep}`;
    const index = sdk.indexOf(marker);
    if (index > 0) roots.push(sdk.slice(0, index + marker.length - 1));
  }
  return [...new Set(roots)];
};

const ensureSymlink = async (linkPath, target) => {
  try {
    const info = await lstat(linkPath);
    // Never delete real content (for example transcripts) to make room.
    if (!info.isSymbolicLink()) throw new SandboxLaunchError('SANDBOX_SHADOW_CONFLICT');
    if (await readlink(linkPath) === target) return;
    await rm(linkPath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(linkPath), { recursive: true, mode: 0o700 });
  await symlink(target, linkPath);
};

/**
 * Build the launch request for one sandboxed project: grants, network,
 * the shadow Pi agent folder and the private temp folder. Creates the
 * folders it grants, so nono never sees a missing path.
 */
export const prepareProjectSandbox = async ({
  dataDir,
  agentDir,
  projectRoot,
  projectId,
  worktreeDirs = [],
  serverPort,
  readRoots = resolveDaemonReadRoots(),
  extraFolders = [],
  allowHosts = [],
  allowLocalPorts = [],
}) => {
  if (![dataDir, agentDir, projectRoot].every((value) => typeof value === 'string' && isAbsolute(value))) {
    throw new SandboxLaunchError('SANDBOX_INVALID_GRANT');
  }
  for (const port of allowLocalPorts) {
    if (REFUSED_PORTS.has(port) || port === serverPort) throw new SandboxLaunchError('SANDBOX_PORT_REFUSED');
  }
  const network = normalizeNetwork({ mode: 'proxy', allowHosts, allowLocalPorts });
  for (const extra of extraFolders) {
    if (typeof extra?.path !== 'string' || !isAbsolute(extra.path) || !['read', 'readWrite'].includes(extra.access)) {
      throw new SandboxLaunchError('SANDBOX_INVALID_GRANT');
    }
  }
  // PiChamber's data folder and the Pi agent folder hold credentials, other
  // projects' state and code the server runs. Nothing granted may reach
  // them, by name or through a symlink: a grant follows links, and the
  // agent can replace a folder inside its project with one.
  const protectedDirs = [...new Set([dataDir, agentDir].flatMap((path) => [resolve(path), realpathOr(path)]))];
  const spellings = (path) => [...new Set([resolve(path), realpathOr(path)])];
  for (const extra of extraFolders) {
    if (spellings(extra.path).some((path) => protectedDirs.some((dir) => overlaps(path, dir)))) {
      throw new SandboxLaunchError('SANDBOX_GRANT_REFUSED');
    }
  }
  // The project folder is granted read-write as a whole, so it must not
  // hold either folder (a home folder as a project would), nor sit inside
  // one, except as a PiChamber worktree.
  const worktreeBases = spellings(join(dataDir, 'worktree'));
  for (const root of spellings(projectRoot)) {
    const inWorktrees = worktreeBases.some((base) => isWithin(base, root) && root !== base);
    if (protectedDirs.some((dir) => isWithin(root, dir) || (isWithin(dir, root) && !inWorktrees))) {
      throw new SandboxLaunchError('SANDBOX_GRANT_REFUSED');
    }
  }

  const projectKey = sandboxProjectKey(projectRoot);
  const sandboxRoot = join(dataDir, 'pi', 'sandbox', projectKey);
  const shadowDir = join(sandboxRoot, 'agent');
  const tmpDir = join(sandboxRoot, 'tmp');
  // A cache of its own: the user's cache folders hold code that tools
  // outside the sandbox run later (browser builds, package managers), so
  // the sandbox is never given them.
  const cacheDir = join(sandboxRoot, 'cache');
  // The project's own lease folder. The shared one holds every other
  // project's live sessions and is not granted.
  const leaseDir = scopedLeaseDir(agentDir, projectKey);
  await Promise.all([shadowDir, tmpDir, cacheDir, leaseDir].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));

  const grants = [
    { kind: 'readWrite', path: projectRoot },
    { kind: 'readWrite', path: shadowDir },
    { kind: 'readWrite', path: tmpDir },
    { kind: 'readWrite', path: cacheDir },
    { kind: 'readWrite', path: leaseDir },
    ...readRoots.map((path) => ({ kind: 'read', path })),
  ];
  await ensureSymlink(join(shadowDir, '.pichamber', 'locks', 'sessions'), leaseDir);

  if (typeof projectId === 'string' && /^[A-Za-z0-9_-]+$/.test(projectId)) {
    const worktreeRoot = join(dataDir, 'worktree', projectId);
    await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
    grants.push({ kind: 'readWrite', path: worktreeRoot });
  }

  // Only this project's own session folders, never the sessions/ parent.
  for (const cwd of [projectRoot, ...worktreeDirs]) {
    const real = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(real, { recursive: true, mode: 0o700 });
    await ensureSymlink(getPiSessionDirectory({ cwd, agentDir: shadowDir }), real);
    grants.push({ kind: 'readWrite', path: real });
  }

  for (const name of PI_CONFIG_FILES) {
    const real = join(agentDir, name);
    if (!await exists(real)) continue;
    await ensureSymlink(join(shadowDir, name), real);
    grants.push({ kind: 'readFile', path: real });
  }
  for (const name of PI_RESOURCE_FOLDERS) {
    const real = join(agentDir, name);
    if (!await exists(real)) continue;
    await ensureSymlink(join(shadowDir, name), real);
    grants.push({ kind: 'read', path: real });
  }

  for (const extra of extraFolders) grants.push({ kind: extra.access, path: extra.path });

  return { projectKey, cwd: projectRoot, agentDir: shadowDir, leaseAgentDir: resolve(agentDir), leaseScope: projectKey, tmpDir, cacheDir, grants, network };
};
