import { isAbsolute, normalize } from 'node:path';

import { normalizeNetwork } from './launcher.js';

// A project's sandbox setting (#242 "Settings and storage"). It lives on the
// project entry in host-local settings (runtime-state.json) and is never
// portable: a sandbox claimed on one machine means nothing on another.
const SANDBOX_MODES = ['off', 'nono'];

const MAX_HOSTS = 64;
const MAX_PORTS = 32;
const MAX_FOLDERS = 32;
// A port grant applies to every host and bypasses the proxy (nono-launcher.js).
const REFUSED_PORTS = new Set([80, 443]);

export class ProjectSandboxSettingError extends Error {
  constructor(code = 'INVALID_SANDBOX_SETTING') {
    super('The project sandbox setting is invalid.');
    this.code = code;
  }
}

/** A validated setting, or `ProjectSandboxSettingError`. */
export const normalizeProjectSandboxSetting = (value) => {
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
    throw new ProjectSandboxSettingError();
  }
  if (network.allowLocalPorts.some((port) => REFUSED_PORTS.has(port))) throw new ProjectSandboxSettingError();
  const folders = new Map();
  for (const folder of extraFolders) {
    if (!folder || typeof folder.path !== 'string' || !isAbsolute(folder.path) || /[\0\n\r]/.test(folder.path)
      || !['read', 'readWrite'].includes(folder.access)) {
      throw new ProjectSandboxSettingError();
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

/** The stored setting of a project entry, or null when it has none or it is
 *  unreadable (an unreadable setting is reported by `readProjectSandbox`). */
export const readProjectSandbox = (project) => {
  if (!project || typeof project !== 'object' || project.sandbox === undefined) return { setting: null };
  try {
    return { setting: normalizeProjectSandboxSetting(project.sandbox) };
  } catch {
    return { setting: null, invalid: true };
  }
};
