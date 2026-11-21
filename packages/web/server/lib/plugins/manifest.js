import { isAbsolute, relative, resolve } from 'node:path';

// A plugin is a Pi package whose package.json carries a `pichamber` block.
// Parsing fails closed: any field that is missing, of the wrong type, or out
// of range rejects the whole plugin with a short reason.

const PLUGIN_API_VERSION = 1;

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_ID_LENGTH = 40;
const STATE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const ICON_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_NAME = 60;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 240;
const MAX_STATE_KEYS = 32;
const MAX_ENUM_OPTIONS = 32;
const MAX_TOGGLES = 4;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
// Discovery keywords every Pi package or PiChamber plugin carries; they say
// nothing about what one plugin does, so they are left out of its keywords.
const DISCOVERY_KEYWORDS = new Set(['pi-package', 'pichamber']);
const MAX_KEYWORDS = 16;
const MAX_KEYWORD_LENGTH = 40;

class PluginManifestError extends Error {
  constructor(reason) {
    super(reason);
    this.code = 'INVALID_PLUGIN_MANIFEST';
  }
}

const fail = (reason) => {
  throw new PluginManifestError(reason);
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value, max, field, { optional = false } = {}) => {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) fail(`${field} is invalid`);
  return value.trim();
};

const pluginId = (value, field) => {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH || !ID_PATTERN.test(value)) fail(`${field} is invalid`);
  return value;
};

const icon = (value, field) => {
  if (typeof value !== 'string' || value.length > 64 || !ICON_PATTERN.test(value)) fail(`${field} is invalid`);
  return value;
};

const parseStateField = (key, value) => {
  if (!isRecord(value)) fail(`state.${key} is invalid`);
  const { type, scope } = value;
  if (type !== 'boolean' && type !== 'enum') fail(`state.${key}.type is invalid`);
  if (scope !== 'global' && scope !== 'project') fail(`state.${key}.scope is invalid`);
  const label = text(value.label, MAX_LABEL, `state.${key}.label`);
  const description = text(value.description, MAX_DESCRIPTION, `state.${key}.description`, { optional: true });
  const field = { type, scope, default: value.default, label };
  if (description) field.description = description;
  if (type === 'boolean') {
    if (typeof value.default !== 'boolean') fail(`state.${key}.default is invalid`);
    if (value.options !== undefined) fail(`state.${key}.options is only for enum values`);
    return field;
  }
  if (!Array.isArray(value.options) || value.options.length === 0 || value.options.length > MAX_ENUM_OPTIONS) {
    fail(`state.${key}.options is invalid`);
  }
  const seen = new Set();
  field.options = value.options.map((option, index) => {
    if (!isRecord(option) || typeof option.value !== 'string' || option.value.length === 0 || option.value.length > 64) {
      fail(`state.${key}.options[${index}] is invalid`);
    }
    if (seen.has(option.value)) fail(`state.${key}.options repeats ${option.value}`);
    seen.add(option.value);
    return { value: option.value, label: text(option.label, MAX_LABEL, `state.${key}.options[${index}].label`) };
  });
  if (typeof value.default !== 'string' || !seen.has(value.default)) fail(`state.${key}.default is invalid`);
  return field;
};

const parseState = (value) => {
  if (value === undefined) return {};
  if (!isRecord(value)) fail('state is invalid');
  const entries = Object.entries(value);
  if (entries.length > MAX_STATE_KEYS) fail('state has too many values');
  const schema = {};
  for (const [key, field] of entries) {
    if (!STATE_KEY_PATTERN.test(key) || FORBIDDEN_KEYS.has(key)) fail(`state key ${key} is invalid`);
    schema[key] = parseStateField(key, field);
  }
  return schema;
};

const parseContributes = (value, stateSchema) => {
  if (value === undefined) return { composerToggles: [], settings: [] };
  if (!isRecord(value)) fail('contributes is invalid');
  // `contributes.controls` are composer controls whose value PiChamber
  // stores (`state`), where `pichamber.control()` declares ones the
  // extension stores (`command`). Only toggles can be stored today.
  const toggles = value.controls ?? [];
  if (!Array.isArray(toggles) || toggles.length > MAX_TOGGLES) fail('contributes.controls is invalid');
  const toggleIds = new Set();
  const composerToggles = toggles.map((toggle, index) => {
    const field = `contributes.controls[${index}]`;
    if (!isRecord(toggle)) fail(`${field} is invalid`);
    if (toggle.kind !== 'toggle') fail(`${field}.kind must be toggle`);
    const id = pluginId(toggle.id, `${field}.id`);
    if (toggleIds.has(id)) fail(`${field}.id repeats`);
    toggleIds.add(id);
    if (typeof toggle.state !== 'string' || stateSchema[toggle.state]?.type !== 'boolean') {
      fail(`${field}.state must name a boolean state value`);
    }
    const description = text(toggle.description, MAX_DESCRIPTION, `${field}.description`, { optional: true });
    return {
      id,
      state: toggle.state,
      label: text(toggle.label, MAX_LABEL, `${field}.label`),
      icon: icon(toggle.icon, `${field}.icon`),
      ...(description ? { description } : {}),
    };
  });
  const settingsInput = value.settings ?? [];
  if (!Array.isArray(settingsInput)) fail('contributes.settings is invalid');
  const settings = [];
  for (const key of settingsInput) {
    if (typeof key !== 'string' || !Object.hasOwn(stateSchema, key)) fail('contributes.settings names an unknown state value');
    if (settings.includes(key)) fail(`contributes.settings repeats ${key}`);
    // A composer switch's default is the plugin's own switch in Settings; a
    // second Settings control for it would be a confusing duplicate.
    if (composerToggles.some((toggle) => toggle.state === key)) fail(`contributes.settings lists ${key}, which a composer control sets`);
    settings.push(key);
  }
  const contributes = { composerToggles, settings };
  if (value.ui !== undefined) contributes.ui = pluginId(value.ui, 'contributes.ui');
  return contributes;
};

