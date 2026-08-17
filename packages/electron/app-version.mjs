const ELECTRON_UPDATER_SEMVER = /^\d+\.\d+\.\d+/;
const UNPACKAGED_FALLBACK_VERSION = '0.0.0-dev';

/**
 * electron-updater constructs AppUpdater at import and rejects host Electron
 * versions such as "0.0" (unpackaged `electron ./main.mjs`). Pin a real
 * semver before that constructor runs.
 */
export const resolveElectronUpdaterVersion = (candidate, fallback = UNPACKAGED_FALLBACK_VERSION) => {
  const normalized = String(candidate || '').trim().replace(/^v/i, '');
  if (ELECTRON_UPDATER_SEMVER.test(normalized)) return normalized;
  return fallback;
};
