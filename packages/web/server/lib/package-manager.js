import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { claimUpdateJob, updateUpdateJob } from './update-job-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_NAME = '@pi-chamber/web';
const PACKAGE_PATH_SEGMENTS = PACKAGE_NAME.split('/');
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}`;
const OFFICIAL_GITHUB_REPO = 'ryderasking/pichamber';
const CHANGELOG_BASE_URL = 'https://raw.githubusercontent.com/RyderAsKing/PiChamber';
const GITHUB_RELEASES_URL = 'https://github.com/RyderAsKing/PiChamber/releases';
const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/RyderAsKing/PiChamber/releases';
let cachedDetectedPm = null;
const TRUSTED_UPDATE_REASONS = new Set([
  'forced-env',
  'install-path-owner',
  'global-root-owner',
  'cached',
]);
const UPDATE_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const RELEASE_CANDIDATE_PATTERN = /^\d+\.\d+\.\d+-rc\.[1-9]\d*$/;

export function normalizeServerUpdateChannel(value) {
  return value === 'rc' ? 'rc' : 'stable';
}

function getSpawnSyncBaseOptions() {
  return process.platform === 'win32' ? { windowsHide: true } : {};
}
// The hosted update API is intentionally opt-in. When PICHAMBER_UPDATE_API_URL
// is absent or blank the web/CLI surface MUST NOT contact a hosted API and
// MUST NOT substitute a placeholder host; the npm-registry fallback in
// `checkForUpdates` is authoritative only when the published package
// repository is RyderAsKing/PiChamber.
function getConfiguredUpdateCheckUrl() {
  const override = typeof process.env.PICHAMBER_UPDATE_API_URL === 'string'
    ? process.env.PICHAMBER_UPDATE_API_URL.trim()
    : '';
  return override.length > 0 ? override : null;
}

function mapPlatform(value) {
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  if (value === 'linux') return 'linux';
  return 'web';
}

function mapArch(value) {
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === 'x64' || value === 'amd64') return 'x64';
  return 'unknown';
}

function normalizeAppType(value) {
  if (value === 'web' || value === 'desktop-electron' || value === 'mobile-capacitor') return value;
  return 'web';
}

function normalizeDeviceClass(value) {
  if (value === 'mobile' || value === 'tablet' || value === 'desktop' || value === 'unknown') return value;
  return 'unknown';
}

function normalizePlatform(value) {
  if (value === 'macos' || value === 'windows' || value === 'linux' || value === 'web' || value === 'android' || value === 'ios') return value;
  return mapPlatform(process.platform);
}

function normalizeArch(value) {
  if (value === 'arm64' || value === 'x64' || value === 'unknown') return value;
  return mapArch(process.arch);
}

async function resolveAndroidApkUrl(version) {
  try {
    const response = await fetch(`${GITHUB_RELEASES_API_URL}/tags/v${version}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'pichamber-update-check',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return undefined;

    const release = await response.json();
    const apkAssets = Array.isArray(release?.assets)
      ? release.assets.filter((asset) => (
        typeof asset?.name === 'string'
        && asset.name.toLowerCase().endsWith('.apk')
        && typeof asset.browser_download_url === 'string'
      ))
      : [];
    const canonicalAsset = apkAssets.find((asset) => /^PiChamber-.+-\d+-android\.apk$/i.test(asset.name));
    return canonicalAsset?.browser_download_url;
  } catch {
    return undefined;
  }
}

