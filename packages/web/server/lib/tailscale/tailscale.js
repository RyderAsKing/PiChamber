/**
 * Tailscale remote-access helpers (pure, dependency-free).
 *
 * `tailscale serve --bg --https=<port> http://127.0.0.1:<localPort>` publishes
 * a local port at `https://<machine>.<tailnet>.ts.net[:port]` reachable only
 * by devices in the user's tailnet. `tailscale funnel` is identical but
 * reachable from the public internet. Funnel only allows HTTPS ports 443,
 * 8443 and 10000.
 *
 * This module owns parsing, validation, conflict detection and the security
 * gate. Process spawning, persistence and lifecycle live in `service.js` so
 * they can be tested with an injected fake runner. Keep this file free of
 * Node builtins beyond `path`/`os` string handling so it stays unit-testable.
 */

const TAILSCALE_MODES = ['private', 'public'];
const TAILSCALE_HTTPS_PORTS = [443, 8443, 10000];
export const TAILSCALE_DEFAULT_MODE = 'private';
export const TAILSCALE_DEFAULT_HTTPS_PORT = 443;

// Bounded waits: serve/funnel may block on approval, status probes must not.
export const TAILSCALE_STATUS_TIMEOUT_MS = 10_000;
export const TAILSCALE_APPLY_TIMEOUT_MS = 30_000;
export const TAILSCALE_REMOVE_TIMEOUT_MS = 15_000;
export const TAILSCALE_PROBE_TIMEOUT_MS = 5_000;
export const TAILSCALE_APPROVAL_WAIT_MS = 5 * 60 * 1000;

const TAILSCALE_STATES = [
  'off',
  'unavailable',
  'blocked',
  'starting',
  'needs-approval',
  'active',
  'conflict',
  'error',
];

const TAILSCALE_ERROR_CODES = [
  'auth_required',
  'not_installed',
  'not_running',
  'not_logged_in',
  'permission_denied',
  'needs_approval',
  'conflict',
  'apply_failed',
  'remove_failed',
  'status_query_failed',
  'probe_failed',
  'invalid_config',
  'timeout',
  'unknown',
];

const DEFAULT_TAILSCALE_CONFIG = Object.freeze({
  enabled: false,
  mode: TAILSCALE_DEFAULT_MODE,
  httpsPort: TAILSCALE_DEFAULT_HTTPS_PORT,
});

export const validateTailscaleConfig = (input) => {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Config must be an object'] };
  }
  if (Object.hasOwn(input, 'enabled') && typeof input.enabled !== 'boolean') {
    errors.push('enabled must be a boolean');
  }
  if (Object.hasOwn(input, 'mode') && !TAILSCALE_MODES.includes(input.mode)) {
    errors.push(`mode must be one of: ${TAILSCALE_MODES.join(', ')}`);
  }
  if (
    Object.hasOwn(input, 'httpsPort')
    && !(Number.isInteger(input.httpsPort) && TAILSCALE_HTTPS_PORTS.includes(input.httpsPort))
  ) {
    errors.push(`httpsPort must be one of: ${TAILSCALE_HTTPS_PORTS.join(', ')}`);
  }
  return errors.length === 0 ? { ok: true, errors } : { ok: false, errors };
};

export const normalizeTailscaleConfig = (input) => ({
  enabled: typeof input?.enabled === 'boolean' ? input.enabled : DEFAULT_TAILSCALE_CONFIG.enabled,
  mode: TAILSCALE_MODES.includes(input?.mode) ? input.mode : DEFAULT_TAILSCALE_CONFIG.mode,
  httpsPort:
    Number.isInteger(input?.httpsPort) && TAILSCALE_HTTPS_PORTS.includes(input.httpsPort)
      ? input.httpsPort
      : DEFAULT_TAILSCALE_CONFIG.httpsPort,
});

/**
 * Security gate (core-enforced, not just UI): Tailscale proxies to loopback,
 * which bypasses the "refuse a network-exposed bind without a UI password"
 * rule. Enabling Tailscale therefore requires UI auth (a UI password).
 * `private` mode honors the same `PICHAMBER_ALLOW_UNAUTHENTICATED_LAN`
 * escape hatch as a LAN bind; `public` mode has no escape hatch.
 */
