import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchIdentity, normalizeGrants, normalizeNetwork, SandboxLaunchError } from './launcher.js';

const NONO_MIN_VERSION = '0.82.0';
export const NONO_PROFILE_FILE = fileURLToPath(new URL('./nono-profile.json', import.meta.url));

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_ENV = { NONO_NO_UPDATE_CHECK: '1', NONO_NO_SAVE_PROMPT: '1' };

const runFile = (execFile, command, args, env) => new Promise((resolve) => {
  execFile(command, args, { env, timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
    resolve({
      error,
      code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
      spawnCode: error && typeof error.code === 'string' ? error.code : null,
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

// A connect-port grant applies to that port on every host and bypasses the
// proxy for it, so the web ports would defeat the host allowlist.
const REFUSED_PORTS = new Set([80, 443]);

const networkFlags = (network) => {
  if (network.mode === 'none') return ['--block-net'];
  for (const port of network.allowLocalPorts) {
    if (REFUSED_PORTS.has(port)) throw new SandboxLaunchError('SANDBOX_PORT_REFUSED');
  }
  const ports = network.allowLocalPorts.flatMap((port) => ['--allow-connect-port', String(port)]);
  if (network.allowHosts.length > 0) {
    return [...network.allowHosts.flatMap((host) => ['--allow-domain', host]), ...ports];
  }
  // Without an allowed host nono starts no proxy. Port grants alone still
  // limit TCP to those ports; with neither, nothing may leave the sandbox.
  return ports.length > 0 ? ports : ['--block-net'];
};

/**
 * nono launcher: runs the daemon under `nono run` with PiChamber's static
 * profile. Every path arrives as a per-launch flag built from structured
 * grants; the profile file holds only policy.
 */
export const createNonoLauncher = ({
  command = 'nono',
  platform = process.platform,
  execFile = execFileCallback,
  readProcVersion = defaultReadProcVersion,
  profileFile = NONO_PROFILE_FILE,
  // A real folder for the profile copy when `profileFile` sits inside an
  // asar archive (`<dataDir>/pi/sandbox`).
  stageDir,
  env = process.env,
} = {}) => {
  const profileContent = readFileSync(profileFile);
  const profileHash = createHash('sha256').update(profileContent).digest('hex');
  const resolveProfileFile = createProfileResolver({ profileFile, profileContent, profileHash, stageDir });
  let probedVersion = null;

  const probe = async () => {
    probedVersion = null;
    if (platform !== 'linux') return { available: false, code: 'UNSUPPORTED_PLATFORM' };
    if (/microsoft|wsl/i.test(await readProcVersion())) return { available: false, code: 'UNSUPPORTED_PLATFORM' };

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
    if (setupRun.code !== 0) {
      return { available: false, code: /landlock is not available/i.test(setupRun.output) ? 'NO_LANDLOCK' : 'SETUP_CHECK_FAILED' };
    }
    const abi = /Landlock V(\d+)/.exec(setupRun.output);
    if (!abi) return { available: false, code: 'NO_LANDLOCK' };

    probedVersion = version.join('.');
    return { available: true, version: probedVersion, capabilities: [`landlock-abi-${abi[1]}`] };
  };

  const requireProbe = () => {
    if (!probedVersion) throw new SandboxLaunchError('SANDBOX_NOT_PROBED');
    return probedVersion;
  };

  const identity = (request) => launchIdentity({
    launcher: 'nono',
    version: requireProbe(),
    profile: profileHash,
    grants: request.grants,
    network: request.network,
  });

  const prepare = async ({ argv, env: childEnv = {}, grants, network, tmpDir }) => {
    requireProbe();
    if (!Array.isArray(argv) || argv.length === 0) throw new SandboxLaunchError('SANDBOX_INVALID_COMMAND');
    if (typeof tmpDir !== 'string' || !tmpDir.startsWith('/')) throw new SandboxLaunchError('SANDBOX_INVALID_GRANT');
    const grantFlags = normalizeGrants(grants).flatMap((grant) => [GRANT_FLAGS[grant.kind], grant.path]);
    const readableProfile = await resolveProfileFile();
    return {
      command,
      args: [
        'run', '-s', '--profile', readableProfile, '--no-rollback', '--no-audit', '--no-diagnostics',
        ...grantFlags,
        ...networkFlags(normalizeNetwork(network)),
        '--', ...argv,
      ],
      env: { ...childEnv, NONO_NO_SAVE_PROMPT: '1', NONO_NO_UPDATE_CHECK: '1', TMPDIR: tmpDir },
    };
  };

  return { id: 'nono', platforms: ['linux'], transport: 'local-socket', probe, identity, prepare };
};