async function checkForUpdatesFromApi(currentVersion, options = {}) {
  const updateCheckUrl = getConfiguredUpdateCheckUrl();
  if (!updateCheckUrl) {
    // No configured hosted API: stay on the authoritative npm/GitHub path.
    return null;
  }
  try {
    const appType = normalizeAppType(options.appType);
    const hostPlatform = mapPlatform(process.platform);
    const hostArch = mapArch(process.arch);
    const shouldTrustClientPlatform = appType === 'desktop-electron' || appType === 'mobile-capacitor';
    const platform = shouldTrustClientPlatform ? normalizePlatform(options.platform) : hostPlatform;
    const arch = shouldTrustClientPlatform ? normalizeArch(options.arch) : hostArch;
    const payload = {
      appType,
      deviceClass: normalizeDeviceClass(options.deviceClass),
      platform,
      arch,
      channel: normalizeServerUpdateChannel(options.channel),
      currentVersion,
      instanceMode: options.instanceMode || 'unknown',
    };

    const response = await fetch(updateCheckUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;
    const data = await response.json();
    if (typeof data?.latestVersion !== 'string') return null;

    const versionComparison = compareVersions(data.latestVersion, currentVersion);
    if (versionComparison < 0) return null;

    const updateAvailable = Boolean(data.updateAvailable) && versionComparison > 0;
    return {
      available: updateAvailable,
      version: data.latestVersion,
      currentVersion,
      body: typeof data.releaseNotes === 'string' ? data.releaseNotes : undefined,
      nextSuggestedCheckInSec:
        typeof data.nextSuggestedCheckInSec === 'number' && Number.isFinite(data.nextSuggestedCheckInSec)
          ? data.nextSuggestedCheckInSec
          : undefined,
    };
  } catch {
    return null;
  }
}

function normalizePathForComparison(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getComparablePaths(filePath) {
  const paths = new Set();
  const normalized = normalizePathForComparison(filePath);
  if (normalized) {
    paths.add(normalized);
  }

  try {
    const realPath = fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
    const normalizedRealPath = normalizePathForComparison(realPath);
    if (normalizedRealPath) {
      paths.add(normalizedRealPath);
    }
  } catch {
  }

  return paths;
}

function pathSetContains(a, b) {
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }
  return false;
}

function getCurrentPackagePath() {
  return path.resolve(__dirname, '..', '..');
}

function getPackagePathForGlobalRoot(rootPath) {
  if (!rootPath) return null;
  return path.join(rootPath, ...PACKAGE_PATH_SEGMENTS);
}

function getUniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const value of paths) {
    const normalized = normalizePathForComparison(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(path.resolve(value));
  }
  return result;
}

function getCommandOutput(command, args) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...getSpawnSyncBaseOptions(),
    });

    if (result.status !== 0) {
      return null;
    }

    const stdout = result.stdout.trim();
    return stdout || null;
  } catch {
    return null;
  }
}

function getGlobalBinDirs(pm) {
  const pmCommand = resolvePackageManagerCommand(pm);
  if (!isCommandAvailable(pmCommand)) {
    return [];
  }

  const dirs = [];
  switch (pm) {
    case 'pnpm': {
      const pnpmBin = getCommandOutput(pmCommand, ['bin', '-g']);
      if (pnpmBin) dirs.push(pnpmBin);
      const pnpmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
      if (pnpmPrefix) dirs.push(process.platform === 'win32' ? pnpmPrefix : path.join(pnpmPrefix, 'bin'));
      break;
    }
    case 'yarn': {
      const yarnBin = getCommandOutput(pmCommand, ['global', 'bin']);
      if (yarnBin) dirs.push(yarnBin);
      break;
    }
    case 'bun': {
      const bunBin = getCommandOutput(pmCommand, ['pm', 'bin', '-g']);
      if (bunBin) dirs.push(bunBin);
      break;
    }
    default: {
      const npmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
      if (npmPrefix) dirs.push(process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin'));
      break;
    }
  }

  return getUniquePaths(dirs);
}

function getGlobalNodeModulesRoots(pm) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    if (!isCommandAvailable(pmCommand)) {
      return [];
    }

    const roots = [];

    switch (pm) {
      case 'pnpm': {
        const pnpmRoot = getCommandOutput(pmCommand, ['root', '-g']);
        if (pnpmRoot) roots.push(pnpmRoot);
        const pnpmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
        if (pnpmPrefix) roots.push(process.platform === 'win32' ? path.join(pnpmPrefix, 'node_modules') : path.join(pnpmPrefix, 'lib', 'node_modules'));
        break;
      }
      case 'yarn': {
        const yarnDir = getCommandOutput(pmCommand, ['global', 'dir']);
        if (yarnDir) roots.push(path.join(yarnDir, 'node_modules'));
        break;
      }
      case 'bun': {
        const bunBinDir = getCommandOutput(pmCommand, ['pm', 'bin', '-g']);
        if (bunBinDir) {
          roots.push(path.resolve(bunBinDir, '..', 'install', 'global', 'node_modules'));
          roots.push(path.resolve(bunBinDir, '..', '..', 'node_modules'));
        }
        break;
      }
      default:
      {
        const npmRoot = getCommandOutput(pmCommand, ['root', '-g']);
        if (npmRoot) roots.push(npmRoot);
        const npmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
        if (npmPrefix) roots.push(process.platform === 'win32' ? path.join(npmPrefix, 'node_modules') : path.join(npmPrefix, 'lib', 'node_modules'));
        break;
      }
    }

    return getUniquePaths(roots);
  } catch {
    return [];
  }
}

