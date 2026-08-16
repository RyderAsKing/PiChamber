/**
 * Canonical PiChamber data-root resolver.
 *
 * Every PiChamber-owned path (settings, projects, themes, credentials, goals,
 * walkthrough state, managed-process records, install IDs, etc.) must be
 * derived from the single effective data root returned by
 * {@link resolvePiChamberDataDir}. This is the *only* supported PiChamber data
 * root; legacy `~/.config/openchamber` locations are intentionally ignored
 * (legacy-data migration is out of scope).
 *
 * Resolution rules:
 *   - A non-empty `PICHAMBER_DATA_DIR` env value is trimmed and resolved
 *     against the current working directory so relative overrides behave
 *     predictably across runtimes.
 *   - The fallback is `path.join(home, '.config', 'pichamber')`.
 *
 * This module is pure and dependency-injectable: callers and tests pass the
 * environment, home-directory, and `path` sources they need; nothing is read
 * from module-scope state at call time beyond the defaults below.
 */
import os from 'os';
import path from 'path';

const DEFAULT_CONFIG_DIR_NAME = 'pichamber';

const defaultDeps = {
  env: process.env,
  homedir: () => os.homedir(),
  path,
};

/**
 * Resolve the effective PiChamber application-data root.
 *
 * @param {object} [deps] Dependency overrides (env, homedir, path) — used by
 *   tests for determinism. Production code should call without arguments.
 * @returns {string} The normalized data-root path.
 */
function resolvePiChamberDataDir(deps = defaultDeps) {
  const env = deps?.env ?? process.env;
  const homedir = deps?.homedir ?? defaultDeps.homedir;
  const pathModule = deps?.path ?? defaultDeps.path;

  const override = typeof env?.PICHAMBER_DATA_DIR === 'string'
    ? env.PICHAMBER_DATA_DIR.trim()
    : '';
  if (override.length > 0) {
    return pathModule.resolve(override);
  }

  const home = homedir();
  return pathModule.join(home, '.config', DEFAULT_CONFIG_DIR_NAME);
}

/**
 * Resolve a PiChamber-owned absolute path beneath the effective data root.
 * Convenience helper for owners that derive a single named file or
 * sub-directory. Empty or non-string segments are ignored — callers should not
 * construct this with user-controlled paths unless they have already been
 * validated.
 *
 * @param {string|string[]} segments One segment or an array of segments to
 *   join beneath the data root.
 * @param {object} [deps] Dependency overrides (env, homedir, path).
 * @returns {string}
 */
function resolvePiChamberDataPath(segments, deps) {
  const pathModule = deps?.path ?? defaultDeps.path;
  const dataDir = resolvePiChamberDataDir(deps);
  const list = segments === undefined ? [] : Array.isArray(segments) ? segments : [segments];
  return pathModule.join(dataDir, ...list);
}

export {
  resolvePiChamberDataDir,
  resolvePiChamberDataPath,
  DEFAULT_CONFIG_DIR_NAME,
};