export const checkTailscaleAuthGate = ({ enabled, mode, uiPasswordConfigured, unsafeUnauthenticatedLanAllowed }) => {
  if (enabled !== true) return { allowed: true };
  if (uiPasswordConfigured === true) return { allowed: true };
  if (mode === 'private' && unsafeUnauthenticatedLanAllowed === true) return { allowed: true };
  return {
    allowed: false,
    code: 'auth_required',
    message:
      mode === 'public'
        ? 'Tailscale public (Funnel) access requires a UI password. Set --ui-password or PICHAMBER_UI_PASSWORD.'
        : 'Tailscale private access requires a UI password. Set --ui-password or PICHAMBER_UI_PASSWORD, '
          + 'or set PICHAMBER_ALLOW_UNAUTHENTICATED_LAN=true to accept the risk.',
  };
};

export const tailscaleCommandForPlatform = (platform) =>
  platform === 'win32' ? 'tailscale.exe' : 'tailscale';

/**
 * Resolve the executable: PATH first, then the
 * platform install location. Returns `{ command, extraPaths }` where
 * `extraPaths` is the macOS/Windows well-known location to probe when the
 * PATH lookup misses. Uses argument arrays (no shell) at the call site.
 */
export const resolveTailscaleExecutable = ({ platform = process.platform, env = process.env, existsSync = null } = {}) => {
  const command = tailscaleCommandForPlatform(platform);
  if (platform === 'darwin') {
    const macOsBundle = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    if (typeof existsSync === 'function') {
      try {
        if (existsSync(macOsBundle)) return { command: macOsBundle, source: 'bundle' };
      } catch {
        // Fall through to PATH lookup.
      }
    }
    return { command, source: 'path', fallback: macOsBundle };
  }
  if (platform === 'win32') {
    const programFiles = env?.ProgramFiles || env?.PROGRAMFILES || 'C:\\Program Files';
    const installed = `${programFiles}\\Tailscale\\tailscale.exe`;
    if (typeof existsSync === 'function') {
      try {
        if (existsSync(installed)) return { command: installed, source: 'installed' };
      } catch {
        // Fall through to PATH lookup.
      }
    }
    return { command, source: 'path', fallback: installed };
  }
  return { command, source: 'path' };
};