/**
 * The agent half is the package's first `pi.extensions` entry. It must be a
 * relative path that stays inside the package folder.
 */
const parseEntry = (packageJson, packageDir) => {
  const extensions = packageJson?.pi?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) fail('pi.extensions is missing');
  const entry = extensions[0];
  if (typeof entry !== 'string' || entry.length === 0 || isAbsolute(entry)) fail('pi.extensions[0] is invalid');
  const absolute = resolve(packageDir, entry);
  const fromPackage = relative(packageDir, absolute);
  if (fromPackage.length === 0 || fromPackage.startsWith('..') || isAbsolute(fromPackage)) {
    fail('pi.extensions[0] leaves the package');
  }
  if (!/\.m?js$/.test(absolute)) fail('pi.extensions[0] must be a JavaScript module');
  return absolute;
};

/**
 * What the plugin is about, for matching a marketplace search to it: the
 * package keywords without the discovery ones. Bad entries are skipped, not
 * fatal, since they only help search.
 */
const parseKeywords = (value) => {
  if (!Array.isArray(value)) return [];
  const keywords = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const keyword = entry.trim().toLowerCase();
    if (keyword.length === 0 || keyword.length > MAX_KEYWORD_LENGTH || DISCOVERY_KEYWORDS.has(keyword) || keywords.includes(keyword)) continue;
    keywords.push(keyword);
    if (keywords.length === MAX_KEYWORDS) break;
  }
  return keywords;
};

/**
 * Parse one plugin package. `packageDir` must be absolute. Returns the
 * normalized manifest or throws `PluginManifestError`.
 */
export const parsePluginPackage = (packageJson, { packageDir, bundled = false }) => {
  if (!isRecord(packageJson)) fail('package.json is invalid');
  if (typeof packageDir !== 'string' || !isAbsolute(packageDir)) fail('package folder is invalid');
  const block = packageJson.pichamber;
  if (!isRecord(block)) fail('pichamber block is missing');
  if (block.apiVersion !== PLUGIN_API_VERSION) fail('pichamber.apiVersion is unsupported');
  const id = pluginId(block.id, 'pichamber.id');
  if (typeof packageJson.version !== 'string' || !VERSION_PATTERN.test(packageJson.version)) fail('version is invalid');
  const defaultEnabled = block.defaultEnabled ?? false;
  if (typeof defaultEnabled !== 'boolean') fail('pichamber.defaultEnabled is invalid');
  if (bundled && defaultEnabled) fail('a bundled plugin must ship disabled');
  if (block.replaceable !== undefined && typeof block.replaceable !== 'boolean') fail('pichamber.replaceable is invalid');
  const stateSchema = parseState(block.state);
  return {
    id,
    name: text(block.name, MAX_NAME, 'pichamber.name'),
    description: text(block.description, MAX_DESCRIPTION, 'pichamber.description'),
    icon: icon(block.icon, 'pichamber.icon'),
    version: packageJson.version,
    ...(typeof packageJson.name === 'string' && packageJson.name.length > 0 ? { packageName: packageJson.name } : {}),
    keywords: parseKeywords(packageJson.keywords),
    bundled,
    defaultEnabled,
    replaceable: block.replaceable === true,
    stateSchema,
    contributes: parseContributes(block.contributes, stateSchema),
    entry: parseEntry(packageJson, packageDir),
    packageDir,
  };
};

/** Default value for every state key of a manifest. */
export const defaultPluginState = (manifest) => Object.fromEntries(
  Object.entries(manifest.stateSchema).map(([key, field]) => [key, field.default]),
);

/** Whether `value` is allowed for state field `field`. */
export const isValidStateValue = (field, value) => {
  if (!field) return false;
  if (field.type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string' && field.options.some((option) => option.value === value);
};
