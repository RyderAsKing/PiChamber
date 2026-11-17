import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePluginPackage } from './manifest.js';

/** Bundled plugins ship inside the web package, a read root of the nono sandbox. */
const BUNDLED_PLUGINS_DIR = fileURLToPath(new URL('../../../plugins/', import.meta.url));

class PluginRegistryError extends Error {
  constructor(message = 'The bundled plugin list is unreadable.') {
    super(message);
    this.code = 'PLUGINS_UNREADABLE';
  }
}

const isInside = (root, target) => {
  const fromRoot = relative(root, target);
  return fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
};

/**
 * Load `registry.json` and every plugin it lists. An invalid plugin is
 * skipped with a logged reason and never blocks the others. An unreadable or
 * malformed registry file throws: the bundled list is part of the install, so
 * reporting "no plugins" would hide a broken install.
 */
export const loadBundledPlugins = async ({ pluginsDir = BUNDLED_PLUGINS_DIR, logger = console } = {}) => {
  let listed;
  try {
    const parsed = JSON.parse(await readFile(join(pluginsDir, 'registry.json'), 'utf8'));
    if (parsed?.version !== 1 || !Array.isArray(parsed.plugins)) throw new Error('shape');
    listed = parsed.plugins;
  } catch {
    throw new PluginRegistryError();
  }
  const root = await realpath(pluginsDir);
  const plugins = new Map();
  for (const id of listed) {
    try {
      if (typeof id !== 'string' || id.includes('/') || id.includes('\\') || id.startsWith('.')) {
        throw new Error('listed id is invalid');
      }
      const packageDir = await realpath(join(root, id));
      if (!isInside(root, packageDir)) throw new Error('plugin folder leaves the plugins folder');
      const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
      const manifest = parsePluginPackage(packageJson, { packageDir, bundled: true });
      if (manifest.id !== id) throw new Error('pichamber.id does not match its registry entry');
      if (plugins.has(id)) throw new Error('listed twice');
      // The entry must resolve, through any links, to a file in the package.
      const entry = await realpath(manifest.entry);
      if (!isInside(packageDir, entry)) throw new Error('pi.extensions[0] leaves the package');
      plugins.set(id, { ...manifest, entry });
    } catch (error) {
      logger.warn?.(`[plugins] skipped bundled plugin ${typeof id === 'string' ? id : '<invalid>'}: ${error?.message ?? 'invalid'}`);
    }
  }
  return plugins;
};
