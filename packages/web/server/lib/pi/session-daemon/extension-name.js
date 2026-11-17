// Single owner of path-free extension display names for extensions.list and
// runtime extension.error events, ensuring server filesystem paths never reach
// the browser.

import { basename, dirname, resolve } from 'node:path';

const GENERIC_NAMES = new Set(['src', 'dist', 'lib', 'build', 'out', 'extensions']);
const SCRIPT_EXTENSION_PATTERN = /\.[cm]?[jt]sx?$/;
// Pi labels inline factories `<inline:name>`. PiChamber plugins are inline
// factories named `pichamber:<id>`; show them like Pi's `builtin:<name>`.
const PLUGIN_FACTORY_PATTERN = /^<inline:(pichamber:[a-z0-9-]+)>$/;

/**
 * Derives a path-free human-readable display name for an extension.
 * Pure function with no filesystem access.
 *
 * @param {string} extensionPath - The extension entry point path or synthetic label.
 * @param {object} [sourceInfo] - Optional sourceInfo from Pi resourceLoader.
 * @returns {string} Sanitized display name.
 */
export const deriveExtensionName = (extensionPath, sourceInfo) => {
  if (typeof extensionPath !== 'string' || extensionPath.length === 0) {
    return 'unknown';
  }

  const plugin = PLUGIN_FACTORY_PATTERN.exec(extensionPath);
  if (plugin) return plugin[1];

  const base = basename(extensionPath);
  const stem = base.replace(SCRIPT_EXTENSION_PATTERN, '');

  let chosenName;

  if (stem.length > 0 && stem !== 'index') {
    chosenName = stem;
  } else {
    const targetBaseDir = (typeof sourceInfo?.baseDir === 'string' && sourceInfo.baseDir.length > 0)
      ? resolve(sourceInfo.baseDir)
      : null;

    let current = resolve(dirname(extensionPath));
    let candidateName = null;

    while (current && current !== targetBaseDir) {
      const dirName = basename(current);
      if (dirName && !GENERIC_NAMES.has(dirName)) {
        candidateName = dirName;
        break;
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    if (!candidateName && current === targetBaseDir && targetBaseDir !== null && sourceInfo?.origin === 'package') {
      const baseDirName = basename(targetBaseDir);
      if (baseDirName && !GENERIC_NAMES.has(baseDirName)) {
        candidateName = baseDirName;
      }
    }

    chosenName = candidateName || 'index';
  }

  const sanitized = chosenName.replace(/[/\\]/g, '_').slice(0, 256);
  return sanitized.length > 0 ? sanitized : 'unknown';
};

/**
 * Resolves an extension display name using session resource loader metadata
 * when available, falling back safely on errors or missing data.
 *
 * @param {object} session - The Pi session instance.
 * @param {string} extensionPath - The extension path or synthetic label.
 * @returns {string} Sanitized display name.
 */
export const resolveExtensionName = (session, extensionPath) => {
  try {
    const extensions = session?.resourceLoader?.getExtensions?.()?.extensions;
    if (Array.isArray(extensions)) {
      const match = extensions.find((entry) => entry?.path === extensionPath);
      const sourceInfo = (match?.sourceInfo && typeof match.sourceInfo === 'object')
        ? match.sourceInfo
        : undefined;
      return deriveExtensionName(extensionPath, sourceInfo);
    }
  } catch {
    // Ignore any error during extension metadata discovery and fall back to path derivation.
  }
  return deriveExtensionName(extensionPath, undefined);
};
