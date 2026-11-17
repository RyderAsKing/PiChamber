// Owns what `pi config`, `pi list`, and `pi remove` do for Pi extensions:
// listing what is configured (path-free), turning resources on or off per
// scope, and removing a configured package. `session-daemon.js` routes the
// private commands here and supplies the lock, queue, trust, and runtime
// recreation.
//
// Pi keeps the toggle logic private to its terminal screen
// (`modes/interactive/components/config-selector.js`), so the write functions
// below reimplement it method by method over a settings-manager-like object.
// Recheck them against that file on every SDK upgrade.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

import { LOADED_BUILTIN_EXTENSIONS } from './builtin-extensions.js';

// Pi's `BUILTIN_PATH_PREFIX` (core/source-info.js) is not exported.
// extension-config.test.js pins this against what Pi resolves.
export const BUILTIN_PATH_PREFIX = 'builtin:';

// Resource types Pi's filters know. Only extensions are listed for now; the
// writes already handle every type so skills, prompts, and themes are additive.
const RESOURCE_TYPES = ['extensions', 'skills', 'prompts', 'themes'];
const LISTED_RESOURCE_TYPES = ['extensions'];
const OVERRIDE_STATES = new Set(['inherit', 'load', 'unload']);
const GROUP_ORDER = { package: 0, auto: 1, settings: 2, builtin: 3 };
const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_NAME_LENGTH = 256;
const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

class ExtensionConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const invalid = (message = 'The extension configuration request is invalid.') => new ExtensionConfigError('INVALID_ARGUMENT', message);

// ---------------------------------------------------------------------------
// Path helpers Pi uses but does not export (utils/paths.js, source-info.js).

const isSyntheticPath = (path) => path.startsWith(BUILTIN_PATH_PREFIX) || path.startsWith('<');

const canonicalizePath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const getPathComparisonKey = (path) => (process.platform === 'win32' ? win32.resolve(path).toLowerCase() : resolve(path));

const getResourcePathKey = (path) => (isSyntheticPath(path) ? path : getPathComparisonKey(canonicalizePath(path)));

const isLocalPath = (value) => {
  const trimmed = value.trim();
  return !['npm:', 'git:', 'github:', 'http:', 'https:', 'ssh:', 'builtin:'].some((prefix) => trimmed.startsWith(prefix));
};

