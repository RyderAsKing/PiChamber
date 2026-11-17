import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchIdentity, normalizeGrants, normalizeNetwork, SandboxLaunchError } from './launcher.js';

const NONO_MIN_VERSION = '0.82.0';
// Landlock V4 filters TCP. Below it nono cannot hold a WSL2 sandbox to its
// proxy (WSL2 also lacks the seccomp fallback), so domain rules would not
// be enforced.
const MIN_WSL2_LANDLOCK_ABI = 4;
export const NONO_PROFILE_FILE = fileURLToPath(new URL('./nono-profile.json', import.meta.url));
// One policy per host kind. WSL2 drops `linux.af_unix_mediation`, which
// needs seccomp user notification and makes nono refuse to start there;
// macOS uses Seatbelt's groups and paths.
export const NONO_PROFILE_FILES = Object.freeze({
  linux: NONO_PROFILE_FILE,
  wsl2: fileURLToPath(new URL('./nono-profile-wsl2.json', import.meta.url)),
  macos: fileURLToPath(new URL('./nono-profile-macos.json', import.meta.url)),
});
// What the sandbox cannot enforce on each host kind. WSL2 has no seccomp
// user notification (init holds the only listener), so:
// - pathname Unix sockets stay reachable, and code in the sandbox can ask a
//   local service (systemd user manager, D-Bus, an agent or Docker socket) to
//   act outside it;
// - Landlock filters TCP by port only, and nono's seccomp check of the
//   destination is missing, so the proxy's port is open to every host.
const HOST_LIMITS = Object.freeze({ linux: [], wsl2: ['UNIX_SOCKETS', 'PROXY_PORT'], macos: [] });
const WSL_PATTERN = /microsoft|wsl/i;

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_ENV = { NONO_NO_UPDATE_CHECK: '1', NONO_NO_SAVE_PROMPT: '1' };

/**
 * Point the tools an agent runs at the sandbox's own cache folder. The
 * profiles grant no user cache folder (`~/.cache`, `~/Library/Caches`):
 * what is cached there is run later by tools outside the sandbox. Tools
 * that follow `XDG_CACHE_HOME` need nothing else; the rest are named.
 */
const cacheEnv = (cacheDir) => ({
  XDG_CACHE_HOME: cacheDir,
  npm_config_cache: join(cacheDir, 'npm'),
  YARN_CACHE_FOLDER: join(cacheDir, 'yarn'),
  BUN_INSTALL_CACHE_DIR: join(cacheDir, 'bun'),
  COREPACK_HOME: join(cacheDir, 'node', 'corepack'),
  PIP_CACHE_DIR: join(cacheDir, 'pip'),
  UV_CACHE_DIR: join(cacheDir, 'uv'),
  PRE_COMMIT_HOME: join(cacheDir, 'pre-commit'),
  GOCACHE: join(cacheDir, 'go-build'),
  PLAYWRIGHT_BROWSERS_PATH: join(cacheDir, 'ms-playwright'),
});

const runFile = (execFile, command, args, env) => new Promise((resolve) => {
  execFile(command, args, { env, timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
    resolve({
      error,
      code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
      spawnCode: error && typeof error.code === 'string' ? error.code : null,
      stdout: `${stdout ?? ''}`,
      output: `${stdout ?? ''}\n${stderr ?? ''}`,
    });
  });
});

const parseVersion = (output) => {
  const match = /\bnono\s+v?(\d+)\.(\d+)\.(\d+)\b/i.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

const compareVersions = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};

const defaultReadProcVersion = async () => {
  try {
    return await readFile('/proc/version', 'utf8');
  } catch {
    return '';
  }
};

// Electron reads files inside app.asar through its patched fs; nono is a
// separate binary and sees only the archive file.
const ASAR_SEGMENT = /[\\/][^\\/]+\.asar(?:[\\/]|$)/i;

/**
 * The profile path to hand nono. A profile inside an asar archive (packaged
 * desktop) is copied to a real file under `stageDir`, named by its content
 * hash so a changed policy never reuses an old copy.
 */
const createProfileResolver = ({ profileFile, profileContent, profileHash, stageDir }) => {
  if (!ASAR_SEGMENT.test(profileFile)) return async () => profileFile;
  // One staging at a time: concurrent first launches would share the
  // temporary file and the second rename would fail. A failure is retried.
  let staging = null;
  const stage = async () => {
    if (typeof stageDir !== 'string' || !stageDir.startsWith('/')) {
      throw new SandboxLaunchError('SANDBOX_PROFILE_UNREADABLE');
    }
    try {
      await mkdir(stageDir, { recursive: true, mode: 0o700 });
      const target = join(stageDir, `nono-profile-${profileHash.slice(0, 12)}.json`);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, profileContent, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      return target;
    } catch {
      throw new SandboxLaunchError('SANDBOX_PROFILE_UNREADABLE');
    }
  };
  return () => {
    staging ??= stage().catch((error) => {
      staging = null;
      throw error;
    });
    return staging;
  };
};

