import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PACKAGE_MANAGER_PRIORITIES = Object.freeze({
  deb: ['dpkg', 'apt'],
  rpm: ['zypper', 'dnf', 'yum', 'rpm'],
  pacman: ['pacman'],
});

const ELEVATION_COMMANDS = ['gksudo', 'kdesudo', 'pkexec', 'beesu'];
const SUPPORTED_PACKAGE_TYPES = new Set(Object.keys(PACKAGE_MANAGER_PRIORITIES));

const normalizePackageType = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SUPPORTED_PACKAGE_TYPES.has(normalized)) {
    throw new Error(`Unsupported Linux package type: ${value || '(missing)'}`);
  }
  return normalized;
};

const assertAbsolutePath = (value) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error('The downloaded Linux update path must be absolute');
  }
  return path.normalize(value);
};

/**
 * electron-updater escapes Linux installer paths for its shell-based updater.
 * The asynchronous runner below passes arguments directly, so restore the
 * original path before spawning the package manager.
 */
export const unescapeUpdaterInstallerPath = (value) => {
  let result = '';
  let escaped = false;
  for (const character of String(value || '')) {
    if (escaped) {
      result += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else {
      result += character;
    }
  }
  return escaped ? `${result}\\` : result;
};

const defaultCommandExists = async (command) => {
  try {
    await execFileAsync('/bin/sh', [
      '-c',
      'command -v -- "$1"',
      'pichamber-linux-update',
      command,
    ], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export const resolveLinuxPackageManager = async ({
  packageType,
  commandExists = defaultCommandExists,
} = {}) => {
  const normalizedType = normalizePackageType(packageType);
  for (const command of PACKAGE_MANAGER_PRIORITIES[normalizedType]) {
    if (await commandExists(command)) return command;
  }
  throw new Error(`No supported package manager was found for the Linux ${normalizedType} package`);
};

export const buildLinuxPackageManagerArgs = ({
  packageType,
  packageManager,
  installerPath,
} = {}) => {
  const normalizedType = normalizePackageType(packageType);
  const manager = String(packageManager || '').trim();
  const installer = assertAbsolutePath(installerPath);

  if (normalizedType === 'deb' && manager === 'dpkg') return ['-i', installer];
  if (normalizedType === 'deb' && manager === 'apt') {
    return [
      'install',
      '-y',
      '--allow-unauthenticated',
      '--allow-downgrades',
      '--allow-change-held-packages',
      installer,
    ];
  }
  if (normalizedType === 'rpm' && manager === 'zypper') {
    return ['--non-interactive', '--no-refresh', 'install', '--allow-unsigned-rpm', '-f', installer];
  }
  if (normalizedType === 'rpm' && manager === 'dnf') return ['install', '--nogpgcheck', '-y', installer];
  if (normalizedType === 'rpm' && manager === 'yum') return ['install', '--nogpgcheck', '-y', installer];
  if (normalizedType === 'rpm' && manager === 'rpm') {
    return ['-Uvh', '--replacepkgs', '--replacefiles', '--nodeps', installer];
  }
  if (normalizedType === 'pacman' && manager === 'pacman') return ['-U', '--noconfirm', installer];

  throw new Error(`Package manager ${manager || '(missing)'} cannot install a Linux ${normalizedType} package`);
};

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

const buildElevationCommand = ({
  elevationCommand,
  command,
  args,
} = {}) => {
  if (!elevationCommand) return { command, args };

  if (elevationCommand === 'pkexec' || elevationCommand === 'sudo' || elevationCommand === 'beesu') {
    return {
      command: elevationCommand,
      args: elevationCommand === 'pkexec'
        ? ['--disable-internal-agent', command, ...args]
        : [command, ...args],
    };
  }

  const commandLine = [command, ...args].map(shellQuote).join(' ');
  if (elevationCommand === 'kdesudo') {
    return { command: elevationCommand, args: ['--comment', 'PiChamber would like to update', '-c', commandLine] };
  }
  if (elevationCommand === 'gksudo') {
    return { command: elevationCommand, args: ['--message', 'PiChamber would like to update', command, ...args] };
  }
  throw new Error(`Unsupported Linux elevation command: ${elevationCommand}`);
};

const defaultRunCommand = (command, args) => new Promise((resolve, reject) => {
  let child;
  try {
    child = spawn(command, args, {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (error) {
    reject(error);
    return;
  }

  let settled = false;
  const settle = (callback, value) => {
    if (settled) return;
    settled = true;
    callback(value);
  };
  child.once('error', (error) => settle(reject, error));
  child.once('exit', (code, signal) => settle(resolve, { code, signal }));
});

const resolveLinuxElevationCommand = async (commandExists) => {
  for (const command of ELEVATION_COMMANDS) {
    if (await commandExists(command)) return command;
  }
  return 'sudo';
};

const runElevatedCommand = async ({
  elevationCommand,
  command,
  args,
  runCommand,
}) => {
  const invocation = buildElevationCommand({ elevationCommand, command, args });
  return runCommand(invocation.command, invocation.args);
};

const assertCommandSucceeded = (result, label) => {
  if (result?.code === 0) return;
  const signal = result?.signal ? ` (signal ${result.signal})` : '';
  throw new Error(`${label} failed with exit code ${result?.code ?? 'unknown'}${signal}`);
};

export const installLinuxPackageUpdate = async ({
  packageType,
  installerPath,
  isRoot = typeof process.getuid === 'function' && process.getuid() === 0,
  commandExists = defaultCommandExists,
  runCommand = defaultRunCommand,
} = {}) => {
  const normalizedType = normalizePackageType(packageType);
  const installer = assertAbsolutePath(installerPath);
  const packageManager = await resolveLinuxPackageManager({
    packageType: normalizedType,
    commandExists,
  });
  const elevationCommand = isRoot ? null : await resolveLinuxElevationCommand(commandExists);
  const args = buildLinuxPackageManagerArgs({
    packageType: normalizedType,
    packageManager,
    installerPath: installer,
  });

  const result = await runElevatedCommand({
    elevationCommand,
    command: packageManager,
    args,
    runCommand,
  });

  if (result?.code === 0) return { packageManager };

  // Match electron-updater's .deb behavior: dpkg can unpack the package and
  // then fail while configuring a dependency. apt-get -f completes that
  // transaction without blocking Electron's event loop.
  if (normalizedType === 'deb' && packageManager === 'dpkg') {
    const repairResult = await runElevatedCommand({
      elevationCommand,
      command: 'apt-get',
      args: ['install', '-f', '-y'],
      runCommand,
    });
    assertCommandSucceeded(repairResult, 'Linux package dependency repair');
    return { packageManager, repaired: true };
  }

  assertCommandSucceeded(result, 'Linux package installation');
  return { packageManager };
};
