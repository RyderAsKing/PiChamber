import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { writeFileAtomic } from '../fs/atomic-write.js';
import { resolvePiChamberDataDir } from '../pichamber-data-dir.js';
import { withCrossProcessLock } from '../server/cross-process-lock.js';
import { defaultPluginState, isValidStateValue } from './manifest.js';

// `<dataDir>/pi/plugins.json`:
// { version: 1, enabled: { [id]: bool },
//   state: { [id]: { global: {..}, projects: { [dir]: {..} }, sessions: { [sessionId]: {..} } } } }
// `sessions` holds the values a composer switch set for one session; only
// keys a composer toggle names can be set there.
// The server owns this file. The daemon never reads it (it may run in a
// sandbox without access to the data folder); it receives the enabled set and
// state over IPC.

const MAX_DIRECTORY_LENGTH = 4096;
const MAX_SESSION_ID_LENGTH = 256;
/** Per plugin. Past it the least recently set sessions are dropped. */
export const MAX_SESSIONS_PER_PLUGIN = 1000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class PluginStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const unreadable = () => new PluginStoreError('PLUGINS_UNREADABLE', 'The plugin settings file is unreadable.');
const invalidRequest = (message = 'The plugin request is invalid.') => new PluginStoreError('INVALID_PLUGIN_REQUEST', message);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isStoredValue = (value) => typeof value === 'boolean' || typeof value === 'string';

const emptySnapshot = () => ({ version: 1, enabled: {}, state: {} });

/**
 * Normalize a project directory key: absolute, resolved, `~` expanded. Returns
 * null for anything else.
 */
export const normalizePluginDirectory = (value, home = homedir()) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DIRECTORY_LENGTH || trimmed.includes('\0')) return null;
  if (trimmed === '~') return resolve(home);
  if (!isAbsolute(trimmed)) return null;
  return resolve(trimmed);
};

/** A Pi session id as a store key, or null. */
export const normalizePluginSessionId = (value) => (
  typeof value === 'string' && value.length <= MAX_SESSION_ID_LENGTH && SESSION_ID_PATTERN.test(value)
    && !FORBIDDEN_KEYS.has(value) ? value : null
);

/** Keys a composer toggle names: the only ones a session can set. */
const isSessionStateKey = (manifest, key) => (
  manifest.stateSchema[key]?.type === 'boolean'
  && manifest.contributes.composerToggles.some((toggle) => toggle.state === key)
);

const parseValues = (value) => {
  if (!isRecord(value)) throw unreadable();
  const values = {};
  for (const [key, stored] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || !isStoredValue(stored)) throw unreadable();
    values[key] = stored;
  }
  return values;
};

// Shape-level validation only. Unknown plugin ids and keys are kept so a
// plugin that is missing for a while (or a newer build's plugin) keeps its
// settings. Values are checked against the manifest when they are resolved.
const parseSnapshot = (value) => {
  if (!isRecord(value) || value.version !== 1) throw unreadable();
  const enabledInput = value.enabled ?? {};
  const stateInput = value.state ?? {};
  if (!isRecord(enabledInput) || !isRecord(stateInput)) throw unreadable();
  const snapshot = emptySnapshot();
  for (const [id, enabled] of Object.entries(enabledInput)) {
    if (FORBIDDEN_KEYS.has(id) || typeof enabled !== 'boolean') throw unreadable();
    snapshot.enabled[id] = enabled;
  }
  for (const [id, entry] of Object.entries(stateInput)) {
    if (FORBIDDEN_KEYS.has(id) || !isRecord(entry)) throw unreadable();
    const projectsInput = entry.projects ?? {};
    const sessionsInput = entry.sessions ?? {};
    if (!isRecord(projectsInput) || !isRecord(sessionsInput)) throw unreadable();
    const projects = {};
    for (const [directory, values] of Object.entries(projectsInput)) {
      if (FORBIDDEN_KEYS.has(directory)) throw unreadable();
      projects[directory] = parseValues(values);
    }
    const sessions = {};
    for (const [sessionId, values] of Object.entries(sessionsInput)) {
      if (!normalizePluginSessionId(sessionId)) throw unreadable();
      sessions[sessionId] = parseValues(values);
    }
    snapshot.state[id] = { global: parseValues(entry.global ?? {}), projects, sessions };
  }
  return snapshot;
};

/**
 * Resolve one plugin's state for a directory: project value over global
 * value over the manifest default. Values that no longer match the manifest
 * (a removed enum option, a changed type, a key moved to another scope) fall
 * back to the default. A key a composer toggle sets always starts from the
 * default; only a session's own value changes it (`resolveSessionOverrides`).
 */
export const resolvePluginState = (manifest, snapshot, directory) => {
  const resolved = defaultPluginState(manifest);
  const stored = snapshot.state[manifest.id];
  if (!stored) return resolved;
  const project = directory ? stored.projects[directory] : undefined;
  for (const [key, field] of Object.entries(manifest.stateSchema)) {
    if (isSessionStateKey(manifest, key)) continue;
    const source = field.scope === 'project' ? project : stored.global;
    if (source && Object.hasOwn(source, key) && isValidStateValue(field, source[key])) resolved[key] = source[key];
  }
  return resolved;
};