const GRANT_FLAGS = {
  read: '--read',
  readWrite: '--allow',
  readFile: '--read-file',
  readWriteFile: '--allow-file',
  unixSocketBind: '--allow-unix-socket-dir-bind',
};

// On Linux a connect-port grant applies to that port on every host and
// bypasses the proxy for it, so the web ports would defeat the host allowlist.
const REFUSED_PORTS = new Set([80, 443]);

const networkFlags = (network, hostKind) => {
  if (network.mode === 'none') return ['--block-net'];
  for (const port of network.allowLocalPorts) {
    if (REFUSED_PORTS.has(port)) throw new SandboxLaunchError('SANDBOX_PORT_REFUSED');
  }
  const hosts = network.allowHosts.flatMap((host) => ['--allow-domain', host]);
  if (hostKind === 'macos') {
    // Seatbelt cannot filter TCP by port, so nono refuses
    // `--allow-connect-port` there. `--open-port` allows that port on
    // localhost only; Seatbelt then allows binding and inbound connections
    // on any port. Blocked mode keeps those localhost rules, so with no
    // allowed host the network is still blocked apart from the ports.
    const ports = network.allowLocalPorts.flatMap((port) => ['--open-port', String(port)]);
    return hosts.length > 0 ? [...hosts, ...ports] : ['--block-net', ...ports];
  }
  const ports = network.allowLocalPorts.flatMap((port) => ['--allow-connect-port', String(port)]);
  if (hosts.length > 0) return [...hosts, ...ports];
  // Without an allowed host nono starts no proxy. Port grants alone still
  // limit TCP to those ports; with neither, nothing may leave the sandbox.
  return ports.length > 0 ? ports : ['--block-net'];
};

const loadProfile = (profileFile, stageDir) => {
  const profileContent = readFileSync(profileFile);
  const profileHash = createHash('sha256').update(profileContent).digest('hex');
  return {
    file: profileFile,
    content: profileContent.toString('utf8'),
    hash: profileHash,
    resolve: createProfileResolver({ profileFile, profileContent, profileHash, stageDir }),
  };
};

// A profile is a few hundred bytes of policy; anything near this is not one.
const NONO_PROFILE_MAX_BYTES = 64 * 1024;
const MAX_PROFILE_MESSAGES = 8;
const MAX_PROFILE_MESSAGE_LENGTH = 600;

/** A custom profile that cannot be used. `messages` are for the owner: what
 *  nono (or the JSON parser) said is wrong with the text. */
class NonoProfileError extends Error {
  constructor(messages = []) {
    super('The nono profile is not valid.');
    this.name = 'NonoProfileError';
    this.code = 'INVALID_SANDBOX_PROFILE';
    this.messages = messages
      .filter((message) => typeof message === 'string' && message.trim().length > 0)
      .slice(0, MAX_PROFILE_MESSAGES)
      .map((message) => message.trim().slice(0, MAX_PROFILE_MESSAGE_LENGTH));
  }
}

/**
 * The owner's custom profile, or null when there is none. Read as a small
 * regular file and never through a symlink. A file that is there but cannot
 * be read this way throws: the launcher then refuses to start a sandbox
 * instead of quietly using the built-in profile the owner replaced.
 */
