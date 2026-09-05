import { createHash, randomUUID } from 'node:crypto';

const PROFILE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_EXPLICIT_LENGTH = 128;

export const isValidProfileKey = (value) => typeof value === 'string' && PROFILE_KEY_PATTERN.test(value);

const hashSeed = (seed) => createHash('sha256').update(seed).digest('hex').slice(0, 16);

const sanitizePortSegment = (port) => {
  if (port === 0) return 'pauto';
  if (Number.isInteger(port) && port > 0 && port <= 65535) return `p${port}`;
  return '';
};

const resolveRuntime = ({ env = {}, runtime } = {}) => {
  const fromEnv = typeof env.PICHAMBER_RUNTIME === 'string' ? env.PICHAMBER_RUNTIME.trim() : '';
  if (fromEnv === 'desktop' || fromEnv === 'web') return fromEnv;
  if (runtime === 'desktop' || runtime === 'web') return runtime;
  return 'web';
};

const isDesktopDev = ({ env = {} } = {}) => {
  const flag = typeof env.PICHAMBER_ELECTRON_DEV === 'string' ? env.PICHAMBER_ELECTRON_DEV.trim().toLowerCase() : '';
  return flag === '1' || flag === 'true';
};

const isWebDev = ({ env = {} } = {}) => {
  const kind = typeof env.PICHAMBER_SERVER_PROFILE_KIND === 'string' ? env.PICHAMBER_SERVER_PROFILE_KIND.trim().toLowerCase() : '';
  if (kind === 'dev') return true;
  const legacy = typeof env.PICHAMBER_DEV_SERVER === 'string' ? env.PICHAMBER_DEV_SERVER.trim().toLowerCase() : '';
  return legacy === '1' || legacy === 'true';
};

/**
 * Resolve the stable daemon profile for one PiChamber server.
 *
 * The profile key is stable across restarts of the same logical server and
 * distinct across development, installed, desktop, and port-separated web
 * servers. The server instance id is unique per launch and is used to prove
 * which server currently owns a profile daemon.
 */
export const resolveServerProfile = ({
  env = process.env,
  port,
  runtime,
  version,
  serverInstanceId,
} = {}) => {
  const safeEnv = env && typeof env === 'object' ? env : {};
  const explicit = typeof safeEnv.PICHAMBER_SERVER_PROFILE === 'string'
    ? safeEnv.PICHAMBER_SERVER_PROFILE.trim()
    : '';
  const effectiveRuntime = resolveRuntime({ env: safeEnv, runtime });
  const development = effectiveRuntime === 'desktop'
    ? isDesktopDev({ env: safeEnv })
    : isWebDev({ env: safeEnv });
  const instanceId = typeof serverInstanceId === 'string' && serverInstanceId.length > 0
    ? serverInstanceId
    : randomUUID();
  const buildId = typeof version === 'string' && version.trim().length > 0 ? version.trim() : 'unknown';

  if (explicit.length > 0) {
    if (explicit.length > MAX_EXPLICIT_LENGTH) {
      throw new Error('PICHAMBER_SERVER_PROFILE is too long.');
    }
    return {
      profileKey: `custom-${hashSeed(`explicit:${explicit}`)}`,
      profileLabel: explicit.slice(0, MAX_EXPLICIT_LENGTH),
      serverInstanceId: instanceId,
      runtime: effectiveRuntime,
      source: 'custom',
      development,
      port: Number.isInteger(port) ? port : null,
      buildId,
    };
  }

  if (effectiveRuntime === 'desktop') {
    const dev = development;
    return {
      profileKey: dev ? 'desktop-dev' : 'desktop',
      profileLabel: dev ? 'desktop development' : 'desktop',
      serverInstanceId: instanceId,
      runtime: 'desktop',
      source: dev ? 'desktop-dev' : 'desktop-installed',
      development: dev,
      port: Number.isInteger(port) ? port : null,
      buildId,
    };
  }

  const dev = development;
  const portSegment = sanitizePortSegment(port);
  const base = dev ? 'web-dev' : 'web';
  const profileKey = portSegment ? `${base}-${portSegment}` : base;
  const numericPort = Number.isInteger(port) ? port : null;
  return {
    profileKey,
    profileLabel: numericPort === null
      ? `${dev ? 'web development' : 'web'} server`
      : `${dev ? 'web development' : 'web'} server on port ${numericPort}`,
    serverInstanceId: instanceId,
    runtime: 'web',
    source: dev ? 'web-dev' : 'web-installed',
    development: dev,
    port: numericPort,
    buildId,
  };
};
