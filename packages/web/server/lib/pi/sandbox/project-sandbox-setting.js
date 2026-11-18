import { isAbsolute, normalize } from 'node:path';

import { normalizeNetwork, SANDBOX_LIMIT_CODES } from './launcher.js';

// A project's sandbox setting (#242 "Settings and storage"). It lives on the
// project entry in host-local settings (runtime-state.json) and is never
// portable: a sandbox claimed on one machine means nothing on another.
// `default` follows the host's sandbox default (`normalizeSandboxDefaults`);
// a project with no stored setting follows it too.
const SANDBOX_MODES = ['default', 'off', 'nono'];
const DEFAULT_MODES = ['off', 'nono'];

const MAX_HOSTS = 64;
const MAX_PORTS = 32;
const MAX_FOLDERS = 32;
// A port grant applies to every host and bypasses the proxy (nono-launcher.js).
const REFUSED_PORTS = new Set([80, 443]);

export class ProjectSandboxSettingError extends Error {
  /** `reason` names the part that was refused (`HOSTS`, `PORTS`,
   *  `REFUSED_PORT`, `FOLDERS`, or `MODE` for a default update that must
   *  name a mode), so the form can say which to fix. */
  constructor(reason, code = 'INVALID_SANDBOX_SETTING') {
    super('The project sandbox setting is invalid.');
    this.code = code;
    if (reason) this.reason = reason;
  }
}

/** A validated setting, or `ProjectSandboxSettingError`. */
const normalizeProjectSandboxSetting = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SANDBOX_MODES.includes(value.mode)) {
    throw new ProjectSandboxSettingError();
  }
  const allowHosts = value.allowHosts ?? [];
  const allowLocalPorts = value.allowLocalPorts ?? [];
  const extraFolders = value.extraFolders ?? [];
  if (!Array.isArray(allowHosts) || allowHosts.length > MAX_HOSTS
    || !Array.isArray(allowLocalPorts) || allowLocalPorts.length > MAX_PORTS
    || !Array.isArray(extraFolders) || extraFolders.length > MAX_FOLDERS) {
    throw new ProjectSandboxSettingError();
  }
  let network;
  try {
    network = normalizeNetwork({ mode: 'proxy', allowHosts, allowLocalPorts });
  } catch {
    // Find out which list it was, for the reason.
    let hostsValid = true;
    try {
      normalizeNetwork({ mode: 'proxy', allowHosts, allowLocalPorts: [] });
    } catch {
      hostsValid = false;
    }
    throw new ProjectSandboxSettingError(hostsValid ? 'PORTS' : 'HOSTS');
  }
  if (network.allowLocalPorts.some((port) => REFUSED_PORTS.has(port))) throw new ProjectSandboxSettingError('REFUSED_PORT');
  const folders = new Map();
  for (const folder of extraFolders) {
    if (!folder || typeof folder.path !== 'string' || !isAbsolute(folder.path) || /[\0\n\r]/.test(folder.path)
      || !['read', 'readWrite'].includes(folder.access)) {
      throw new ProjectSandboxSettingError('FOLDERS');
    }
    const path = normalize(folder.path).replace(/(.)\/+$/, '$1');
    folders.set(path, { path, access: folder.access });
  }
  return {
    mode: value.mode,
    allowHosts: network.allowHosts,
    allowLocalPorts: network.allowLocalPorts,
    extraFolders: [...folders.values()],
  };
};

const PROJECT_SETTING_FIELDS = ['mode', 'allowHosts', 'allowLocalPorts', 'extraFolders'];

/**
 * The stored setting of `project` with the fields of `patch` (`mode`,
 * `allowHosts`, `allowLocalPorts`, `extraFolders`, or several) laid over
 * it, validated. A field the patch leaves out keeps its stored value, so a
 * device holding an old copy cannot undo what another device just saved. A
 * project with no stored setting starts from the default with empty lists,
 * and one whose stored setting is unreadable from a sandboxed one, which is
 * what it runs as. A patch with none of the fields is refused.
 */
