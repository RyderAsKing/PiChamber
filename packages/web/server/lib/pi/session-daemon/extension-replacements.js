// Finds which PiChamber plugins and Pi built-ins a live runtime left out
// because another extension registers the same tool, command, or flag.
//
// Pi drops a `replaceable` extension in `omitReplacedExtensions`
// (core/resource-loader.js) and keeps no record for plugins. This module is
// pure: it reads the runtime's loaded extensions and the names each plugin
// registered, and reports paths for the caller to turn into path-free ids.
// Recheck it against that function on every SDK upgrade.

import { resolveExtensionName } from './extension-name.js';

const PLUGIN_PATH_PREFIX = '<inline:pichamber:';
const BUILTIN_PATH_PREFIX = 'builtin:';
const KIND_ORDER = ['tool', 'command', 'flag'];

// Pi's warning for a dropped built-in:
// "Extension <path> registers <kind> `<name>`, so built-in extension `<id>` was not loaded. ..."
const BUILTIN_WARNING_PATTERN = /^Extension (.+) registers (tool|command|flag) `([^`]+)`, so built-in extension `([^`]+)` was not loaded\./;

const namesOf = (extension) => [
  ...[...(extension?.tools?.keys?.() ?? [])].map((name) => `tool:${name}`),
  ...[...(extension?.commands?.keys?.() ?? [])].map((name) => `command:${name}`),
  ...[...(extension?.flags?.keys?.() ?? [])].map((name) => `flag:${name}`),
];

const splitName = (qualified) => {
  const index = qualified.indexOf(':');
  return { kind: qualified.slice(0, index), name: qualified.slice(index + 1) };
};

/**
 * Plugins that are configured, did not load, and share a name with a loaded
 * extension Pi does not allow to be replaced.
 *
 * `loaded`: the runtime's `getExtensions().extensions`.
 * `configuredPluginIds`: ids of the plugins the host has configured.
 * `registeredNames`: Map of plugin id to `['tool:x', 'command:y', ...]`.
 * Returns `[{ id, registers: { kind, name }, byLoadedPath }]`.
 */
export const findReplacedPlugins = ({ loaded, configuredPluginIds, registeredNames }) => {
  const extensions = Array.isArray(loaded) ? loaded : [];
  const loadedPaths = new Set(extensions.map((extension) => extension?.path));
  // Same table Pi builds: a later extension's name overwrites an earlier one.
  const taken = new Map();
  for (const extension of extensions) {
    if (!extension || extension.replaceable) continue;
    for (const name of namesOf(extension)) taken.set(name, extension);
  }
  const replaced = [];
  for (const id of configuredPluginIds ?? []) {
    if (loadedPaths.has(`${PLUGIN_PATH_PREFIX}${id}>`)) continue;
    const names = registeredNames?.get?.(id) ?? [];
    const ordered = KIND_ORDER.flatMap((kind) => names.filter((name) => name.startsWith(`${kind}:`)));
    const shared = ordered.find((name) => taken.has(name));
    // Missing with nothing shared: it failed for another reason.
    if (shared === undefined) continue;
    const winner = taken.get(shared);
    replaced.push({
      id,
      registers: splitName(shared),
      byLoadedPath: winner.path,
    });
  }
  return replaced;
};

/**
 * Built-ins Pi reports as dropped. The fact is the warning's `path`
 * (`builtin:<name>`); package and install warnings use other paths. The
 * warning text only fills the optional details, left out when it does not
 * match. Returns `[{ path, registers?, byPath? }]`.
 */
export const findReplacedBuiltins = ({ warnings }) => {
  const found = new Map();
  for (const warning of Array.isArray(warnings) ? warnings : []) {
    if (typeof warning?.path !== 'string' || !warning.path.startsWith(BUILTIN_PATH_PREFIX)) continue;
    const entry = { path: warning.path };
    const match = typeof warning.warning === 'string' ? BUILTIN_WARNING_PATTERN.exec(warning.warning) : null;
    if (match && `${BUILTIN_PATH_PREFIX}${match[4]}` === warning.path) {
      const [, byPath, kind, shown] = match;
      const name = kind === 'command' ? shown.replace(/^\//, '') : kind === 'flag' ? shown.replace(/^--/, '') : shown;
      if (name.length > 0) {
        entry.registers = { kind, name };
        entry.byPath = byPath;
      }
    }
    found.set(warning.path, entry);
  }
  return [...found.values()];
};

/**
 * Both lists for one runtime's `getExtensions()` result, each winner as
 * `by: { path, name }`. `path` is the loaded file (for the caller to map to an
 * item id and then drop); `name` is `nameOf(loadedPath)`, path-free.
 */
export const findReplacements = ({ extensionsResult, configuredPluginIds, registeredNames, nameOf }) => {
  const loaded = Array.isArray(extensionsResult?.extensions) ? extensionsResult.extensions : [];
  const winner = (loadedPath) => {
    const match = loaded.find((extension) => extension?.path === loadedPath);
    return {
      path: typeof match?.resolvedPath === 'string' ? match.resolvedPath : loadedPath,
      name: nameOf(loadedPath),
    };
  };
  return {
    plugins: findReplacedPlugins({ loaded, configuredPluginIds, registeredNames }).map(({ id, registers, byLoadedPath }) => ({
      id,
      registers,
      by: winner(byLoadedPath),
    })),
    builtins: findReplacedBuiltins({ warnings: extensionsResult?.warnings }).map(({ path, registers, byPath }) => ({
      path,
      ...(registers ? { registers } : {}),
      ...(byPath ? { by: winner(byPath) } : {}),
    })),
  };
};

/**
 * `findReplacements` for a live Pi session. Returns `undefined` when the
 * session has no loaded extension result (unknown, not "nothing replaced").
 */
export const describeRuntimeReplacements = ({ session, configuredPluginIds, registeredNames }) => {
  let extensionsResult;
  try {
    extensionsResult = session?.resourceLoader?.getExtensions?.();
  } catch {
    return undefined;
  }
  if (!extensionsResult || !Array.isArray(extensionsResult.extensions)) return undefined;
  return findReplacements({
    extensionsResult,
    configuredPluginIds,
    registeredNames,
    nameOf: (path) => resolveExtensionName(session, path),
  });
};
