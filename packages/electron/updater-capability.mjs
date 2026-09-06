import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_LINUX_PACKAGE_TYPES = new Set(['AppImage', 'deb', 'rpm', 'pacman']);

export const resolveLinuxPackageType = ({
  platform = process.platform,
  packaged,
  appImagePath = process.env.APPIMAGE,
  resourcesPath = process.resourcesPath,
  readFile = fs.readFileSync,
} = {}) => {
  if (platform !== 'linux' || !packaged) return null;

  if (typeof resourcesPath === 'string' && resourcesPath) {
    try {
      const packageType = String(readFile(path.join(resourcesPath, 'package-type'), 'utf8')).trim().toLowerCase();
      const normalized = packageType === 'appimage' ? 'AppImage' : packageType;
      if (SUPPORTED_LINUX_PACKAGE_TYPES.has(normalized)) return normalized;
    } catch {
    }
  }

  if (typeof appImagePath === 'string' && appImagePath.trim()) return 'AppImage';
  return null;
};

export const assertUpdaterCapability = ({
  platform = process.platform,
  packaged,
  packageType,
  appImagePath = process.env.APPIMAGE,
  access = fs.accessSync,
  stat = fs.statSync,
} = {}) => {
  if (platform !== 'linux' || !packaged) return;

  const resolvedPackageType = packageType || (
    typeof appImagePath === 'string' && appImagePath.trim() ? 'AppImage' : null
  );
  if (resolvedPackageType && resolvedPackageType !== 'AppImage') {
    if (!SUPPORTED_LINUX_PACKAGE_TYPES.has(resolvedPackageType)) {
      throw new Error(`Unsupported Linux package type: ${resolvedPackageType}`);
    }
    return;
  }

  if (!appImagePath) {
    throw new Error(
      'Updates require a packaged Linux installation. Start PiChamber from its AppImage or install the .deb/.rpm package from GitHub Releases.',
    );
  }
  if (!path.isAbsolute(appImagePath)) {
    throw new Error(`Updates require APPIMAGE to be an absolute path, got: ${appImagePath}`);
  }

  try {
    if (!stat(appImagePath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`The running AppImage cannot be found at ${appImagePath}. Start PiChamber from a valid .AppImage file.`);
  }

  try {
    access(appImagePath, fs.constants.W_OK);
    access(path.dirname(appImagePath), fs.constants.W_OK);
  } catch {
    throw new Error(
      `The AppImage location is not writable at ${appImagePath}. Move it to a writable Linux filesystem location or grant write permission before updating.`,
    );
  }
};