const normalizePath = (input) => {
  const normalized = input.trim();
  if (normalized === '~') return homedir();
  if (normalized.startsWith('~/') || (process.platform === 'win32' && normalized.startsWith('~\\'))) {
    return join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
};

const resolvePath = (input, baseDir) => {
  const normalized = normalizePath(input);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(normalizePath(baseDir), normalized);
};

// ---------------------------------------------------------------------------
// Toggle logic, reimplemented from Pi's ResourceList (config-selector.js).
//
// `ctx` is `{ settingsManager, cwd, agentDir, inheritedEnabledByKey }`.
// `item` is `{ path, enabled, metadata, resourceType }`, the shape Pi's
// resolve() returns with the resource type added.

const stripPrefix = (entry) => (entry.startsWith('!') || entry.startsWith('+') || entry.startsWith('-') ? entry.slice(1) : entry);

const getPatternEntryTarget = stripPrefix;

const getItemScope = (item) => (item.metadata.scope === 'project' ? 'project' : 'user');

export const getResourceItemKey = (item) => `${item.resourceType}:${getResourcePathKey(item.path)}`;

const getTopLevelBaseDir = (ctx, scope) => (scope === 'project' ? join(ctx.cwd, CONFIG_DIR_NAME) : ctx.agentDir);

const getResourcePattern = (ctx, item) => {
  if (item.metadata.source === 'builtin') return item.path;
  const baseDir = item.metadata.baseDir ?? getTopLevelBaseDir(ctx, item.metadata.scope);
  return relative(baseDir, item.path);
};

const getPackageResourcePattern = (item) => {
  const baseDir = item.metadata.baseDir ?? dirname(item.path);
  return relative(baseDir, item.path);
};

const getResourcePatternForScope = (ctx, item, scope) => {
  const sourceScope = getItemScope(item);
  if (scope !== sourceScope || item.metadata.source === 'builtin') return item.path;
  const baseDir = item.metadata.baseDir ?? getTopLevelBaseDir(ctx, sourceScope);
  return relative(baseDir, item.path);
};

const getTopLevelOverridePatterns = (ctx, item, scope) => {
  const baseDir = getTopLevelBaseDir(ctx, scope);
  const patterns = new Set([
    getResourcePatternForScope(ctx, item, scope),
    item.path,
    relative(baseDir, item.path),
  ]);
  if (item.metadata.baseDir) patterns.add(relative(item.metadata.baseDir, item.path));
  return patterns;
};

const packageSourceStringMatches = (ctx, leftSource, leftScope, rightSource, rightScope) => {
  if (leftSource === rightSource) return true;
  if (!isLocalPath(leftSource) || !isLocalPath(rightSource)) return false;
  const left = resolvePath(leftSource, getTopLevelBaseDir(ctx, leftScope));
  const right = resolvePath(rightSource, getTopLevelBaseDir(ctx, rightScope));
  return left === right;
};

const findMatchingPackageSource = (ctx, item, targetScope) => {
  const settings = targetScope === 'project'
    ? ctx.settingsManager.getProjectSettings()
    : ctx.settingsManager.getGlobalSettings();
  return (settings.packages ?? []).find((pkg) => packageSourceStringMatches(
    ctx,
    item.metadata.source,
    getItemScope(item),
    typeof pkg === 'string' ? pkg : pkg.source,
    targetScope,
  ));
};

export const createPackageOverrideSource = (ctx, item) => {
  const source = item.metadata.source;
  if (!isLocalPath(source)) return { source, autoload: false };
  const sourcePath = resolvePath(source, getTopLevelBaseDir(ctx, getItemScope(item)));
  return { source: relative(getTopLevelBaseDir(ctx, 'project'), sourcePath) || '.', autoload: false };
};

const isInheritedGlobalItem = (ctx, item) => (
  getItemScope(item) === 'user' || ctx.inheritedEnabledByKey.has(getResourceItemKey(item))
);

export const getInheritedEnabled = (ctx, item) => (
  ctx.inheritedEnabledByKey.get(getResourceItemKey(item))
  ?? (getItemScope(item) === 'user' ? item.enabled : true)
);

export const getOverrideStateFromEntries = (entries, patterns, emptyArrayIsUnload) => {
  if (entries.length === 0 && emptyArrayIsUnload) return 'unload';
  let state = 'inherit';
  for (const entry of entries) {
    if (!patterns.has(getPatternEntryTarget(entry))) continue;
    state = entry.startsWith('!') || entry.startsWith('-') ? 'unload' : 'load';
  }
  return state;
};

// The project's own override for an item (Pi reads this only in project mode).
export const getProjectOverrideState = (ctx, item) => {
  if (item.metadata.origin === 'top-level') {
    return getOverrideStateFromEntries(
      ctx.settingsManager.getProjectSettings()[item.resourceType] ?? [],
      getTopLevelOverridePatterns(ctx, item, 'project'),
      false,
    );
  }
  const pkg = findMatchingPackageSource(ctx, item, 'project');
  if (typeof pkg !== 'object' || pkg === null) return 'inherit';
  const entries = pkg[item.resourceType];
  if (entries === undefined) return 'inherit';
  return getOverrideStateFromEntries(entries, new Set([getPackageResourcePattern(item)]), pkg.autoload !== false);
};

const setTopLevelPaths = (settingsManager, scope, key, paths) => {
  if (scope === 'project') {
    if (key === 'extensions') settingsManager.setProjectExtensionPaths(paths);
    else if (key === 'skills') settingsManager.setProjectSkillPaths(paths);
    else if (key === 'prompts') settingsManager.setProjectPromptTemplatePaths(paths);
    else settingsManager.setProjectThemePaths(paths);
    return;
  }
  if (key === 'extensions') settingsManager.setExtensionPaths(paths);
  else if (key === 'skills') settingsManager.setSkillPaths(paths);
  else if (key === 'prompts') settingsManager.setPromptTemplatePaths(paths);
  else settingsManager.setThemePaths(paths);
};

// Global mode, top-level resource: replace any `!`/`+`/`-` entry for the
// pattern with `+pattern` or `-pattern` in the item's own scope.
export const toggleTopLevelResource = (ctx, item, enabled) => {
  const scope = item.metadata.scope;
  const settings = scope === 'project' ? ctx.settingsManager.getProjectSettings() : ctx.settingsManager.getGlobalSettings();
  const current = settings[item.resourceType] ?? [];
  const pattern = getResourcePattern(ctx, item);
  const updated = current.filter((entry) => stripPrefix(entry) !== pattern);
  updated.push(`${enabled ? '+' : '-'}${pattern}`);
  setTopLevelPaths(ctx.settingsManager, scope === 'project' ? 'project' : 'user', item.resourceType, updated);
};

// Global mode, package resource: object form with a per-type filter, back to
// the plain string when no filter is left.
export const togglePackageResource = (ctx, item, enabled) => {
  const scope = item.metadata.scope;
  const settings = scope === 'project' ? ctx.settingsManager.getProjectSettings() : ctx.settingsManager.getGlobalSettings();
  const packages = [...(settings.packages ?? [])];
  const pkgIndex = packages.findIndex((pkg) => (typeof pkg === 'string' ? pkg : pkg.source) === item.metadata.source);
  if (pkgIndex === -1) return false;
  let pkg = packages[pkgIndex];
  if (typeof pkg === 'string') {
    pkg = { source: pkg };
    packages[pkgIndex] = pkg;
  }
  const current = pkg[item.resourceType] ?? [];
  const pattern = getPackageResourcePattern(item);
  const updated = current.filter((entry) => stripPrefix(entry) !== pattern);
  updated.push(`${enabled ? '+' : '-'}${pattern}`);
  pkg[item.resourceType] = updated.length > 0 ? updated : undefined;
  if (!RESOURCE_TYPES.some((key) => pkg[key] !== undefined)) packages[pkgIndex] = pkg.source;
  if (scope === 'project') ctx.settingsManager.setProjectPackages(packages);
  else ctx.settingsManager.setPackages(packages);
  return true;
};

const setProjectTopLevelOverride = (ctx, item, state) => {
  const current = ctx.settingsManager.getProjectSettings()[item.resourceType] ?? [];
  const inherited = isInheritedGlobalItem(ctx, item);
  const pattern = inherited ? item.path : getResourcePatternForScope(ctx, item, 'project');
  const patterns = getTopLevelOverridePatterns(ctx, item, 'project');
  const updated = current.filter((entry) => {
    const target = getPatternEntryTarget(entry);
    if ((entry.startsWith('!') || entry.startsWith('+') || entry.startsWith('-')) && patterns.has(target)) return false;
    return !(state === 'inherit' && inherited && target === pattern);
  });
  if (state !== 'inherit') {
    // Project entries name inherited files to override them. Built-in paths need no entry.
    if (inherited && item.metadata.source !== 'builtin' && !updated.includes(pattern)) updated.push(pattern);
    updated.push(`${state === 'load' ? '+' : '-'}${pattern}`);
  }
  setTopLevelPaths(ctx.settingsManager, 'project', item.resourceType, updated);
  return true;
};

const setProjectPackageOverride = (ctx, item, state) => {
  const packages = [...(ctx.settingsManager.getProjectSettings().packages ?? [])];
  let pkgIndex = packages.findIndex((pkg) => packageSourceStringMatches(
    ctx,
    item.metadata.source,
    getItemScope(item),
    typeof pkg === 'string' ? pkg : pkg.source,
    'project',
  ));
  if (pkgIndex === -1) {
    if (state === 'inherit') return false;
    packages.push(createPackageOverrideSource(ctx, item));
    pkgIndex = packages.length - 1;
  }
  let pkg = packages[pkgIndex];
  if (pkg === undefined) return false;
  if (typeof pkg === 'string') {
    pkg = { source: pkg };
    packages[pkgIndex] = pkg;
  }
  const pattern = getPackageResourcePattern(item);
  const updated = (pkg[item.resourceType] ?? []).filter((entry) => getPatternEntryTarget(entry) !== pattern);
  if (state !== 'inherit') updated.push(`${state === 'load' ? '+' : '-'}${pattern}`);
  pkg[item.resourceType] = updated.length > 0 ? updated : undefined;
  if (!RESOURCE_TYPES.some((key) => pkg[key] !== undefined)) {
    if (pkg.autoload === false) packages.splice(pkgIndex, 1);
    else packages[pkgIndex] = pkg.source;
  }
  ctx.settingsManager.setProjectPackages(packages);
  return true;
};

export const setProjectResourceOverride = (ctx, item, state) => (
  item.metadata.origin === 'top-level'
    ? setProjectTopLevelOverride(ctx, item, state)
    : setProjectPackageOverride(ctx, item, state)
);

// Global mode write. Like `pi config`, only user-scope items toggle here.
export const setGlobalResourceEnabled = (ctx, item, enabled) => {
  if (getItemScope(item) !== 'user') return false;
  if (item.metadata.origin === 'top-level') {
    toggleTopLevelResource(ctx, item, enabled);
    return true;
  }
  return togglePackageResource(ctx, item, enabled);
};

// ---------------------------------------------------------------------------
// Path-free display forms.

const hashId = (...parts) => createHash('sha256').update(parts.join('\0')).digest('base64url');

const sanitizeName = (value) => {
  const cleaned = String(value).replace(/\\/g, '/').slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : 'unknown';
};

// `pi config`'s display name: the built-in name, `parent/file` for an
// extension whose parent folder is not `extensions`, else the file name.
const resourceDisplayName = (item) => {
  if (item.metadata.source === 'builtin') return sanitizeName(item.path.slice(BUILTIN_PATH_PREFIX.length));
  const fileName = basename(item.path);
  const parentFolder = basename(dirname(item.path));
  if (item.resourceType === 'extensions' && parentFolder !== 'extensions' && parentFolder.length > 0) {
    return sanitizeName(`${parentFolder}/${fileName}`);
  }
  if (item.resourceType === 'skills' && fileName === 'SKILL.md' && parentFolder.length > 0) return sanitizeName(parentFolder);
  return sanitizeName(fileName);
};

// Removes URL userinfo (`user:token@`) from any `scheme://` authority.
export const stripUrlCredentials = (value) => value.replace(
  /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#\s]*@)/g,
  (_match, scheme) => scheme,
);

const packageKind = (source) => {
  const trimmed = source.trim();
  if (trimmed.startsWith('npm:')) return 'npm';
  if (isLocalPath(trimmed)) return 'local';
  return 'git';
};

// npm and git: as written in settings, credentials stripped. Local: the
// folder name only.
export const displayPackageSource = (source, baseDir) => {
  const kind = packageKind(source);
  if (kind !== 'local') return stripUrlCredentials(source.trim()).slice(0, MAX_NAME_LENGTH);
  const resolved = baseDir ? resolvePath(source, baseDir) : source.trim().replace(/[\\/]+$/, '');
  return sanitizeName(basename(resolved) || 'local');
};

const parseNpmName = (spec) => spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)?.[1] ?? spec;

