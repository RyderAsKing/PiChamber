import fs from 'fs';
import path from 'path';

import { resolvePiChamberDataDir, resolvePiChamberDataPath } from '../../server/lib/pichamber-data-dir.js';

const TUNNEL_PROFILES_FILE_NAME = 'tunnel-profiles.json';
const LEGACY_CLOUDFLARE_MANAGED_REMOTE_FILE_NAME = 'cloudflare-managed-remote-tunnels.json';
const TUNNEL_CLI_STATE_FILE_NAME = 'tunnel-cli-state.json';

function getDataDir() {
  return resolvePiChamberDataDir();
}

function getDataPath(...segments) {
  return resolvePiChamberDataPath(segments);
}

function getLogsDir() {
  return path.join(getDataDir(), 'logs');
}

function getSettingsFilePath() {
  return path.join(getDataDir(), 'settings.json');
}

function readDesktopLocalPortFromSettings() {
  try {
    const raw = fs.readFileSync(getSettingsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const value = parsed?.desktopLocalPort;
    if (Number.isFinite(value) && value > 0 && value <= 65535) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

function readDesktopLocalClientTokenFromSettings() {
  try {
    const raw = fs.readFileSync(getSettingsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const value = parsed?.desktopLocalClientToken;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
  } catch {
    return '';
  }
}

function ensureLogsDir() {
  fs.mkdirSync(getLogsDir(), { recursive: true });
}

function getLogFilePath(port) {
  return path.join(getLogsDir(), `pichamber-${port}.log`);
}

function getTunnelProfilesFilePath() {
  return path.join(getDataDir(), TUNNEL_PROFILES_FILE_NAME);
}

function getLegacyCloudflareManagedRemoteFilePath() {
  return path.join(getDataDir(), LEGACY_CLOUDFLARE_MANAGED_REMOTE_FILE_NAME);
}

function getTunnelCliStateFilePath() {
  return path.join(getDataDir(), TUNNEL_CLI_STATE_FILE_NAME);
}

function readTunnelCliState() {
  const filePath = getTunnelCliStateFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function readLastManagedLocalConfigPath() {
  const state = readTunnelCliState();
  if (typeof state.lastManagedLocalConfigPath !== 'string') {
    return '';
  }
  return state.lastManagedLocalConfigPath.trim();
}

function writeLastManagedLocalConfigPath(configPath) {
  if (typeof configPath !== 'string' || configPath.trim().length === 0) {
    return;
  }
  const filePath = getTunnelCliStateFilePath();
  const current = readTunnelCliState();
  const next = {
    ...current,
    lastManagedLocalConfigPath: configPath.trim(),
    updatedAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
}


function getRunDir() {
  const dir = path.join(getDataDir(), 'run');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}


export {
  getDataDir,
  getDataPath,
  readDesktopLocalPortFromSettings,
  readDesktopLocalClientTokenFromSettings,
  ensureLogsDir,
  getLogFilePath,
  getTunnelProfilesFilePath,
  getLegacyCloudflareManagedRemoteFilePath,
  readLastManagedLocalConfigPath,
  writeLastManagedLocalConfigPath,
  getRunDir,
};