function getOwnedPackagePathsFromGlobalBins(pm) {
  const packagePaths = [];
  for (const binDir of getGlobalBinDirs(pm)) {
    const binaryName = process.platform === 'win32' ? 'pichamber.cmd' : 'pichamber';
    const binaryPath = path.join(binDir, binaryName);
    if (!fs.existsSync(binaryPath)) continue;

    try {
      const realBinaryPath = fs.realpathSync.native ? fs.realpathSync.native(binaryPath) : fs.realpathSync(binaryPath);
      packagePaths.push(path.resolve(realBinaryPath, '..', '..'));
    } catch {
    }
  }

  return getUniquePaths(packagePaths);
}

function detectPackageManagerFromCurrentInstallPath() {
  return detectPackageManagerFromInstallPath(getCurrentPackagePath());
}

function packageManagerOwnsCurrentInstall(pm) {
  const currentPackagePaths = getComparablePaths(getCurrentPackagePath());
  const candidatePackagePaths = [
    ...getGlobalNodeModulesRoots(pm).map(getPackagePathForGlobalRoot),
    ...getOwnedPackagePathsFromGlobalBins(pm),
  ];

  for (const candidatePath of candidatePackagePaths) {
    if (!candidatePath) continue;
    if (pathSetContains(currentPackagePaths, getComparablePaths(candidatePath))) {
      return true;
    }
  }

  return false;
}

function detectionResult(packageManager, reason) {
  return {
    packageManager,
    reason,
    packagePath: getCurrentPackagePath(),
    packageManagerCommand: resolvePackageManagerCommand(packageManager),
    globalNodeModulesRoot: getGlobalNodeModulesRoots(packageManager)[0] || null,
  };
}

function cacheTrustedDetection(packageManager, reason) {
  cachedDetectedPm = packageManager;
  return detectionResult(packageManager, reason);
}

export function detectPackageManagerDetails() {
  // In desktop (Electron) runtime, package-manager detection is worthless —
  // the app ships as a .app bundle, not installed via npm/pnpm/yarn/bun, and
  // updates are handled by electron-updater. The detection path does up to a
  // dozen spawnSync(pm, ['bin', '-g']) calls with 10s timeouts each; under
  // the in-process server every one blocks the Electron main event loop and
  // manifests as a multi-second UI freeze. Short-circuit here.
  if (process.env.PICHAMBER_RUNTIME === 'desktop') {
    return {
      packageManager: 'electron',
      reason: 'desktop-runtime',
      packagePath: null,
      packageManagerCommand: null,
      globalNodeModulesRoot: null,
    };
  }

  if (cachedDetectedPm) {
      return {
        packageManager: cachedDetectedPm,
        reason: 'cached',
        packagePath: getCurrentPackagePath(),
        packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
        globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
      };
  }

  const forcedPm = process.env.PICHAMBER_PACKAGE_MANAGER?.trim();
  if (forcedPm && UPDATE_PACKAGE_MANAGERS.has(forcedPm)) {
    const forcedPmCommand = resolvePackageManagerCommand(forcedPm);
    if (isCommandAvailable(forcedPmCommand)) {
      return cacheTrustedDetection(forcedPm, 'forced-env');
    }
  }

  // First prefer the package manager that demonstrably owns the current install.
  const installPathPm = detectPackageManagerFromCurrentInstallPath();
  if (installPathPm && packageManagerOwnsCurrentInstall(installPathPm)) {
    return cacheTrustedDetection(installPathPm, 'install-path-owner');
  }

  const ownershipCandidates = ['pnpm', 'yarn', 'bun', 'npm'];
  for (const candidate of ownershipCandidates) {
    if (packageManagerOwnsCurrentInstall(candidate)) {
      return cacheTrustedDetection(candidate, 'global-root-owner');
    }
  }

  // Fall back to weaker hints only when ownership cannot be established.
  const userAgent = process.env.npm_config_user_agent || '';
  let hintedPm = null;
  if (userAgent.startsWith('pnpm')) hintedPm = 'pnpm';
  else if (userAgent.startsWith('yarn')) hintedPm = 'yarn';
  else if (userAgent.startsWith('bun')) hintedPm = 'bun';
  else if (userAgent.startsWith('npm')) hintedPm = 'npm';

  // Check execpath.
  const execPath = process.env.npm_execpath || '';
  if (!hintedPm) {
    if (execPath.includes('pnpm')) hintedPm = 'pnpm';
    else if (execPath.includes('yarn')) hintedPm = 'yarn';
    else if (execPath.includes('bun')) hintedPm = 'bun';
    else if (execPath.includes('npm')) hintedPm = 'npm';
  }

  // Detect from invoked binary path.
  const invokedPm = detectPackageManagerFromInvocationPath(process.argv?.[1]);
  if (!hintedPm) {
    hintedPm = invokedPm;
  }

  if (!hintedPm) {
    hintedPm = installPathPm;
  }

  // Validate the hint against package visibility, but only after ownership checks failed.
  if (hintedPm && isCommandAvailable(resolvePackageManagerCommand(hintedPm)) && isPackageInstalledWith(hintedPm)) {
    return detectionResult(hintedPm, 'hinted-visible-install');
  }

  const runtimePm = detectPackageManagerFromRuntimePath(process.execPath);
  if (runtimePm && isCommandAvailable(resolvePackageManagerCommand(runtimePm)) && isPackageInstalledWith(runtimePm)) {
    return detectionResult(runtimePm, 'runtime-visible-install');
  }

  const pmChecks = [
    { name: 'pnpm', check: () => isCommandAvailable(resolvePackageManagerCommand('pnpm')) },
    { name: 'yarn', check: () => isCommandAvailable(resolvePackageManagerCommand('yarn')) },
    { name: 'bun', check: () => isCommandAvailable(resolvePackageManagerCommand('bun')) },
    { name: 'npm', check: () => isCommandAvailable(resolvePackageManagerCommand('npm')) },
  ];

  for (const { name, check } of pmChecks) {
    if (check() && isPackageInstalledWith(name)) {
      return detectionResult(name, 'last-resort-visible-install');
    }
  }

  return detectionResult('npm', 'default-fallback');
}