// Pi's package identity (npm by name, local by resolved path); git sources
// keep their written form minus credentials.
const packageIdentity = (source, baseDir) => {
  const kind = packageKind(source);
  if (kind === 'npm') return `npm:${parseNpmName(source.trim().slice('npm:'.length).trim())}`;
  if (kind === 'git') return `git:${stripUrlCredentials(source.trim())}`;
  return `local:${getPathComparisonKey(resolvePath(source, baseDir))}`;
};

const packageId = (scope, identity) => hashId('package', scope, identity);

const resourceId = (resourceType, scope, item) => hashId(
  resourceType,
  scope,
  item.metadata.source === 'builtin' ? item.path : getResourcePathKey(item.path),
);

// Error text from npm, git, or the SDK: server paths and credentials removed,
// length capped.
export const sanitizeErrorMessage = (message, knownPaths = []) => {
  let text = typeof message === 'string' ? message : String(message ?? '');
  for (const path of [...knownPaths].filter((value) => typeof value === 'string' && value.length > 1).sort((a, b) => b.length - a.length)) {
    text = text.split(path).join('<path>');
  }
  text = stripUrlCredentials(text)
    .replace(/(^|[\s'"`(=:])(?:[A-Za-z]:)?~?[\\/](?!\/)[^\s'"`)]*/g, '$1<path>')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > MAX_ERROR_MESSAGE_LENGTH) text = `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`;
  return text.length > 0 ? text : 'The operation failed.';
};

const groupOf = (metadata) => {
  if (metadata.origin === 'package') return 'package';
  if (metadata.source === 'builtin') return 'builtin';
  if (metadata.source === 'auto') return 'auto';
  return 'settings';
};

// ---------------------------------------------------------------------------
// Service.

const defaultCreateSettingsManager = ({ cwd, agentDir, projectTrusted }) => SettingsManager.create(cwd, agentDir, { projectTrusted });
const defaultCreatePackageManager = (options) => new DefaultPackageManager(options);

export function createExtensionConfig({
  agentDir,
  createSettingsManager = defaultCreateSettingsManager,
  createPackageManager = defaultCreatePackageManager,
  builtinExtensions = LOADED_BUILTIN_EXTENSIONS.map((entry) => entry.name),
} = {}) {
  if (typeof agentDir !== 'string' || agentDir.length === 0) throw new TypeError('agentDir is required.');

  const baseDirFor = (scope, cwd) => (scope === 'project' ? join(cwd, CONFIG_DIR_NAME) : agentDir);

  // Never installs: a missing package is skipped and shows `installed: false`.
  const resolveView = async (cwd, projectTrusted) => {
    const settingsManager = createSettingsManager({ cwd, agentDir, projectTrusted });
    const packageManager = createPackageManager({ cwd, agentDir, settingsManager, builtinExtensions: [...builtinExtensions] });
    const resolved = await packageManager.resolve(async () => 'skip');
    return { settingsManager, packageManager, resolved };
  };

  const itemsOf = (resolved) => LISTED_RESOURCE_TYPES.flatMap((resourceType) => (
    (Array.isArray(resolved?.[resourceType]) ? resolved[resourceType] : [])
      .filter((entry) => entry && typeof entry.path === 'string' && entry.metadata)
      .map((entry) => ({ path: entry.path, enabled: entry.enabled !== false, metadata: entry.metadata, resourceType }))
  ));

  /**
   * Builds both views like `pi config` does. `target` is
   * `{ cwd, directory?, trusted }`; `cwd` is where the global view resolves.
   */
  const snapshot = async ({ cwd, directory, trusted }) => {
    const globalCwd = directory ?? cwd;
    const global = await resolveView(globalCwd, false);
    const project = directory && trusted ? await resolveView(directory, true) : null;
    const globalItems = itemsOf(global.resolved);
    const inheritedEnabledByKey = new Map(globalItems.map((item) => [getResourceItemKey(item), item.enabled]));
    const ctxFor = (view, viewCwd) => ({ settingsManager: view.settingsManager, cwd: viewCwd, agentDir, inheritedEnabledByKey });
    const globalCtx = ctxFor(global, globalCwd);
    const projectCtx = project ? ctxFor(project, directory) : null;

    // The same file or built-in keeps one id in both views: an item the
    // global view lists is declared there (user scope).
    const globalById = new Map();
    for (const item of globalItems) globalById.set(resourceId(item.resourceType, 'user', item), item);
    const projectById = new Map();
    if (project) {
      for (const item of itemsOf(project.resolved)) {
        const declared = inheritedEnabledByKey.has(getResourceItemKey(item)) ? 'user' : getItemScope(item);
        projectById.set(resourceId(item.resourceType, declared, item), item);
      }
    }
    return { global, project, globalCtx, projectCtx, globalById, projectById, globalCwd };
  };

  // Turns the daemon's replacement facts (which carry file paths) into the
  // path-free `replaced` list. Item ids come from this response's own
  // `extensions` array; a winner that is not listed gets only its display name.
  const projectReplaced = (replacements, snap, extensions) => {
    const itemEntries = [...snap.globalById, ...(snap.projectById ?? [])];
    const nameById = new Map(extensions.map((entry) => [entry.id, entry.name]));
    const idByPathKey = new Map();
    const idByBuiltinPath = new Map();
    for (const [id, item] of itemEntries) {
      if (!nameById.has(id)) continue;
      if (item.metadata.source === 'builtin') idByBuiltinPath.set(item.path, id);
      else if (!idByPathKey.has(getResourcePathKey(item.path))) idByPathKey.set(getResourcePathKey(item.path), id);
    }
    const winner = (by) => {
      if (!by || typeof by.name !== 'string') return undefined;
      const id = typeof by.path === 'string' ? idByPathKey.get(getResourcePathKey(by.path)) : undefined;
      return id ? { id, name: nameById.get(id) } : { name: sanitizeName(by.name) };
    };
    const detail = (entry) => ({
      ...(entry.registers ? { registers: { kind: entry.registers.kind, name: sanitizeName(entry.registers.name) } } : {}),
      ...(winner(entry.by) ? { by: winner(entry.by) } : {}),
    });
    const replaced = [];
    for (const plugin of replacements.plugins ?? []) {
      replaced.push({ kind: 'plugin', id: plugin.id, ...detail(plugin) });
    }
    for (const builtin of replacements.builtins ?? []) {
      const id = idByBuiltinPath.get(builtin.path);
      if (id) replaced.push({ kind: 'builtin', id, ...detail(builtin) });
    }
    return replaced;
  };

  const buildResponse = (snap, { directory, trusted }, replacements) => {
    const { global, project, projectCtx, globalById, projectById, globalCwd } = snap;
    const listing = project ?? global;
    const configured = listing.packageManager.listConfiguredPackages();
    const packages = [];
    const packageIdBySourceScope = new Map();
    const entries = (Array.isArray(configured) ? configured : [])
      .filter((pkg) => pkg && typeof pkg.source === 'string' && (pkg.scope === 'user' || pkg.scope === 'project'))
      .map((pkg) => {
        const baseDir = baseDirFor(pkg.scope, project ? directory : globalCwd);
        return { pkg, baseDir, identity: packageIdentity(pkg.source, baseDir) };
      });
    // A project entry with `autoload: false` for a package the user already
    // has is where Pi keeps that project's overrides (see
    // `createPackageOverrideSource`). It is not a second package: its
    // extensions stay listed under the user's package.
    const userIdentities = new Set(entries.filter((entry) => entry.pkg.scope === 'user').map((entry) => entry.identity));
    const projectPackageSettings = listing.settingsManager.getProjectSettings?.().packages ?? [];
    const isOverrideRecord = ({ pkg, identity }) => pkg.scope === 'project' && userIdentities.has(identity)
      && projectPackageSettings.some((entry) => entry && typeof entry === 'object' && entry.source === pkg.source && entry.autoload === false);
    for (const entry of entries) {
      const { pkg, baseDir, identity } = entry;
      const id = packageId(pkg.scope, identity);
      if (isOverrideRecord(entry)) continue;
      packageIdBySourceScope.set(`${pkg.scope}\0${pkg.source}`, id);
      packages.push({
        id,
        source: displayPackageSource(pkg.source, baseDir),
        scope: pkg.scope,
        kind: packageKind(pkg.source),
        installed: typeof pkg.installedPath === 'string' && pkg.installedPath.length > 0,
        filtered: pkg.filtered === true,
      });
    }
    packages.sort((a, b) => (a.scope === b.scope ? a.source.localeCompare(b.source) : a.scope === 'user' ? -1 : 1));
    const packageRank = new Map(packages.map((pkg, index) => [pkg.id, index]));

    const extensions = [];
    const ids = new Set([...globalById.keys(), ...projectById.keys()]);
    for (const id of ids) {
      const globalItem = globalById.get(id);
      const projectItem = projectById.get(id);
      const item = globalItem ?? projectItem;
      const group = groupOf(item.metadata);
      const scope = globalItem ? 'user' : getItemScope(item);
      const pkgId = group === 'package'
        ? packageIdBySourceScope.get(`${item.metadata.scope === 'project' ? 'project' : 'user'}\0${item.metadata.source}`)
        : undefined;
      extensions.push({
        id,
        name: resourceDisplayName(item),
        group,
        ...(pkgId ? { packageId: pkgId } : {}),
        scope,
        ...(globalItem ? { global: globalItem.enabled } : {}),
        ...(projectItem && projectCtx ? {
          project: {
            state: getProjectOverrideState(projectCtx, projectItem),
            inherited: getInheritedEnabled(projectCtx, projectItem),
            enabled: projectItem.enabled,
          },
        } : {}),
      });
    }
    extensions.sort((a, b) => {
      if (a.group !== b.group) return GROUP_ORDER[a.group] - GROUP_ORDER[b.group];
      if (a.group === 'package' && a.packageId !== b.packageId) {
        return (packageRank.get(a.packageId) ?? Infinity) - (packageRank.get(b.packageId) ?? Infinity);
      }
      if (a.scope !== b.scope) return a.scope === 'user' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const failures = new Map();
    for (const view of [global, project]) {
      for (const failure of view?.resolved?.installFailures ?? []) {
        if (!failure || typeof failure.source !== 'string') continue;
        const scope = failure.scope === 'project' ? 'project' : 'user';
        const baseDir = baseDirFor(scope, project ? directory : globalCwd);
        const source = displayPackageSource(failure.source, baseDir);
        failures.set(`${scope}\0${source}`, {
          source,
          message: sanitizeErrorMessage(failure.message, [agentDir, directory, globalCwd, homedir()]),
        });
      }
    }

    return {
      ...(directory ? { directory } : {}),
      project: { available: Boolean(directory), trusted: Boolean(directory && trusted) },
      packages,
      extensions,
      installFailures: [...failures.values()],
      // Present only when a live runtime answered; absent means unknown.
      ...(replacements ? { replaced: projectReplaced(replacements, snap, extensions) } : {}),
    };
  };

  /**
   * `replacements` is optional: `{ plugins: [{ id, registers?, by?: { path, name } }],
   * builtins: [{ path, registers?, by? }] }` from `extension-replacements.js`.
   * Without it the answer has no `replaced` field.
   */
  const list = async (target, replacements) => buildResponse(await snapshot(target), target, replacements);

  const assertWritable = (settingsManager) => {
    if (settingsManager.drainErrors().length > 0) {
      throw new ExtensionConfigError('PI_SETTINGS_INVALID', 'Pi settings could not be read.');
    }
  };

  const commit = async (settingsManager) => {
    await settingsManager.flush();
    if (settingsManager.drainErrors().length > 0) {
      throw new ExtensionConfigError('PI_SETTINGS_INVALID', 'Pi settings could not be written.');
    }
  };

  /**
   * Validates a set request. Returns the parsed request; throws
   * `INVALID_ARGUMENT` for a malformed one.
   */
  const parseSetRequest = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid();
    if (typeof payload.id !== 'string' || !ID_PATTERN.test(payload.id)) throw invalid();
    if (payload.scope === 'global') {
      if (typeof payload.enabled !== 'boolean' || payload.state !== undefined) throw invalid();
      return { id: payload.id, scope: 'global', enabled: payload.enabled };
    }
    if (payload.scope === 'project') {
      // Either the override itself, or just on/off: `set` then picks the
      // override against the settings it reads under the lock.
      if (payload.state === undefined && typeof payload.enabled === 'boolean') {
        return { id: payload.id, scope: 'project', enabled: payload.enabled };
      }
      if (!OVERRIDE_STATES.has(payload.state) || payload.enabled !== undefined) throw invalid();
      return { id: payload.id, scope: 'project', state: payload.state };
    }
    throw invalid();
  };

  /**
   * Writes one toggle. The caller holds the shared Pi config lock and the
   * resource mutation queue, resolved `target.directory`, and read
   * `target.trusted` inside the lock.
   */
  const set = async (target, payload) => {
    const request = parseSetRequest(payload);
    if (request.scope === 'project') {
      if (!target.directory) throw invalid('Project scope requires a directory.');
      if (!target.trusted) throw new ExtensionConfigError('PROJECT_UNTRUSTED', 'The project is not trusted.');
    }
    const snap = await snapshot(target);
    if (request.scope === 'global') {
      const item = snap.globalById.get(request.id);
      if (!item) {
        if (snap.projectById.has(request.id)) throw invalid('Only user resources can be changed in global scope.');
        throw new ExtensionConfigError('RESOURCE_NOT_FOUND', 'The requested extension was not found.');
      }
      // Writes go through a fresh manager so nothing the listing cached is
      // written back.
      const settingsManager = createSettingsManager({ cwd: snap.globalCwd, agentDir, projectTrusted: Boolean(target.directory && target.trusted) });
      assertWritable(settingsManager);
      const ctx = { ...snap.globalCtx, settingsManager };
      if (!setGlobalResourceEnabled(ctx, item, request.enabled)) {
        throw new ExtensionConfigError('PACKAGE_NOT_CONFIGURED', 'The package is no longer configured.');
      }
      await commit(settingsManager);
      return;
    }
    const item = snap.projectById.get(request.id);
    if (!item) throw new ExtensionConfigError('RESOURCE_NOT_FOUND', 'The requested extension was not found.');
    const settingsManager = createSettingsManager({ cwd: target.directory, agentDir, projectTrusted: true });
    assertWritable(settingsManager);
    const ctx = { ...snap.projectCtx, settingsManager };
    // On/off keeps no project entry when the project would get that value
    // anyway. The client cannot decide this: its copy of the global value may
    // be older than a change made in a terminal or another tab.
    const state = request.state
      ?? (request.enabled === getInheritedEnabled(snap.projectCtx, item) ? 'inherit' : request.enabled ? 'load' : 'unload');
    // Pi reports no change for "inherit" on a package with no project entry.
    if (setProjectResourceOverride(ctx, item, state)) await commit(settingsManager);
  };

  /**
   * Removes one configured package through Pi's `removeAndPersist`. Same
   * locking contract as `set`. PiChamber deletes no path itself.
   */
  const removePackage = async (target, payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || typeof payload.id !== 'string' || !ID_PATTERN.test(payload.id)) {
      throw invalid();
    }
    const projectTrusted = Boolean(target.directory && target.trusted);
    const globalCwd = target.directory ?? target.cwd;
    const settingsManager = createSettingsManager({ cwd: globalCwd, agentDir, projectTrusted });
    const packageManager = createPackageManager({ cwd: globalCwd, agentDir, settingsManager, builtinExtensions: [...builtinExtensions] });
    const configured = packageManager.listConfiguredPackages();
    const match = (Array.isArray(configured) ? configured : []).find((pkg) => (
      pkg && typeof pkg.source === 'string' && (pkg.scope === 'user' || pkg.scope === 'project')
      && packageId(pkg.scope, packageIdentity(pkg.source, baseDirFor(pkg.scope, globalCwd))) === payload.id
    ));
    if (!match) throw new ExtensionConfigError('RESOURCE_NOT_FOUND', 'The requested package was not found.');
    if (match.scope === 'project' && !projectTrusted) {
      throw new ExtensionConfigError('PROJECT_UNTRUSTED', 'The project is not trusted.');
    }
    assertWritable(settingsManager);
    // Pi matches the source as if it were typed after `pi remove`: a relative
    // local path is read against the working directory. Settings keep it
    // relative to their own folder, so a local package goes in as the
    // absolute path it names there.
    const source = packageKind(match.source) === 'local'
      ? resolvePath(match.source, baseDirFor(match.scope, globalCwd))
      : match.source;
    let removed;
    try {
      removed = await packageManager.removeAndPersist(source, { local: match.scope === 'project' });
    } catch (error) {
      throw new ExtensionConfigError(
        'PACKAGE_REMOVE_FAILED',
        sanitizeErrorMessage(error instanceof Error ? error.message : error, [agentDir, globalCwd, homedir()]),
      );
    }
    // The package files may already be gone here. A settings write that
    // fails now leaves an entry for a missing package: report it, never
    // success.
    await commit(settingsManager);
    if (!removed) throw new ExtensionConfigError('PACKAGE_NOT_CONFIGURED', 'Pi settings had no entry for the package.');
  };

  return { list, set, removePackage };
}