export const mergeProjectSandboxSetting = (project, patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || PROJECT_SETTING_FIELDS.every((field) => patch[field] === undefined)) {
    throw new ProjectSandboxSettingError();
  }
  const { setting, invalid } = readProjectSandbox(project);
  const current = setting ?? { mode: invalid ? 'nono' : 'default' };
  return normalizeProjectSandboxSetting(Object.fromEntries(
    PROJECT_SETTING_FIELDS.map((field) => [field, patch[field] === undefined ? current[field] : patch[field]]),
  ));
};

/**
 * The host's sandbox default: whether projects that follow it are sandboxed,
 * hosts every sandboxed project may reach on top of its own, and the host
 * limits (`SANDBOX_LIMIT_CODES`) the owner accepted. Host-local, like project
 * settings. Validated, or `ProjectSandboxSettingError`.
 */
const normalizeSandboxDefaults = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !DEFAULT_MODES.includes(value.mode)) {
    throw new ProjectSandboxSettingError();
  }
  const allowHosts = value.allowHosts ?? [];
  if (!Array.isArray(allowHosts) || allowHosts.length > MAX_HOSTS) throw new ProjectSandboxSettingError();
  const acceptedLimits = value.acceptedLimits ?? [];
  if (!Array.isArray(acceptedLimits) || acceptedLimits.some((limit) => !SANDBOX_LIMIT_CODES.includes(limit))) {
    throw new ProjectSandboxSettingError();
  }
  let hosts;
  try {
    hosts = normalizeNetwork({ mode: 'proxy', allowHosts, allowLocalPorts: [] }).allowHosts;
  } catch {
    throw new ProjectSandboxSettingError();
  }
  return {
    mode: value.mode,
    allowHosts: hosts,
    acceptedLimits: SANDBOX_LIMIT_CODES.filter((limit) => acceptedLimits.includes(limit)),
  };
};

/**
 * `current` with the fields of `patch` (`mode`, `allowHosts`,
 * `acceptedLimits`, or several) laid over it, validated. A patch with none
 * of them is refused.
 */
export const mergeSandboxDefaults = (current, patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || (patch.mode === undefined && patch.allowHosts === undefined && patch.acceptedLimits === undefined)) {
    throw new ProjectSandboxSettingError();
  }
  return normalizeSandboxDefaults({
    mode: patch.mode === undefined ? current.mode : patch.mode,
    allowHosts: patch.allowHosts === undefined ? [...current.allowHosts] : patch.allowHosts,
    acceptedLimits: patch.acceptedLimits === undefined ? [...current.acceptedLimits] : patch.acceptedLimits,
  });
};

const SANDBOX_DEFAULTS_OFF = Object.freeze({ mode: 'off', allowHosts: Object.freeze([]), acceptedLimits: Object.freeze([]) });

/** The stored host default, or off when there is none. An unreadable one
 *  is `invalid`, so projects that follow it fail closed. */
export const readSandboxDefaults = (settings) => {
  const value = settings && typeof settings === 'object' ? settings.sandboxDefaults : undefined;
  if (value === undefined) return { defaults: SANDBOX_DEFAULTS_OFF };
  try {
    return { defaults: normalizeSandboxDefaults(value) };
  } catch {
    return { defaults: SANDBOX_DEFAULTS_OFF, invalid: true };
  }
};

/** The stored setting of a project entry, or null when it has none or it is
 *  unreadable (an unreadable setting is reported by `readProjectSandbox`). */
export function readProjectSandbox(project) {
  if (!project || typeof project !== 'object' || project.sandbox === undefined) return { setting: null };
  try {
    return { setting: normalizeProjectSandboxSetting(project.sandbox) };
  } catch {
    return { setting: null, invalid: true }
  }
};
