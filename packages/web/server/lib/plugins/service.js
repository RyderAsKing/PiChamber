import path from 'node:path';

import { createImpactCache } from './impact.js';
import { loadBundledPlugins } from './registry.js';
import {
  createPluginStore,
  isPluginEnabled,
  normalizePluginDirectory,
  normalizePluginSessionId,
  PluginStoreError,
  resolvePluginState,
  resolveSessionOverrides,
} from './store.js';

const isAtOrBelow = (directory, root) => {
  const relative = path.relative(root, directory);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const pluginNotFound = () => new PluginStoreError('PLUGIN_NOT_FOUND', 'No plugin has that id.');

/**
 * One owner for plugin manifests, stored choices, measured impact, and the
 * config the daemon receives. Routes and the daemon sync stay thin.
 */
export const createPluginService = ({
  store = createPluginStore(),
  loadPlugins = () => loadBundledPlugins(),
  impactCache = createImpactCache(),
} = {}) => {
  // Bundled manifests do not change while the server runs. A failed load is
  // not cached, so the next request retries.
  let pluginsPromise = null;
  const plugins = () => {
    if (!pluginsPromise) {
      pluginsPromise = loadPlugins().catch((error) => {
        pluginsPromise = null;
        throw error;
      });
    }
    return pluginsPromise;
  };

  const manifestFor = async (id) => {
    const manifest = typeof id === 'string' ? (await plugins()).get(id) : undefined;
    if (!manifest) throw pluginNotFound();
    return manifest;
  };

  const view = async (manifest, snapshot, directory) => {
    const measured = await impactCache.get(manifest);
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      icon: manifest.icon,
      version: manifest.version,
      keywords: manifest.keywords ?? [],
      bundled: manifest.bundled,
      enabled: isPluginEnabled(manifest, snapshot),
      state: resolvePluginState(manifest, snapshot, directory),
      stateSchema: manifest.stateSchema,
      contributes: manifest.contributes,
      impact: measured.impact,
      ...(measured.impactError ? { impactError: measured.impactError } : {}),
    };
  };

  /** `directory` is optional; an invalid one is a request error, not "no project". */
  const resolveDirectory = (directory) => {
    if (directory === undefined || directory === null || directory === '') return null;
    const normalized = normalizePluginDirectory(directory);
    if (!normalized) throw new PluginStoreError('INVALID_PLUGIN_REQUEST', 'The directory is invalid.');
    return normalized;
  };

  const list = async ({ directory } = {}) => {
    const target = resolveDirectory(directory);
    const [manifests, snapshot] = await Promise.all([plugins(), store.read()]);
    return Promise.all([...manifests.values()].map((manifest) => view(manifest, snapshot, target)));
  };

  const setEnabled = async (id, enabled) => {
    const manifest = await manifestFor(id);
    const snapshot = await store.setEnabled(manifest, enabled);
    return view(manifest, snapshot, null);
  };

  const setState = async (id, { key, value, directory }) => {
    const manifest = await manifestFor(id);
    const target = resolveDirectory(directory);
    const snapshot = await store.setState(manifest, { key, value, directory: target ?? undefined });
    return view(manifest, snapshot, target);
  };

  const sessionIdOrThrow = (sessionId) => {
    const id = normalizePluginSessionId(sessionId);
    if (!id) throw new PluginStoreError('INVALID_PLUGIN_REQUEST', 'The session id is invalid.');
    return id;
  };

  /** A session's own values, `{ [pluginId]: { [key]: value } }`, for plugins that have any. */
  const sessionState = async (sessionId) => {
    const id = sessionIdOrThrow(sessionId);
    const [manifests, snapshot] = await Promise.all([plugins(), store.read()]);
    const overrides = {};
    for (const manifest of manifests.values()) {
      const values = resolveSessionOverrides(manifest, snapshot, id);
      if (Object.keys(values).length > 0) overrides[manifest.id] = values;
    }
    return { sessionId: id, overrides };
  };

  /** Set or clear (`null`) one session's own value; answers that plugin's values for the session. */
  const setSessionState = async (pluginId, sessionId, { key, value }) => {
    const manifest = await manifestFor(pluginId);
    const id = sessionIdOrThrow(sessionId);
    const snapshot = await store.setSessionState(manifest, { sessionId: id, key, value });
    return { id: manifest.id, sessionId: id, overrides: resolveSessionOverrides(manifest, snapshot, id) };
  };

  /** Resolves whether a deleted session had values to drop. Never throws. */
  const forgetSession = async (sessionId) => {
    try {
      return await store.forgetSession(sessionId);
    } catch {
      return false;
    }
  };

  /**
   * Payload for the daemon's `plugins.configure`: enabled plugins only, each
   * with its module path and the state it needs to resolve values for any
   * directory: `global` is every key resolved without a project (defaults
   * filled in), `projects[dir]` only the project-scoped values that differ,
   * `sessions[sessionId]` a session's own values. The daemon resolves
   * `{ ...global, ...projects[dir], ...sessions[sessionId] }`.
   *
   * With `roots` (a sandboxed project's daemon), `projects` keeps only the
   * folders at or below one of them, so that daemon never learns where other
   * projects live. `sessions` holds opaque ids and values only and is sent
   * whole.
   */
  const daemonConfig = async ({ roots } = {}) => {
    const keep = Array.isArray(roots)
      ? (directory) => roots.some((root) => isAtOrBelow(path.resolve(directory), path.resolve(root)))
      : () => true;
    const [manifests, snapshot] = await Promise.all([plugins(), store.read()]);
    const configured = [];
    for (const manifest of manifests.values()) {
      if (!isPluginEnabled(manifest, snapshot)) continue;
      const global = resolvePluginState(manifest, snapshot, null);
      const projects = {};
      for (const directory of Object.keys(snapshot.state[manifest.id]?.projects ?? {})) {
        if (!keep(directory)) continue;
        const resolved = resolvePluginState(manifest, snapshot, directory);
        const projectValues = Object.fromEntries(Object.entries(manifest.stateSchema)
          .filter(([key, field]) => field.scope === 'project' && resolved[key] !== global[key])
          .map(([key]) => [key, resolved[key]]));
        if (Object.keys(projectValues).length > 0) projects[directory] = projectValues;
      }
      const sessions = {};
      for (const sessionId of Object.keys(snapshot.state[manifest.id]?.sessions ?? {})) {
        const values = resolveSessionOverrides(manifest, snapshot, sessionId);
        if (Object.keys(values).length > 0) sessions[sessionId] = values;
      }
      configured.push({
        id: manifest.id,
        entry: manifest.entry,
        replaceable: manifest.replaceable,
        state: { global, projects, sessions },
      });
    }
    return { plugins: configured };
  };

  /** npm names of the bundled plugins, so the marketplace never lists them. */
  const bundledPackageNames = async () => [...(await plugins()).values()]
    .filter((manifest) => manifest.bundled && manifest.packageName)
    .map((manifest) => manifest.packageName);

  return { list, setEnabled, setState, sessionState, setSessionState, forgetSession, daemonConfig, bundledPackageNames };
};
