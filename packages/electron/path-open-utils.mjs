import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const accessErrorMessage = (label, targetPath, error) => {
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
    return `${label} does not exist: ${targetPath}`;
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return `${label} is not accessible: ${targetPath}`;
  }
  return `${label} could not be checked: ${error?.message || String(error)}`;
};

export const normalizeRequiredPath = (rawPath, label = 'Path') => {
  const targetPath = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!targetPath) {
    throw new Error(`${label} is required`);
  }
  return path.resolve(targetPath);
};

export const validateLocalPath = async (rawPath, label = 'Path') => {
  const targetPath = normalizeRequiredPath(rawPath, label);
  let stats;
  try {
    stats = await fsp.stat(targetPath);
  } catch (error) {
    throw new Error(accessErrorMessage(label, targetPath, error));
  }

  const accessMode = stats.isDirectory()
    ? fs.constants.R_OK | fs.constants.X_OK
    : fs.constants.R_OK;
  try {
    await fsp.access(targetPath, accessMode);
  } catch (error) {
    throw new Error(accessErrorMessage(label, targetPath, error));
  }

  return { path: targetPath, stats };
};

export const unsupportedAppSpecificOpenError = (targetKind, platform = process.platform) => {
  const platformName = platform === 'linux'
    ? 'Linux'
    : platform === 'win32'
      ? 'Windows'
      : platform;
  return `Opening ${targetKind} in a specific app is not supported on ${platformName} yet. Use the default open action instead.`;
};

// Only http/https may leave the app via the OS handler. Other schemes
// (file:, ms-msdt:, search-ms:, custom protocols) are a Windows execution
// vector when passed to shell.openExternal from renderer-driven navigation.
const SAFE_EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:']);

export const isSafeExternalUrl = (rawUrl) => {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return false;
  }
  try {
    return SAFE_EXTERNAL_URL_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
};

export const openExternalUrlIfSafe = async (shellLike, rawUrl) => {
  if (!isSafeExternalUrl(rawUrl)) {
    return false;
  }
  await shellLike.openExternal(rawUrl);
  return true;
};
