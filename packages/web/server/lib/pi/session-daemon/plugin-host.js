import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Holds the PiChamber plugins the server configured through the private
// `plugins.configure` command and turns the enabled ones into Pi extension
// factories. The daemon never reads plugin state or the enabled set from
// disk: it may run in a sandbox without access to PiChamber's data folder.
// Until the server configures it, the host has no plugins.

/** Bundled plugin code lives in the web package, a read root of the sandbox. */
const BUNDLED_PLUGINS_ROOT = fileURLToPath(new URL('../../../../plugins/', import.meta.url));

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_PLUGINS = 64;
const MAX_DIRECTORIES = 4096;
const MAX_SESSIONS = 4096;
const MAX_SESSION_ID_LENGTH = 256;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class PluginHostError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_ARGUMENT';
  }
}

const invalid = (message = 'The plugin configuration is invalid.') => new PluginHostError(message);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const parseValues = (value) => {
  if (!isRecord(value)) throw invalid();
  const values = {};
  for (const [key, stored] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || (typeof stored !== 'boolean' && typeof stored !== 'string')) throw invalid();
    values[key] = stored;
  }
  return values;
};

const parseState = (value) => {
  if (!isRecord(value)) throw invalid();
  const projectsInput = value.projects ?? {};
  if (!isRecord(projectsInput) || Object.keys(projectsInput).length > MAX_DIRECTORIES) throw invalid();
  const projects = new Map();
  for (const [directory, values] of Object.entries(projectsInput)) {
    if (!isAbsolute(directory)) throw invalid();
    projects.set(resolve(directory), parseValues(values));
  }
  const sessionsInput = value.sessions ?? {};
  if (!isRecord(sessionsInput) || Object.keys(sessionsInput).length > MAX_SESSIONS) throw invalid();
  const sessions = new Map();
  for (const [sessionId, values] of Object.entries(sessionsInput)) {
    if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH || FORBIDDEN_KEYS.has(sessionId)) throw invalid();
    sessions.set(sessionId, parseValues(values));
  }
  return { global: parseValues(value.global ?? {}), projects, sessions };
};

/** Validate the `plugins.configure` payload. Throws INVALID_ARGUMENT. */
export const parsePluginConfig = (payload) => {
  if (!isRecord(payload) || !Array.isArray(payload.plugins) || payload.plugins.length > MAX_PLUGINS) throw invalid();
  const seen = new Set();
  return payload.plugins.map((plugin) => {
    if (!isRecord(plugin) || typeof plugin.id !== 'string' || plugin.id.length > 40 || !ID_PATTERN.test(plugin.id)) throw invalid();
    if (seen.has(plugin.id)) throw invalid();
    seen.add(plugin.id);
    if (typeof plugin.entry !== 'string' || !isAbsolute(plugin.entry)) throw invalid();
    if (plugin.replaceable !== undefined && typeof plugin.replaceable !== 'boolean') throw invalid();
    return {
      id: plugin.id,
      entry: resolve(plugin.entry),
      replaceable: plugin.replaceable === true,
      state: parseState(plugin.state ?? {}),
    };
  });
};

const sortedEntries = (map) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
const stateKey = (state) => JSON.stringify([state.global, sortedEntries(state.projects), sortedEntries(state.sessions)]);

const isInside = (root, target) => {
  const fromRoot = relative(root, target);
  return fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
};