const readCustomProfile = (file) => {
  let handle;
  try {
    handle = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new SandboxLaunchError('SANDBOX_PROFILE_INVALID');
  }
  try {
    const stats = fstatSync(handle);
    if (!stats.isFile() || stats.size > NONO_PROFILE_MAX_BYTES) throw new SandboxLaunchError('SANDBOX_PROFILE_INVALID');
    const buffer = Buffer.alloc(stats.size);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(handle, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    const content = buffer.subarray(0, read);
    return { content: content.toString('utf8'), hash: createHash('sha256').update('custom\n').update(content).digest('hex') };
  } catch (error) {
    if (error instanceof SandboxLaunchError) throw error;
    throw new SandboxLaunchError('SANDBOX_PROFILE_INVALID');
  } finally {
    closeSync(handle);
  }
};

const isJsonObject = (text) => {
  try {
    const value = JSON.parse(text);
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
};

/**
 * nono launcher: runs the daemon under `nono run` with PiChamber's static
 * profile for this host kind (Linux, WSL2 or macOS). Every path arrives as a
 * per-launch flag built from structured grants; the profile file holds only
 * policy.
 */
export const createNonoLauncher = ({
  command = 'nono',
  platform = process.platform,
  execFile = execFileCallback,
  readProcVersion = defaultReadProcVersion,
  profileFiles = NONO_PROFILE_FILES,
  // One file for every host kind (tests).
  profileFile,
  // A real folder for the profile copy when a profile sits inside an asar
  // archive (`<dataDir>/pi/sandbox`).
  stageDir,
  // The owner's own profile, used in place of the built-in one while the
  // file exists (`<dataDir>/pi/sandbox/nono-profile.custom.json`). It must
  // sit where no sandbox can write.
  customProfileFile,
  env = process.env,
} = {}) => {
  const profiles = new Map(Object.keys(HOST_LIMITS).map((hostKind) => [
    hostKind,
    loadProfile(profileFile ?? profileFiles[hostKind], stageDir),
  ]));
  const profileFor = (hostKind) => profiles.get(hostKind);
  // Set by a successful probe: the nono version and the host kind whose
  // profile every launch uses.
  let probed = null;
  // Custom profile hashes nono has accepted, so a launch checks each text once.
  const acceptedCustom = new Set();

  const detectHostKind = async () => (platform === 'darwin'
    ? 'macos'
    : platform === 'linux'
      ? (WSL_PATTERN.test(await readProcVersion()) ? 'wsl2' : 'linux')
      : null);

  /** The profile launches use: the custom file while it exists. */
  const activeProfile = (hostKind) => {
    const custom = customProfileFile ? readCustomProfile(customProfileFile) : null;
    return custom
      ? { custom: true, hash: custom.hash, content: custom.content, resolve: async () => customProfileFile }
      : { custom: false, ...profileFor(hostKind) };
  };

  /**
   * Ask nono whether a profile file is valid. `null` when nono could not
   * answer (not installed, or output that is not its report), otherwise
   * `{ valid, messages }`.
   */
  const validateProfileFile = async (file) => {
    const run = await runFile(execFile, command, ['profile', 'validate', '--json', file], { ...env, ...PROBE_ENV });
    if (run.spawnCode) return null;
    let report;
    try {
      report = JSON.parse(run.stdout);
    } catch {
      return null;
    }
    if (typeof report?.valid !== 'boolean') return null;
    return { valid: report.valid, messages: Array.isArray(report.errors) ? report.errors : [] };
  };

  const probe = async () => {
    probed = null;
    const hostKind = await detectHostKind();
    if (!hostKind) return { available: false, code: 'UNSUPPORTED_PLATFORM' };

    const probeEnv = { ...env, ...PROBE_ENV };
    const versionRun = await runFile(execFile, command, ['--version'], probeEnv);
    if (versionRun.spawnCode === 'ENOENT') return { available: false, code: 'NOT_INSTALLED' };
    if (versionRun.error) return { available: false, code: 'VERSION_UNKNOWN' };
    const version = parseVersion(versionRun.output);
    if (!version) return { available: false, code: 'VERSION_UNKNOWN' };
    if (compareVersions(version, NONO_MIN_VERSION.split('.').map(Number)) < 0) {
      return { available: false, code: 'TOO_OLD' };
    }

    const setupRun = await runFile(execFile, command, ['setup', '--check-only'], probeEnv);
    let capability;
    if (hostKind === 'macos') {
      if (setupRun.code !== 0 || !/Seatbelt sandbox support verified/i.test(setupRun.output)) {
        return { available: false, code: 'SETUP_CHECK_FAILED' };
      }
      capability = 'seatbelt';
    } else {
      if (setupRun.code !== 0) {
        return { available: false, code: /landlock is not available/i.test(setupRun.output) ? 'NO_LANDLOCK' : 'SETUP_CHECK_FAILED' };
      }
      const abi = /Landlock V(\d+)/.exec(setupRun.output);
      if (!abi) return { available: false, code: 'NO_LANDLOCK' };
      if (hostKind === 'wsl2' && Number(abi[1]) < MIN_WSL2_LANDLOCK_ABI) return { available: false, code: 'WSL_KERNEL_TOO_OLD' };
      capability = `landlock-abi-${abi[1]}`;
    }

    probed = { version: version.join('.'), hostKind };
    const limits = HOST_LIMITS[hostKind];
    return {
      available: true,
      version: probed.version,
      capabilities: [capability],
      ...(limits.length > 0 ? { limits: [...limits] } : {}),
    };
  };

  const requireProbe = () => {
    if (!probed) throw new SandboxLaunchError('SANDBOX_NOT_PROBED');
    return probed;
  };

  const identity = (request) => {
    const { version, hostKind } = requireProbe();
    return launchIdentity({
      launcher: 'nono',
      version,
      profile: activeProfile(hostKind).hash,
      grants: request.grants,
      network: request.network,
    });
  };

  const prepare = async ({ argv, env: childEnv = {}, grants, network, tmpDir, cacheDir }) => {
    const { hostKind } = requireProbe();
    if (!Array.isArray(argv) || argv.length === 0) throw new SandboxLaunchError('SANDBOX_INVALID_COMMAND');
    if (typeof tmpDir !== 'string' || !tmpDir.startsWith('/')) throw new SandboxLaunchError('SANDBOX_INVALID_GRANT');
    if (cacheDir !== undefined && (typeof cacheDir !== 'string' || !cacheDir.startsWith('/'))) throw new SandboxLaunchError('SANDBOX_INVALID_GRANT');
    const grantFlags = normalizeGrants(grants).flatMap((grant) => [GRANT_FLAGS[grant.kind], grant.path]);
    const profile = activeProfile(hostKind);
    if (profile.custom && !acceptedCustom.has(profile.hash)) {
      // Edited on disk since nono last saw it: a profile nono refuses must
      // read as a profile problem, not as a daemon that failed to start.
      const report = isJsonObject(profile.content) ? await validateProfileFile(customProfileFile) : { valid: false };
      if (report && !report.valid) throw new SandboxLaunchError('SANDBOX_PROFILE_INVALID');
      if (report) acceptedCustom.add(profile.hash);
    }
    const readableProfile = await profile.resolve();
    return {
      command,
      args: [
        'run', '-s', '--profile', readableProfile, '--no-rollback', '--no-audit', '--no-diagnostics',
        ...grantFlags,
        ...networkFlags(normalizeNetwork(network), hostKind),
        '--', ...argv,
      ],
      env: { ...childEnv, ...(cacheDir ? cacheEnv(cacheDir) : {}), NONO_NO_SAVE_PROMPT: '1', NONO_NO_UPDATE_CHECK: '1', TMPDIR: tmpDir },
    };
  };

  /**
   * The profile in use on this host, for Settings: the built-in file for
   * this host kind, the custom file's place, which of them launches use, and
   * that one's text. Null on a platform nono does not run on.
   */
  const profile = async () => {
    const hostKind = probed?.hostKind ?? await detectHostKind();
    if (!hostKind) return null;
    const builtIn = profileFor(hostKind);
    const base = { hostKind, builtInPath: builtIn.file, customPath: customProfileFile ?? null };
    let custom;
    try {
      custom = customProfileFile ? readCustomProfile(customProfileFile) : null;
    } catch {
      // There, but not a file PiChamber will read: sandboxes do not start.
      return { ...base, custom: true, unreadable: true, path: customProfileFile, content: '', hash: 'unreadable' };
    }
    return custom
      ? { ...base, custom: true, path: customProfileFile, content: custom.content, hash: custom.hash }
      : { ...base, custom: false, path: builtIn.file, content: builtIn.content, hash: builtIn.hash };
  };

  /**
   * Save the owner's profile text as the custom profile. Refused with
   * `NonoProfileError` unless it is a JSON object nono accepts; when nono is
   * not installed only the JSON is checked, and a launch checks the rest.
   * The text is checked in a temporary file beside the target and renamed
   * over it, so launches never see a half-written or refused profile.
   */
  const saveProfile = async (content) => {
    if (!customProfileFile) throw new SandboxLaunchError('SANDBOX_PROFILE_UNREADABLE');
    if (typeof content !== 'string' || content.trim().length === 0) throw new NonoProfileError(['The profile is empty.']);
    if (Buffer.byteLength(content) > NONO_PROFILE_MAX_BYTES) throw new NonoProfileError(['The profile is too large.']);
    try {
      const value = JSON.parse(content);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NonoProfileError(['The profile must be a JSON object.']);
    } catch (error) {
      if (error instanceof NonoProfileError) throw error;
      throw new NonoProfileError([`The profile is not valid JSON: ${error?.message ?? 'syntax error'}`]);
    }
    const folder = dirname(customProfileFile);
    const temporary = join(folder, `nono-profile.check-${process.pid}-${Date.now()}.json`);
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      const report = await validateProfileFile(temporary);
      if (report && !report.valid) {
        // nono names the file it checked; the owner knows it as the profile.
        throw new NonoProfileError(report.messages.map((message) => (
          typeof message === 'string' ? message.split(temporary).join('the profile') : message)));
      }
      await rename(temporary, customProfileFile);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (error instanceof NonoProfileError) throw error;
      throw new SandboxLaunchError('SANDBOX_PROFILE_UNREADABLE');
    }
    return profile();
  };

  /** Go back to the built-in profile by removing the custom file. */
  const resetProfile = async () => {
    if (customProfileFile) await rm(customProfileFile, { force: true });
    return profile();
  };

  return {
    id: 'nono', platforms: ['linux', 'darwin'], transport: 'local-socket',
    probe, identity, prepare, profile, saveProfile, resetProfile,
  };
};