/**
 * One session's own values for a plugin: valid values of keys a composer
 * toggle names. Everything else follows `resolvePluginState`.
 */
export const resolveSessionOverrides = (manifest, snapshot, sessionId) => {
  const stored = snapshot.state[manifest.id]?.sessions?.[sessionId];
  if (!stored) return {};
  const overrides = {};
  for (const [key, value] of Object.entries(stored)) {
    if (isSessionStateKey(manifest, key) && isValidStateValue(manifest.stateSchema[key], value)) overrides[key] = value;
  }
  return overrides;
};

/** Whether the plugin is on: the stored choice, else the manifest default. */
export const isPluginEnabled = (manifest, snapshot) => (
  Object.hasOwn(snapshot.enabled, manifest.id) ? snapshot.enabled[manifest.id] : manifest.defaultEnabled
);

export const createPluginStore = ({ file = join(resolvePiChamberDataDir(), 'pi', 'plugins.json') } = {}) => {
  let writeChain = Promise.resolve();

  /** Missing file is an empty store; a malformed file throws PLUGINS_UNREADABLE. */
  const read = async () => {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptySnapshot();
      throw unreadable();
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw unreadable();
    }
    return parseSnapshot(parsed);
  };

  // Serialized in this process and across processes sharing the data folder.
  // Each mutation re-reads under the lock, so a write never drops another
  // writer's change. A malformed file stops every write instead of being
  // overwritten.
  const mutate = (change) => {
    const operation = writeChain.then(() => withCrossProcessLock(`${file}.lock`, async () => {
      const current = await read();
      change(current);
      await writeFileAtomic(file, `${JSON.stringify(current, null, 2)}\n`);
      return current;
    }));
    writeChain = operation.catch(() => {});
    return operation;
  };

  const setEnabled = (manifest, enabled) => {
    if (typeof enabled !== 'boolean') return Promise.reject(invalidRequest());
    return mutate((current) => {
      current.enabled[manifest.id] = enabled;
    });
  };

  /**
   * Store one state value. The key's scope comes from the manifest; a
   * project-scoped key needs a directory. A key a composer toggle sets has no
   * global or project value: it is set per session only.
   */
  const setState = (manifest, { key, value, directory }) => {
    const field = typeof key === 'string' && Object.hasOwn(manifest.stateSchema, key) ? manifest.stateSchema[key] : null;
    if (!field || !isValidStateValue(field, value) || isSessionStateKey(manifest, key)) return Promise.reject(invalidRequest());
    let projectDirectory = null;
    if (field.scope === 'project') {
      projectDirectory = normalizePluginDirectory(directory);
      if (!projectDirectory) return Promise.reject(invalidRequest('A project value needs a directory.'));
    }
    return mutate((current) => {
      const entry = current.state[manifest.id] ?? { global: {}, projects: {}, sessions: {} };
      current.state[manifest.id] = entry;
      if (projectDirectory) {
        entry.projects[projectDirectory] = { ...(entry.projects[projectDirectory] ?? {}), [key]: value };
      } else {
        entry.global[key] = value;
      }
    });
  };

  /**
   * Store or clear (`value: null`) one session's own value. The session
   * moves to the end, so the oldest are the ones dropped past the cap.
   */
  const setSessionState = (manifest, { sessionId, key, value }) => {
    const id = normalizePluginSessionId(sessionId);
    if (!id || typeof key !== 'string' || !isSessionStateKey(manifest, key)) return Promise.reject(invalidRequest());
    if (value !== null && !isValidStateValue(manifest.stateSchema[key], value)) return Promise.reject(invalidRequest());
    return mutate((current) => {
      const entry = current.state[manifest.id] ?? { global: {}, projects: {}, sessions: {} };
      current.state[manifest.id] = entry;
      const values = { ...(entry.sessions[id] ?? {}) };
      if (value === null) delete values[key];
      else values[key] = value;
      delete entry.sessions[id];
      if (Object.keys(values).length > 0) entry.sessions[id] = values;
      const ids = Object.keys(entry.sessions);
      const over = ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS_PER_PLUGIN));
      for (const dropped of over) delete entry.sessions[dropped];
      if (over.length > 0) {
        console.warn(`[plugins] ${manifest.id}: over ${MAX_SESSIONS_PER_PLUGIN} sessions with their own switches; forgot the ${over.length} least recently set`);
      }
    });
  };

  /**
   * Drop a deleted session's values from every plugin. Resolves whether
   * anything was removed; the file is not written when nothing was.
   */
  const forgetSession = async (sessionId) => {
    const id = normalizePluginSessionId(sessionId);
    if (!id) return false;
    const holds = (snapshot) => Object.values(snapshot.state).some((entry) => Object.hasOwn(entry.sessions ?? {}, id));
    if (!holds(await read())) return false;
    let removed = false;
    await mutate((current) => {
      for (const entry of Object.values(current.state)) {
        if (!Object.hasOwn(entry.sessions ?? {}, id)) continue;
        delete entry.sessions[id];
        removed = true;
      }
    });
    return removed;
  };

  return { file, read, setEnabled, setState, setSessionState, forgetSession };
};