export const createPluginHost = ({
  pluginsRoot = BUNDLED_PLUGINS_ROOT,
  importModule = (entry) => import(pathToFileURL(entry).href),
  logger = console,
} = {}) => {
  // id -> { id, entry, replaceable, state, factory, listeners: Set<Set<fn>> }
  let loaded = new Map();
  let queue = Promise.resolve();
  // id -> Set of `tool:x`, `command:y`, `flag:z`, as the plugin's factory
  // registered them in any runtime. Lets the daemon tell which extension took
  // a plugin's place when Pi drops it. Kept while the plugin stays configured.
  const registered = new Map();

  // Only modules under the plugins root may load. The server is trusted, but
  // the check keeps a daemon from importing arbitrary files by IPC.
  const loadFactory = async (entry) => {
    const [root, real] = await Promise.all([realpath(pluginsRoot), realpath(entry)]);
    if (!isInside(root, real)) throw new Error('the plugin is outside the plugins folder');
    const module = await importModule(real);
    if (typeof module?.default !== 'function') throw new Error('the plugin has no default export');
    return { entry: real, factory: module.default };
  };

  // Session value over project value over global value.
  const resolveState = (plugin, directory, sessionId) => {
    const project = typeof directory === 'string' && isAbsolute(directory)
      ? plugin.state.projects.get(resolve(directory))
      : undefined;
    const session = typeof sessionId === 'string' ? plugin.state.sessions.get(sessionId) : undefined;
    return { ...plugin.state.global, ...(project ?? {}), ...(session ?? {}) };
  };

  const notify = (plugin) => {
    for (const runtimeListeners of plugin.listeners) {
      for (const listener of runtimeListeners) {
        try {
          const result = listener();
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch {
          // One listener must not stop the others.
        }
      }
    }
  };

  const applyConfig = async (payload) => {
    const requested = parsePluginConfig(payload);
    const next = new Map();
    const results = [];
    for (const plugin of requested) {
      const previous = loaded.get(plugin.id);
      try {
        const { entry, factory } = previous && previous.requestedEntry === plugin.entry
          ? previous
          : await loadFactory(plugin.entry);
        next.set(plugin.id, {
          id: plugin.id,
          requestedEntry: plugin.entry,
          entry,
          factory,
          replaceable: plugin.replaceable,
          state: plugin.state,
          // Live runtimes keep their listeners while the plugin stays loaded.
          listeners: previous && previous.entry === entry ? previous.listeners : new Set(),
        });
        results.push({ id: plugin.id, loaded: true });
      } catch (error) {
        logger.warn?.(`[plugins] could not load plugin ${plugin.id}: ${error?.message ?? 'unknown error'}`);
        results.push({ id: plugin.id, loaded: false, error: 'The plugin could not be loaded.' });
      }
    }

    const signature = (plugins) => JSON.stringify([...plugins.values()]
      .map(({ id, entry, replaceable }) => [id, entry, replaceable])
      .sort(([a], [b]) => a.localeCompare(b)));
    const enabledChanged = signature(loaded) !== signature(next);
    const previousEntries = new Map([...loaded.values()].map((plugin) => [plugin.id, plugin.entry]));
    const stateChanged = [...next.values()].filter((plugin) => {
      const previous = loaded.get(plugin.id);
      return previous && previous.listeners === plugin.listeners && stateKey(previous.state) !== stateKey(plugin.state);
    });
    loaded = next;
    for (const id of [...registered.keys()]) {
      if (!next.has(id) || loaded.get(id)?.entry !== previousEntries.get(id)) registered.delete(id);
    }
    for (const plugin of stateChanged) notify(plugin);
    return { enabledChanged, plugins: results };
  };

  /**
   * Apply a new config. Calls are serialized. Resolves
   * `{ enabledChanged, plugins: [{ id, loaded, error? }] }`; the caller
   * recreates runtimes when `enabledChanged`.
   */
  const configure = (payload) => {
    const task = queue.then(() => applyConfig(payload));
    queue = task.catch(() => {});
    return task;
  };

  // Pi's extension API is a plain object of closures, so a Proxy that notes
  // the three registration calls and forwards everything else is safe.
  const REGISTRATIONS = { registerTool: 'tool', registerCommand: 'command', registerFlag: 'flag' };
  const recordRegistrations = (id, pi) => new Proxy(pi, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      const kind = typeof property === 'string' ? REGISTRATIONS[property] : undefined;
      if (!kind || typeof value !== 'function') return value;
      return (...args) => {
        const result = value.apply(target, args);
        const name = kind === 'tool' ? args[0]?.name : args[0];
        if (typeof name === 'string' && name.length > 0) {
          const names = registered.get(id) ?? new Set();
          names.add(`${kind}:${name}`);
          registered.set(id, names);
        }
        return result;
      };
    },
  });

  /**
   * Entries for `resourceLoaderOptions.extensionFactories`, added after Pi's
   * built-ins. Each runtime's factory call gets its own `chamber` handle; its
   * state listeners are dropped when that session shuts down.
   */
  const extensionFactories = () => [...loaded.values()].map((plugin) => ({
    name: `pichamber:${plugin.id}`,
    replaceable: plugin.replaceable,
    factory: async (pi) => {
      const runtimeListeners = new Set();
      plugin.listeners.add(runtimeListeners);
      pi.on?.('session_shutdown', () => {
        plugin.listeners.delete(runtimeListeners);
      });
      const chamber = Object.freeze({
        id: plugin.id,
        state: (directory, sessionId) => resolveState(loaded.get(plugin.id) ?? plugin, directory, sessionId),
        onStateChange: (listener) => {
          if (typeof listener !== 'function') return () => {};
          runtimeListeners.add(listener);
          return () => runtimeListeners.delete(listener);
        },
      });
      await plugin.factory(recordRegistrations(plugin.id, pi), chamber);
    },
  }));

  /** id -> `['tool:x', 'command:y', 'flag:z']` for plugins whose factory has run. */
  const registeredNames = () => new Map([...registered.entries()].map(([id, names]) => [id, [...names]]));

  /** Ids of the plugins currently configured and importable. */
  const configuredIds = () => [...loaded.keys()];

  return { configure, extensionFactories, registeredNames, configuredIds };
};