export function detectPackageManager() {
  return detectPackageManagerDetails().packageManager;
}

export function resolveTrustedUpdatePackageManager(details = detectPackageManagerDetails()) {
  if (
    details
    && TRUSTED_UPDATE_REASONS.has(details.reason)
    && UPDATE_PACKAGE_MANAGERS.has(details.packageManager)
  ) {
    return details.packageManager;
  }
  return null;
}

function isSourceCheckout(packagePath, existsSync = fs.existsSync) {
  const parent = path.dirname(packagePath);
  if (path.basename(packagePath) !== 'web' || path.basename(parent) !== 'packages') return false;
  const repositoryRoot = path.dirname(parent);
  return existsSync(path.join(repositoryRoot, 'package.json'))
    && existsSync(path.join(repositoryRoot, 'packages', 'ui'));
}

export function detectSystemdServiceContext(options = {}) {
  const env = options.env || process.env;
  const markedUnit = env.PICHAMBER_SYSTEMD_UNIT === 'pichamber.service'
    ? env.PICHAMBER_SYSTEMD_UNIT
    : null;
  if (markedUnit) {
    const isRoot = options.isRoot ?? (typeof process.getuid === 'function' && process.getuid() === 0);
    return { unit: markedUnit, scope: isRoot ? 'system' : 'user', managed: markedUnit === 'pichamber.service' };
  }
  if ((options.platform || process.platform) !== 'linux') return null;
  try {
    const cgroup = (options.readFileSync || fs.readFileSync)('/proc/self/cgroup', 'utf8');
    for (const line of cgroup.split(/\r?\n/)) {
      const cgroupPath = line.slice(line.lastIndexOf(':') + 1);
      const unit = cgroupPath.split('/').filter(Boolean).at(-1);
      if (!unit || !/^[A-Za-z0-9_.@-]+\.service$/.test(unit)) continue;
      return {
        unit,
        scope: cgroupPath.includes('/user.slice/') ? 'user' : 'system',
        managed: unit === 'pichamber.service',
      };
    }
    return null;
  } catch {
    return null;
  }
}