export const buildTailscaleServeArgs = ({ mode, httpsPort, localPort }) => {
  const subcommand = mode === 'public' ? 'funnel' : 'serve';
  return [subcommand, '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`];
};

export const buildTailscaleRemoveArgs = ({ mode, httpsPort }) => {
  const subcommand = mode === 'public' ? 'funnel' : 'serve';
  return [subcommand, `--https=${httpsPort}`, 'off'];
};

export const buildTailscaleUrl = ({ magicDnsName, httpsPort }) => {
  if (!magicDnsName) return null;
  const portSuffix = httpsPort === 443 ? '' : `:${httpsPort}`;
  return `https://${magicDnsName}${portSuffix}`;
};

/**
 * `tailscale status --json` → `{ loggedIn, magicDnsName }`. Self.DNSName has a
 * trailing dot; `BackendState: "Running"` means the daemon is up. A missing or
 * empty Self means logged out. Never throws: malformed JSON reports logged out
 * with a null name so callers surface `not_logged_in` instead of crashing.
 */
export const parseTailscaleStatus = (rawJson) => {
  let parsed = null;
  try {
    parsed = JSON.parse(String(rawJson ?? ''));
  } catch {
    return { running: false, loggedIn: false, magicDnsName: null, httpsCertsAvailable: null };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { running: false, loggedIn: false, magicDnsName: null, httpsCertsAvailable: null };
  }
  const running = parsed.BackendState === 'Running';
  const self = parsed.Self && typeof parsed.Self === 'object' ? parsed.Self : null;
  const rawDns = typeof self?.DNSName === 'string' ? self.DNSName.trim().replace(/\.$/, '') : '';
  const magicDnsName = rawDns ? rawDns : null;
  const loggedIn = Boolean(self) && magicDnsName !== null;
  // `CertDomains` (when present) lists the DNS names with provisioned HTTPS
  // certs; absent on older clients → unknown (null), never assumed false.
  const certDomains = Array.isArray(parsed.CertDomains) ? parsed.CertDomains : null;
  const httpsCertsAvailable = certDomains === null
    ? null
    : Boolean(magicDnsName && certDomains.some((entry) => typeof entry === 'string' && entry.replace(/\.$/, '') === magicDnsName));
  return { running, loggedIn, magicDnsName, httpsCertsAvailable };
};

/**
 * `tailscale serve status --json` shape (verified against real output):
 * `{ TCP: { "443": {"HTTPS": true}}, Web: { "<host>:<port>": { Handlers: {...}, AllowFunnel: {...}}}, AllowFunnel: {...} }`.
 * Returns the entry fronting `httpsPort`, or null when unmapped.
 */
export const findServeMappingForPort = (serveStatus, httpsPort) => {
  if (!serveStatus || typeof serveStatus !== 'object') return null;
  const web = serveStatus.Web && typeof serveStatus.Web === 'object' ? serveStatus.Web : {};
  const wanted = Number(httpsPort);
  for (const [key, entry] of Object.entries(web)) {
    if (typeof key !== 'string') continue;
    // Keys are `<host>:<port>` (or bare `<port>`); compare the port segment
    // exactly so port 443 never matches e.g. 8443 via a suffix check.
    const portSegment = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
    if (portSegment === String(wanted)) {
      return { key, entry };
    }
  }
  return null;
};

const collectServeTargets = (entry) => {
  const targets = [];
  const handlers = entry && typeof entry === 'object' ? entry.Handlers : null;
  if (handlers && typeof handlers === 'object') {
    for (const handler of Object.values(handlers)) {
      if (typeof handler === 'string') {
        targets.push(handler);
      } else if (handler && typeof handler === 'object') {
        for (const value of Object.values(handler)) {
          if (typeof value === 'string') targets.push(value);
        }
      }
    }
  }
  return targets;
};

/**
 * Conflict rule: never replace a mapping fronting
 * something else. A mapping is OURS only when every handler target points at
 * our own `http://127.0.0.1:<boundPort>` (trailing slashes ignored).
 */
export const classifyServeMapping = ({ mapping, httpsPort, boundPort }) => {
  if (!mapping) return { kind: 'absent' };
  const expected = `http://127.0.0.1:${boundPort}`;
  const normalize = (value) => String(value ?? '').trim().replace(/\/+$/, '');
  const targets = collectServeTargets(mapping.entry);
  if (targets.length === 0) return { kind: 'foreign', targets };
  const ours = targets.every((target) => normalize(target) === expected);
  if (ours) return { kind: 'ours', targets };
  return { kind: 'foreign', targets };
};

export const conflictMessageForPort = (httpsPort) => {
  const alternatives = TAILSCALE_HTTPS_PORTS.filter((port) => port !== httpsPort);
  return `Port ${httpsPort} already serves another destination in Tailscale. `
    + 'PiChamber will not overwrite a mapping it did not create. '
    + `Choose another HTTPS port (${alternatives.join(' or ')}).`;
};

/**
 * Approval flow: when HTTPS certs or Funnel are not enabled for the tailnet,
 * serve/funnel prints `https://login.tailscale.com/f/serve?node=...` (or
 * `/f/funnel?...`) and blocks. Extract the first approval URL from streamed
 * output so the service can surface `needs-approval` while it keeps waiting.
 */
export const extractApprovalUrl = (output) => {
  if (typeof output !== 'string' || !output) return null;
  const match = output.match(/https:\/\/login\.tailscale\.com\/[^\s"'<>]*/);
  return match ? match[0].replace(/[.,;:!?)\]]+$/, '') : null;
};

const PERMISSION_PATTERNS = [
  /access\s*denied/i,
  /permission\s*denied/i,
  /serve config denied/i,
  /operator/i,
  /must be root/i,
  /operation not permitted/i,
];

/**
 * Linux non-root without operator rights fails with an access/permission
 * style error. Detect it and surface `permission_denied` with the
 * `sudo tailscale set --operator=$USER` fix hint. Matches against the
 * combined stdout+stderr; never logs the raw text (it can contain node names).
 */
export const isPermissionDeniedOutput = (output) =>
  typeof output === 'string' && PERMISSION_PATTERNS.some((pattern) => pattern.test(output));

const permissionDeniedHint = () =>
  'Tailscale denied the serve configuration (missing operator rights). Run: sudo tailscale set --operator=$USER';

export const classifyApplyFailure = (output) => {
  if (isPermissionDeniedOutput(output)) {
    return { code: 'permission_denied', message: permissionDeniedHint() };
  }
  if (extractApprovalUrl(output)) {
    return { code: 'needs_approval', message: 'Tailscale is waiting for tailnet approval.' };
  }
  if (/not logged in|logged out|needs login/i.test(output ?? '')) {
    return { code: 'not_logged_in', message: 'Tailscale is not logged in. Run: tailscale up' };
  }
  return null;
};
