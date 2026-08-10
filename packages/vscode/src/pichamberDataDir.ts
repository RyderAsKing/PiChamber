/**
 * VS Code-owned PiChamber data-root resolver.
 *
 * Mirrors the contract of `@pichamber/web/server/lib/pichamber-data-dir.js` so
 * VS Code owns a parity implementation that can stay in lock-step with web.
 *
 * Resolution rules:
 *   - A non-empty `OPENCHAMBER_DATA_DIR` env value is trimmed and resolved
 *     against the current working directory so relative overrides behave
 *     predictably across runtimes.
 *   - The fallback is `path.join(home, '.config', 'pichamber')`.
 *
 * The module is pure and dependency-injectable: tests pass the environment,
 * home-directory, and `path` sources they need.
 */
import * as os from 'os';
import * as path from 'path';

const DEFAULT_CONFIG_DIR_NAME = 'pichamber';

const defaultDeps = {
  env: process.env,
  homedir: () => os.homedir(),
  path,
};

export function resolvePiChamberDataDir(deps: { env?: NodeJS.ProcessEnv; homedir?: () => string; path?: typeof path } = defaultDeps): string {
  const env = deps?.env ?? defaultDeps.env;
  const homedir = deps?.homedir ?? defaultDeps.homedir;
  const pathModule = deps?.path ?? defaultDeps.path;

  const override = typeof env?.OPENCHAMBER_DATA_DIR === 'string' ? env.OPENCHAMBER_DATA_DIR.trim() : '';
  if (override.length > 0) {
    return pathModule.resolve(override);
  }

  const home = homedir();
  return pathModule.join(home, '.config', DEFAULT_CONFIG_DIR_NAME);
}

export function resolvePiChamberDataPath(
  segments: string | string[],
  deps?: { env?: NodeJS.ProcessEnv; homedir?: () => string; path?: typeof path },
): string {
  const pathModule = deps?.path ?? defaultDeps.path;
  const dataDir = resolvePiChamberDataDir(deps);
  const list = Array.isArray(segments) ? segments : [segments];
  return pathModule.join(dataDir, ...list);
}

export const PICHAMBER_CONFIG_DIR_NAME = DEFAULT_CONFIG_DIR_NAME;