function canWriteOwnedInstall(details, options = {}) {
  if (typeof options.installWritable === 'boolean') return options.installWritable;
  const target = details.globalNodeModulesRoot || path.dirname(details.packagePath || '');
  if (!target) return false;
  try {
    (options.accessSync || fs.accessSync)(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function customSystemdRestartCommand(context) {
  return context.scope === 'user'
    ? `systemctl --user restart ${context.unit}`
    : `systemctl restart ${context.unit}`;
}

function customSystemdGuidance(context) {
  if (context.unit.toLowerCase().includes('pichamber')) {
    return `PiChamber is running under the custom systemd unit ${context.unit}. Automatic restart is supported only for pichamber.service. From a normal terminal, run: pichamber update. Then run: ${customSystemdRestartCommand(context)}`;
  }
  return `PiChamber is running inside ${context.unit}, but PiChamber cannot verify that this is the server's owning unit. From a normal terminal, run: pichamber update. Then restart PiChamber using your deployment configuration. Do not restart ${context.unit} unless you have verified that it is your PiChamber unit.`;
}

export function getUpdateCapability(options = {}) {
  const env = options.env || process.env;
  const isContainer = options.isContainer ?? (
    fs.existsSync('/.dockerenv')
    || fs.existsSync('/run/.containerenv')
    || Boolean(env.CONTAINER)
    || Boolean(env.container)
  );
  if (isContainer) {
    return {
      supported: false,
      code: 'DOCKER_DEPLOYMENT',
      error: 'PiChamber is running in a container and cannot replace its own image. In the directory with your compose file, pull the newer image and recreate the container. Config, sessions, SSH keys, and workspaces persist in the mounted volumes.',
      commands: ['docker compose pull', 'docker compose up -d'],
    };
  }

  const packagePath = options.packagePath || getCurrentPackagePath();
  const context = options.systemdContext === undefined
    ? detectSystemdServiceContext(options)
    : options.systemdContext;
  const shouldReportCustomUnit = context && !context.managed && (
    options.serverProcess === true || env.PICHAMBER_SERVER_TERMINAL === '1'
  );
  if (isSourceCheckout(packagePath, options.existsSync)) {
    const knownPiChamberUnit = shouldReportCustomUnit && context.unit.toLowerCase().includes('pichamber');
    const restart = knownPiChamberUnit
      ? ` Then restart ${context.unit} with: ${customSystemdRestartCommand(context)}`
      : '';
    return {
      supported: false,
      code: 'SOURCE_CHECKOUT',
      error: `This PiChamber server is running from a source checkout and cannot update itself. Update the checkout, rebuild the web package, and restart the server.${restart}`,
      commands: knownPiChamberUnit ? [customSystemdRestartCommand(context)] : [],
    };
  }
  if (shouldReportCustomUnit) {
    return {
      supported: false,
      code: 'CUSTOM_SYSTEMD_UNIT',
      error: customSystemdGuidance(context),
      commands: context.unit.toLowerCase().includes('pichamber')
        ? ['pichamber update', customSystemdRestartCommand(context)]
        : ['pichamber update'],
    };
  }

  const details = options.details || detectPackageManagerDetails();
  const packageManager = resolveTrustedUpdatePackageManager(details);
  if (packageManager && canWriteOwnedInstall(details, options)) {
    return { supported: true, code: 'SUPPORTED', packageManager };
  }
  if (packageManager || String(details?.reason || '').includes('visible-install')) {
    return {
      supported: false,
      code: 'INSTALL_OWNERSHIP_MISMATCH',
      error: 'This account cannot update the PiChamber installation used by the server. Run pichamber update as the account that installed PiChamber, or reinstall the global package under the service account and run pichamber startup enable again.',
    };
  }
  return {
    supported: false,
    code: 'UNSUPPORTED_INSTALL',
    error: 'This PiChamber copy is not a supported global package-manager install. Install @pi-chamber/web globally with Bun, npm, pnpm, or Yarn, then run pichamber startup enable again.',
  };
}

function detectPackageManagerFromInstallPath(pkgPath) {
  if (!pkgPath) return null;
  const normalized = pkgPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.pnpm/') || normalized.includes('/pnpm/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  if (normalized.includes('/.bun/') || normalized.includes('/bun/install/')) return 'bun';
  if (normalized.includes('/node_modules/')) return 'npm';
  return null;
}

function detectPackageManagerFromRuntimePath(runtimePath) {
  if (!runtimePath || typeof runtimePath !== 'string') return null;
  const normalized = runtimePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/bun') || normalized.endsWith('/bun') || normalized.endsWith('/bun.exe')) {
    return 'bun';
  }
  // `node` is the runtime for npm, pnpm, and yarn global bins. It is not an
  // install owner.
  return null;
}

function detectPackageManagerFromInvocationPath(invokedPath) {
  if (!invokedPath || typeof invokedPath !== 'string') return null;
  const normalized = invokedPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/')) return 'bun';
  if (normalized.includes('/.pnpm/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  return null;
}

function getPackageManagerCommandCandidates(pm) {
  const candidates = [];
  if (pm === 'bun') {
    const bunExecutable = process.platform === 'win32' ? 'bun.exe' : 'bun';
    if (process.env.BUN_INSTALL) {
      candidates.push(path.join(process.env.BUN_INSTALL, 'bin', bunExecutable));
    }
    if (process.env.HOME) {
      candidates.push(path.join(process.env.HOME, '.bun', 'bin', bunExecutable));
    }
    if (process.env.USERPROFILE) {
      candidates.push(path.join(process.env.USERPROFILE, '.bun', 'bin', bunExecutable));
    }
  }
  candidates.push(pm);
  return [...new Set(candidates.filter(Boolean))];
}

function resolvePackageManagerCommand(pm) {
  const candidates = getPackageManagerCommandCandidates(pm);
  for (const candidate of candidates) {
    if (isCommandAvailable(candidate)) {
      return candidate;
    }
  }
  return pm;
}

function quoteCommand(command) {
  if (!command) return command;
  if (!/\s/.test(command)) return command;
  if (process.platform === 'win32') {
    return `"${command.replace(/"/g, '""')}"`;
  }
  return `'${command.replace(/'/g, "'\\''")}'`;
}

function isCommandAvailable(command) {
  try {
    const result = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      ...getSpawnSyncBaseOptions(),
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function isPackageInstalledWith(pm) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    let args;
    switch (pm) {
      case 'pnpm':
        args = ['list', '-g', '--depth=0', PACKAGE_NAME];
        break;
      case 'yarn':
        args = ['global', 'list', '--depth=0'];
        break;
      case 'bun':
        args = ['pm', 'ls', '-g'];
        break;
      default:
        args = ['list', '-g', '--depth=0', PACKAGE_NAME];
    }

    const result = spawnSync(pmCommand, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...getSpawnSyncBaseOptions(),
    });

    if (result.status !== 0) return false;
    return result.stdout.includes(PACKAGE_NAME);
  } catch {
    return false;
  }
}

/**
 * Get the update command for the detected package manager
 */
export function getUpdateCommand(pm = detectPackageManager(), targetVersion) {
  if (!SEMVER_PATTERN.test(String(targetVersion))) {
    throw new Error('Update target version is invalid.');
  }
  const packageSpec = `${PACKAGE_NAME}@${targetVersion}`;
  const pmCommand = quoteCommand(resolvePackageManagerCommand(pm));
  switch (pm) {
    case 'pnpm':
      return `${pmCommand} add -g ${packageSpec}`;
    case 'yarn':
      return `${pmCommand} global add ${packageSpec}`;
    case 'bun':
      return `${pmCommand} add -g ${packageSpec}`;
    default:
      return `${pmCommand} install -g ${packageSpec}`;
  }
}

/**
 * Get current installed version from package.json
 */
export function getCurrentVersion() {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function getInstalledVersion(pm) {
  const candidates = [
    ...getOwnedPackagePathsFromGlobalBins(pm),
    ...getGlobalNodeModulesRoots(pm).map(getPackagePathForGlobalRoot),
  ];
  for (const packagePath of getUniquePaths(candidates)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8'));
      if (pkg?.name === PACKAGE_NAME && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // Try the next package-manager-owned path.
    }
  }
  return getCurrentVersion();
}

function getNpmRepositoryUrl(data) {
  const repository = data?.repository;
  if (typeof repository === 'string') return repository;
  if (repository && typeof repository.url === 'string') return repository.url;
  return '';
}

function isOfficialPiChamberRegistryPackage(data) {
  const raw = getNpmRepositoryUrl(data).trim().toLowerCase();
  if (!raw) return false;
  const normalized = raw.replace(/\.git$/i, '');
  const escapedRepo = OFFICIAL_GITHUB_REPO.replace('/', '\\/');
  return (
    new RegExp(`(?:^|/)github\\.com[:/]${escapedRepo}(?:/|$)`, 'i').test(normalized)
    || new RegExp(`git@github\\.com:${escapedRepo}$`, 'i').test(normalized)
  );
}

/**
 * Fetch latest version from npm only when `@pi-chamber/web` is this project's package.
 * Dist-tag alone is not enough if an unrelated package occupies the name.
 */
async function getRegistryUpdateTarget(currentVersion, channel) {
  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Registry responded with ${response.status}`);
    }

    const data = await response.json();
    if (!isOfficialPiChamberRegistryPackage(data)) {
      return null;
    }
    const latest = data['dist-tags']?.latest;
    const releaseCandidate = data['dist-tags']?.rc;
    const stableVersion = typeof latest === 'string' && SEMVER_PATTERN.test(latest) && !latest.includes('-')
      ? latest
      : null;
    const rcVersion = typeof releaseCandidate === 'string' && RELEASE_CANDIDATE_PATTERN.test(releaseCandidate)
      ? releaseCandidate
      : null;
    if (normalizeServerUpdateChannel(channel) === 'rc') {
      const stableTarget = stableVersion
        ? { version: stableVersion, releaseChannel: 'stable' }
        : null;
      const rcTarget = rcVersion
        ? { version: rcVersion, releaseChannel: 'rc' }
        : null;
      if (!stableTarget) return rcTarget;
      if (!rcTarget) return stableTarget;
      return compareVersions(rcTarget.version, stableTarget.version) > 0
        ? rcTarget
        : stableTarget;
    }
    return stableVersion ? { version: stableVersion, releaseChannel: 'stable' } : null;
  } catch {
    return null;
  }
}

/**
 * Compare semver-like version strings.
 */
function parseVersionForComparison(value) {
  const match = SEMVER_PATTERN.exec(String(value || '').replace(/^v/, ''));
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') || null,
  };
}

function comparePrerelease(left, right) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference !== 0) return difference;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else {
      const difference = left[index].localeCompare(right[index]);
      if (difference !== 0) return difference;
    }
  }
  return 0;
}

function compareVersions(left, right) {
  const a = parseVersionForComparison(left);
  const b = parseVersionForComparison(right);
  if (!a || !b) return String(left || '').localeCompare(String(right || ''), undefined, { numeric: true });
  for (let index = 0; index < a.core.length; index += 1) {
    const difference = a.core[index] - b.core[index];
    if (difference !== 0) return difference;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Fetch changelog notes between versions
 */
async function fetchChangelogNotes(fromVersion, toVersion) {
  const tag = `v${encodeURIComponent(toVersion)}`;
  try {
    const response = await fetch(`${GITHUB_RELEASES_API_URL}/tags/${tag}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'pichamber-update-check',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      const release = await response.json();
      const body = typeof release?.body === 'string' ? release.body.trim() : '';
      if (body) return body;
    }
  } catch {
  }

  try {
    const response = await fetch(`${CHANGELOG_BASE_URL}/${tag}/CHANGELOG.md`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return undefined;

    const changelog = await response.text();
    const sections = changelog.split(/^## /m).slice(1);

    const relevantSections = sections.filter((section) => {
      const match = section.match(/^\[([^\]]+)\]/);
      const version = match?.[1];
      if (!version || !SEMVER_PATTERN.test(version)) return false;
      return compareVersions(version, fromVersion) > 0 && compareVersions(version, toVersion) <= 0;
    });

    if (relevantSections.length === 0) return undefined;

    return relevantSections
      .map((s) => '## ' + s.trim())
      .join('\n\n');
  } catch {
    return undefined;
  }
}

export async function checkForUpdates(options = {}) {
  const currentVersion = options.currentVersion || getCurrentVersion();
  const pm = detectPackageManager();
  const appType = normalizeAppType(options.appType);
  const platform = normalizePlatform(options.platform);
  const channel = normalizeServerUpdateChannel(options.channel);
  const target = currentVersion === 'unknown'
    ? null
    : await getRegistryUpdateTarget(currentVersion, channel);
  const latestVersion = target?.version;

  if (!latestVersion || currentVersion === 'unknown') {
    return {
      available: false,
      currentVersion,
      channel,
      error: 'Unable to determine versions',
    };
  }

  const available = compareVersions(latestVersion, currentVersion) > 0;
  const remote = await checkForUpdatesFromApi(currentVersion, {
    ...options,
    channel: target.releaseChannel,
  });
  const trustedRemote = remote?.version === latestVersion ? remote : null;
  let changelog = trustedRemote?.body;
  let downloadUrl;
  if (available) {
    if (!changelog) {
      changelog = await fetchChangelogNotes(currentVersion, latestVersion);
    }
    if (appType === 'mobile-capacitor' && platform === 'android') {
      downloadUrl = await resolveAndroidApkUrl(latestVersion);
    }
  }

  return {
    available,
    version: latestVersion,
    currentVersion,
    channel,
    body: changelog,
    releaseUrl: `${GITHUB_RELEASES_URL}/tag/v${latestVersion}`,
    downloadUrl,
    nextSuggestedCheckInSec: trustedRemote?.nextSuggestedCheckInSec,
    packageManager: pm,
    // Show our CLI command, not raw package manager command
    updateCommand: 'pichamber update',
  };
}

/**
 * Execute the update (used by CLI)
 */
export function isInsidePiChamberSystemdService(options = {}) {
  const env = options.env || process.env;
  if (env.PICHAMBER_SYSTEMD_UNIT === 'pichamber.service') return true;
  if ((options.platform || process.platform) !== 'linux') return false;
  try {
    const cgroup = (options.readFileSync || fs.readFileSync)('/proc/self/cgroup', 'utf8');
    return /(?:^|\/)pichamber\.service(?:\/|$)/m.test(cgroup);
  } catch {
    return false;
  }
}

function updateWorkerArgs(cliPath, jobId) {
  return [cliPath, 'update', '--yes', '--quiet', '--update-worker', '--update-job-id', jobId];
}

function systemdRunArgs(cliPath, jobId, options = {}) {
  const isRoot = options.isRoot ?? (typeof process.getuid === 'function' && process.getuid() === 0);
  const args = [];
  if (!isRoot) args.push('--user');
  args.push(`--unit=pichamber-update-${jobId.replaceAll('-', '')}`, '--collect', '--quiet', '--property=Type=exec');
  const env = options.env || process.env;
  for (const key of ['HOME', 'PATH', 'PICHAMBER_DATA_DIR', 'PICHAMBER_PACKAGE_MANAGER']) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) args.push(`--setenv=${key}=${value}`);
  }
  args.push('--', process.execPath, ...updateWorkerArgs(cliPath, jobId));
  return args;
}

export async function launchUpdateCommand(options = {}) {
  const isContainer = options.isContainer ?? (
    fs.existsSync('/.dockerenv')
    || fs.existsSync('/run/.containerenv')
    || Boolean(process.env.CONTAINER)
    || Boolean(process.env.container)
  );
  if (isContainer) {
    return {
      success: false,
      error: 'Docker deployments must be updated by pulling a new image and recreating the container.',
    };
  }

  const claimJob = options.claimUpdateJob || claimUpdateJob;
  const updateJob = options.updateUpdateJob || updateUpdateJob;
  const claimed = await claimJob({
    previousVersion: options.previousVersion,
    targetVersion: options.targetVersion,
    packageManager: options.packageManager,
    channel: normalizeServerUpdateChannel(options.channel),
  });
  if (!claimed.created) {
    return {
      success: true,
      jobId: claimed.job.id,
      state: claimed.job.state,
      channel: claimed.job.channel,
      targetVersion: claimed.job.targetVersion,
      existing: true,
    };
  }

  const jobId = claimed.job.id;
  const cliPath = path.resolve(__dirname, '..', '..', 'bin', 'cli.js');
  const insideSystemd = options.isSystemd ?? isInsidePiChamberSystemdService(options);
  try {
    if (insideSystemd) {
      const result = (options.runProcess || spawnSync)('systemd-run', systemdRunArgs(cliPath, jobId, options), {
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
      });
      if (result.error || result.status !== 0) {
        const error = 'Could not start the systemd update worker. Run: pichamber update';
        await updateJob(jobId, { state: 'failed', error });
        return { success: false, jobId, error };
      }
    } else {
      const child = (options.spawnProcess || spawn)(process.execPath, updateWorkerArgs(cliPath, jobId), {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once?.('error', (cause) => {
        const detail = cause instanceof Error ? cause.message : String(cause);
        void updateJob(jobId, { state: 'failed', error: `Could not start the updater: ${detail}` });
      });
      child.unref();
    }
    return {
      success: true,
      jobId,
      state: claimed.job.state,
      channel: claimed.job.channel,
      targetVersion: claimed.job.targetVersion,
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = `Could not start the updater: ${detail}`;
    await updateJob(jobId, { state: 'failed', error });
    return { success: false, jobId, error };
  }
}

export function executeUpdate(pm = detectPackageManager(), options = {}) {
  const command = getUpdateCommand(pm, options.targetVersion);
  if (!options?.silent) {
    console.log(`Updating ${PACKAGE_NAME} using ${pm}...`);
    console.log(`Running: ${command}`);
  }

  const result = spawnSync(command, {
    stdio: options?.silent === true ? 'ignore' : 'inherit',
    shell: true,
    ...getSpawnSyncBaseOptions(),
  });

  return {
    success: result.status === 0,
    exitCode: result.status,
  };
}
