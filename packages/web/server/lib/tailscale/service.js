/**
 * Tailscale remote-access lifecycle owner.
 *
 * Applies `tailscale serve` (private, tailnet-only) or `tailscale funnel`
 * (public) mappings to `http://127.0.0.1:<boundPort>` while PiChamber runs,
 * and removes them on graceful shutdown. Applying/removing failures log a
 * warning and never block startup or shutdown (bounded timeouts).
 *
 * Crash safety: the mapping PiChamber created is recorded in
 * `tailscale-mapping.json` in the PiChamber data dir. On the next start a
 * stale record is removed/repointed. A mapping PiChamber did not create is
 * NEVER removed or overwritten: `tailscale serve status --json` is inspected
 * first, and a foreign mapping on the target port reports `conflict`.
 *
 * All process execution goes through the injected `runner` (argument arrays,
 * no shell, bounded timeouts) so unit tests can inject a fake. The default
 * runner spawns the resolved executable directly with `windowsHide: true`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  TAILSCALE_APPLY_TIMEOUT_MS,
  TAILSCALE_APPROVAL_WAIT_MS,
  TAILSCALE_DEFAULT_HTTPS_PORT,
  TAILSCALE_DEFAULT_MODE,
  TAILSCALE_PROBE_TIMEOUT_MS,
  TAILSCALE_REMOVE_TIMEOUT_MS,
  TAILSCALE_STATUS_TIMEOUT_MS,
  buildTailscaleRemoveArgs,
  buildTailscaleServeArgs,
  buildTailscaleUrl,
  checkTailscaleAuthGate,
  classifyApplyFailure,
  classifyServeMapping,
  conflictMessageForPort,
  extractApprovalUrl,
  findServeMappingForPort,
  normalizeTailscaleConfig,
  parseTailscaleStatus,
  resolveTailscaleExecutable,
  validateTailscaleConfig,
} from './tailscale.js';

const TAILSCALE_CONFIG_FILE = 'tailscale-config.json';
const TAILSCALE_MAPPING_FILE = 'tailscale-mapping.json';

// Funnel public DNS can take minutes on first use: keep re-probing with
// backoff while `starting`, up to this budget, without blocking anything else.
const PROBE_RETRY_BUDGET_MS = 10 * 60 * 1000;
const PROBE_RETRY_DELAYS_MS = [5_000, 10_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000];

// Config/retry HTTP responses wait for reconcile only up to this grace, then
// return the current (possibly transitional) status while reconcile
// continues in the background. The apply can block for minutes waiting for
// tailnet approval, and callers (CLI `pair --tailscale`, the UI hook) poll
// `GET /status` until a terminal state.
const CONFIG_RESPONSE_GRACE_MS = 3_000;
// Shutdown runs its status query and removal under tighter bounds than
// reconcile: together they must finish inside Electron's quit timeout
// (`QUIT_SERVER_STOP_TIMEOUT_MS`, 8s, packages/electron/quit-server-stop.mjs),
// or the app exits mid-removal and orphans the mapping. A timeout keeps the
// record, so the next start's cleanup retries.
const SHUTDOWN_STATUS_TIMEOUT_MS = 3_000;
const SHUTDOWN_REMOVE_TIMEOUT_MS = 4_000;

/**
 * Default command runner. Never rejects: spawn errors and timeouts are
 * reported in the result so the service can classify them. `onOutput` gets
 * each stdout/stderr chunk for approval-URL extraction while waiting.
 */
export const createDefaultTailscaleRunner = ({ spawnFn = spawn, platform = process.platform } = {}) => {
  const runTailscale = (args, { timeoutMs, onOutput, signal } = {}) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      aborted = true;
      try {
        child.kill('SIGKILL');
      } catch {
      }
      finish({ ok: false, code: null, stdout, stderr, spawnError: 'aborted', timedOut: false, aborted: true });
    };
    let child;
    try {
      child = spawnFn(args[0], args.slice(1), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, code: null, stdout: '', stderr: '', spawnError: error?.message || String(error), timedOut: false });
      return;
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
        }
        finish({ ok: false, code: null, stdout, stderr, spawnError: null, timedOut: true });
      }, timeoutMs)
      : null;
    if (timer?.unref) timer.unref();
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      try {
        onOutput?.(text);
      } catch {
      }
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      try {
        onOutput?.(text);
      } catch {
      }
    });
    child.on('error', (error) => {
      finish({ ok: false, code: null, stdout, stderr, spawnError: error?.message || String(error), timedOut: false });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, code, stdout, stderr, spawnError: null, timedOut });
    });
  });
  return { runTailscale, platform };
};

const readJsonFile = async (fsPromises, filePath) => {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const writeJsonFileAtomic = async (fsPromises, filePath, value) => {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(tmpPath, serialized, 'utf8');
  await fsPromises.rename(tmpPath, filePath);
};

export const createTailscaleService = ({
  dataDir,
  getPort = () => null,
  isUiAuthEnabled = () => false,
  isUnsafeUnauthenticatedLanAllowed = () => false,
  runner = null,
  fetchImpl = globalThis.fetch,
  fsPromises = fs.promises,
  existsSync = fs.existsSync,
  // Stable server identity (hash of the public relay signing key — not a
  // secret). Injected so the probe compares against the same id `/health`,
  // `/api/version`, and relay pairing candidates report. A null/throwing id
  // fails the probe (the URL stays `starting`, never `active`).
  getServerId = async () => null,
  platform = process.platform,
  env = process.env,
  logWarn = (message) => console.warn(message),
  configResponseGraceMs = CONFIG_RESPONSE_GRACE_MS,
} = {}) => {
  const effectiveRunner = runner || createDefaultTailscaleRunner({ platform });
  const executable = resolveTailscaleExecutable({ platform, env, existsSync });
  const configPath = path.join(dataDir, TAILSCALE_CONFIG_FILE);
  const mappingPath = path.join(dataDir, TAILSCALE_MAPPING_FILE);

  let config = { enabled: false, mode: TAILSCALE_DEFAULT_MODE, httpsPort: TAILSCALE_DEFAULT_HTTPS_PORT };
  let status = {
    installed: false,
    running: false,
    loggedIn: false,
    magicDnsName: null,
    httpsCertsAvailable: null,
    state: 'off',
    url: null,
    approvalUrl: null,
    errorCode: null,
    errorMessage: null,
  };
  let generation = 0;
  let probeTimer = null;
  // Serializes reconciles: each reconcile starts only after the previous
  // one settles, so a superseded Off can never remove a mapping after the
  // newer Private reconcile verified it. The tail swallows rejection so one
  // failure never wedges the chain; the returned promise still rejects
  // for the caller (`reconcileWithGrace` logs it).
  let reconcileTail = Promise.resolve();
  // Abort for the in-flight apply (F6): a generation bump aborts it so a
  // stale apply cannot create a mapping nobody owns.
  let applyAbort = null;
  // Whether our mapping record is on disk (F13): a starting/needs-approval
  // mapping that is already written is quit-risky, like an active one.
  let mappingRecordPresent = false;

  // Every generation bump cancels the in-flight apply first.
  const bumpGeneration = () => {
    generation += 1;
    try {
      applyAbort?.abort();
    } catch {
    }
    applyAbort = null;
  };

  const clearProbeTimer = () => {
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  };

  const setRuntime = (patch) => {
    status = { ...status, ...patch };
  };

  /**
   * Records host prerequisites from `tailscale status --json` (queried via
   * `queryStatus`). Shared by the enabled/disabled/blocked reconcile paths
   * so all of them report installed/running/loggedIn accurately. Never sets
   * a state or error code: callers own those.
   */
  const applyHostInfo = (hostInfo) => {
    if (!hostInfo || hostInfo.installed !== true) {
      setRuntime({ installed: false, running: false, loggedIn: false, magicDnsName: null, httpsCertsAvailable: null });
      return;
    }
    setRuntime({
      installed: true,
      running: hostInfo.running === true,
      loggedIn: hostInfo.loggedIn === true,
      magicDnsName: hostInfo.magicDnsName ?? null,
      httpsCertsAvailable: hostInfo.httpsCertsAvailable ?? null,
    });
  };

  const loadConfig = async () => {
    const raw = await readJsonFile(fsPromises, configPath);
    config = normalizeTailscaleConfig(raw);
    try {
      mappingRecordPresent = (await readMappingRecord()) !== null;
    } catch {
      mappingRecordPresent = false;
    }
    return config;
  };

  const persistConfig = async (next) => {
    config = next;
    await writeJsonFileAtomic(fsPromises, configPath, next);
  };

  const readMappingRecord = async () => {
    const raw = await readJsonFile(fsPromises, mappingPath);
    if (!raw || typeof raw !== 'object') return null;
    if (!Number.isInteger(raw.httpsPort) || typeof raw.mode !== 'string' || !Number.isInteger(raw.localPort)) {
      return null;
    }
    return { httpsPort: raw.httpsPort, mode: raw.mode, localPort: raw.localPort };
  };

  const writeMappingRecord = async (record) => {
    await writeJsonFileAtomic(fsPromises, mappingPath, record);
    mappingRecordPresent = true;
  };

  const clearMappingRecord = async () => {
    try {
      await fsPromises.unlink(mappingPath);
    } catch {
    }
    mappingRecordPresent = false;
  };

  // The resolved install location when it exists, otherwise the PATH
  // command (spawn reports ENOENT, which we classify as not-installed).
  const withExecutable = (args) => [executable.command, ...args];

  const queryStatus = async () => {
    const result = await effectiveRunner.runTailscale(
      withExecutable(['status', '--json']),
      { timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS },
    );
    if (result.spawnError && /ENOENT/i.test(result.spawnError)) {
      return { installed: false };
    }
    if (!result.ok) {
      // `status` exits non-zero when logged out on some builds, but still
      // prints JSON — parse whatever it emitted before giving up.
      const parsed = parseTailscaleStatus(result.stdout);
      if (parsed.loggedIn || parsed.magicDnsName) return { installed: true, ...parsed };
      return { installed: true, running: false, loggedIn: false, magicDnsName: null, httpsCertsAvailable: null };
    }
    return { installed: true, ...parseTailscaleStatus(result.stdout) };
  };

  const queryServeMapping = async (mode, timeoutMs = TAILSCALE_STATUS_TIMEOUT_MS) => {
    // Funnel mappings are listed by `tailscale funnel status`; serve mappings
    // by `tailscale serve status`. A query failure is UNKNOWN (ok: false),
    // never "absent": callers must refuse to apply/remove/clear without
    // positive ownership instead of overwriting a foreign mapping.
    const subcommand = mode === 'public' ? 'funnel' : 'serve';
    const result = await effectiveRunner.runTailscale(
      withExecutable([subcommand, 'status', '--json']),
      { timeoutMs },
    );
    if (!result.ok || result.spawnError) return { ok: false, status: null };
    try {
      return { ok: true, status: JSON.parse(result.stdout) };
    } catch {
      return { ok: false, status: null };
    }
  };

  const STATUS_QUERY_FAILED_MESSAGE =
    'Could not read the current Tailscale serve status, so nothing was changed. Try again.';

  // Message for a verified own mapping whose `off` removal failed: the
  // mapping may still be live, so never suggest `tailscale serve reset`
  // (that would wipe mappings PiChamber does not own).
  const removeFailedMessageFor = (record) => {
    const surface = record.mode === 'public' ? 'Funnel' : 'serve';
    return `Could not remove PiChamber's Tailscale ${surface} mapping on HTTPS port ${record.httpsPort}, so it may still be reachable. Try again.`;
  };

  // Maps a `removeVerifiedOwnMapping` result to the status error to report,
  // or null when the stale mapping is verifiably gone (or there was none).
  const removalFailure = (removal, record) => {
    if (!removal) return null;
    if (!removal.verified) return { errorCode: 'status_query_failed', errorMessage: STATUS_QUERY_FAILED_MESSAGE };
    if (removal.removed === false) return { errorCode: 'remove_failed', errorMessage: removeFailedMessageFor(record) };
    return null;
  };

  /**
   * Verified own-mapping removal shared by the disabled/blocked/stale paths:
   * classify the live mapping against our record and remove ONLY when it is
   * ours, then clear the record. On a query failure nothing is removed and
   * the record is kept so a later reconcile can retry with verification. A
   * failed removal (`removed: false`) also keeps the record — the mapping
   * may still be live — so callers must report `remove_failed` instead of
   * success. Absent/foreign mappings clear the record as before.
   */
  const removeVerifiedOwnMapping = async (record, myGeneration) => {
    const queried = await queryServeMapping(record.mode);
    if (myGeneration !== generation) {
      // Superseded while the serve-status query was in flight: the newer
      // generation may have just verified this same mapping as its own.
      // Remove and clear nothing; the caller returns on its own
      // generation check before interpreting this result.
      return { verified: false, superseded: true };
    }
    if (!queried.ok) return { verified: false };
    const mapping = queried.status ? findServeMappingForPort(queried.status, record.httpsPort) : null;
    const classification = classifyServeMapping({ mapping, httpsPort: record.httpsPort, boundPort: record.localPort });
    if (classification.kind === 'ours') {
      const { removed } = await removeMapping({ mode: record.mode, httpsPort: record.httpsPort });
      if (!removed) {
        return { verified: true, removed: false, classification };
      }
    }
    await clearMappingRecord();
    return { verified: true, removed: true, classification };
  };

  /**
   * Stale-apply cleanup (F6): an apply that resolved after its generation
   * was superseded may still have created a mapping. Remove it when it
   * verifiably points at the stale local port — unless the current record
   * already claims the same mapping for the live generation (pure retry),
   * in which case the new generation owns it.
   */
  const cleanupStaleApply = async ({ mode, httpsPort, localPort }) => {
    try {
      const current = await readMappingRecord();
      if (current && current.httpsPort === httpsPort && current.mode === mode && current.localPort === localPort) {
        return;
      }
      const queried = await queryServeMapping(mode);
      if (!queried.ok) {
        logWarn(`[tailscale] Stale apply for ${mode} port ${httpsPort} could not be verified; leaving it for the next reconcile.`);
        return;
      }
      const mapping = queried.status ? findServeMappingForPort(queried.status, httpsPort) : null;
      const classification = classifyServeMapping({ mapping, httpsPort, boundPort: localPort });
      if (classification.kind === 'ours') {
        await removeMapping({ mode, httpsPort });
      }
    } catch (error) {
      logWarn(`[tailscale] Stale apply cleanup failed: ${error?.message || error}`);
    }
  };

  const removeMapping = async ({ mode, httpsPort, timeoutMs = TAILSCALE_REMOVE_TIMEOUT_MS }) => {
    const result = await effectiveRunner.runTailscale(
      withExecutable(buildTailscaleRemoveArgs({ mode, httpsPort })),
      { timeoutMs },
    );
    if (!result.ok && !result.spawnError) {
      // Removing a port with no mapping exits non-zero ("no handler"); that
      // is the desired end state, not a failure.
      if (/handler does not exist|no .* handler|not configured|no such/i.test(`${result.stdout}\n${result.stderr}`)) {
        return { removed: true };
      }
      logWarn(`[tailscale] Failed to remove ${mode} mapping on https port ${httpsPort} (exit ${result.code}).`);
      return { removed: false, output: `${result.stdout}\n${result.stderr}` };
    }
    if (!result.ok) {
      logWarn(`[tailscale] Failed to remove ${mode} mapping on https port ${httpsPort}: ${result.spawnError || 'spawn failed'}.`);
      return { removed: false, output: result.spawnError || '' };
    }
    return { removed: true };
  };

  const probeUrl = async (url) => {
    // A null/throwing identity fails the probe: the URL stays `starting`
    // and is never advertised as `active`.
    let expectedServerId = null;
    try {
      expectedServerId = await getServerId();
    } catch {
      return false;
    }
    if (typeof expectedServerId !== 'string' || !expectedServerId) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TAILSCALE_PROBE_TIMEOUT_MS);
      if (timer?.unref) timer.unref();
      // Credential-free by construction: no Authorization header, no cookie.
      // Only advertised once the body proves THIS server answered.
      const response = await fetchImpl(`${url.replace(/\/+$/, '')}/health`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response || !response.ok) return false;
      const body = await response.json().catch(() => null);
      const reported = body && typeof body === 'object' ? body.serverId : null;
      return typeof reported === 'string' && reported.length > 0 && reported === expectedServerId;
    } catch {
      return false;
    }
  };

  const scheduleProbeRetries = (myGeneration, url, delays, elapsed = 0) => {
    clearProbeTimer();
    if (myGeneration !== generation) return;
    if (elapsed >= PROBE_RETRY_BUDGET_MS || delays.length === 0) {
      if (myGeneration === generation && status.state === 'starting') {
        setRuntime({ state: 'error', errorCode: 'probe_failed', errorMessage: 'The Tailscale URL never answered as this server.' });
      }
      return;
    }
    const [delay, ...rest] = delays;
    probeTimer = setTimeout(async () => {
      probeTimer = null;
      if (myGeneration !== generation) return;
      const ok = await probeUrl(url);
      if (myGeneration !== generation) return;
      if (ok) {
        setRuntime({ state: 'active', url, approvalUrl: null, errorCode: null, errorMessage: null });
        return;
      }
      scheduleProbeRetries(myGeneration, url, rest, elapsed + delay);
    }, delay);
    if (probeTimer?.unref) probeTimer.unref();
  };

  const applyMapping = async (myGeneration, { mode, httpsPort, localPort }) => {
    let approvalUrl = null;
    if (myGeneration !== generation) {
      // Superseded before the apply even started: never assign the shared
      // abort handle (it belongs to the live generation), just sweep a
      // possibly orphaned mapping for these params.
      await cleanupStaleApply({ mode, httpsPort, localPort });
      return { applied: false, stale: true };
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    applyAbort = controller;
    const result = await effectiveRunner.runTailscale(
      withExecutable(buildTailscaleServeArgs({ mode, httpsPort, localPort })),
      {
        timeoutMs: TAILSCALE_APPROVAL_WAIT_MS,
        ...(controller ? { signal: controller.signal } : {}),
        onOutput: (chunk) => {
          if (approvalUrl || myGeneration !== generation) return;
          const found = extractApprovalUrl(chunk);
          if (found) {
            approvalUrl = found;
            if (status.state === 'starting') {
              setRuntime({ state: 'needs-approval', approvalUrl, errorCode: 'needs_approval', errorMessage: 'Tailscale needs tailnet approval before the mapping goes live.' });
            }
          }
        },
      },
    );
    if (applyAbort === controller) applyAbort = null;
    if (myGeneration !== generation) {
      // Superseded while applying: a mapping may still have been created, so
      // verify and remove it rather than orphaning it.
      await cleanupStaleApply({ mode, httpsPort, localPort });
      return { applied: false, stale: true };
    }
    if (result.timedOut) {
      if (approvalUrl) {
        setRuntime({ state: 'needs-approval', approvalUrl, errorCode: 'needs_approval', errorMessage: 'Tailscale is still waiting for tailnet approval. Approve, then retry.' });
        return { applied: false, approvalUrl };
      }
      setRuntime({ state: 'error', errorCode: 'timeout', errorMessage: 'Applying the Tailscale mapping timed out.' });
      return { applied: false };
    }
    if (result.spawnError) {
      if (/ENOENT/i.test(result.spawnError)) {
        setRuntime({ installed: false, state: 'unavailable', errorCode: 'not_installed', errorMessage: 'The tailscale executable was not found. Install Tailscale to use remote access.' });
        return { applied: false };
      }
      setRuntime({ state: 'error', errorCode: 'apply_failed', errorMessage: 'Failed to start the Tailscale process.' });
      return { applied: false };
    }
    if (!result.ok) {
      const output = `${result.stdout}\n${result.stderr}`;
      const found = extractApprovalUrl(output);
      if (found) {
        setRuntime({ state: 'needs-approval', approvalUrl: found, errorCode: 'needs_approval', errorMessage: 'Tailscale needs tailnet approval before the mapping goes live. Approve, then retry.' });
        return { applied: false, approvalUrl: found };
      }
      const classified = classifyApplyFailure(output);
      if (classified) {
        setRuntime({ state: 'error', errorCode: classified.code, errorMessage: classified.message });
        return { applied: false };
      }
      setRuntime({ state: 'error', errorCode: 'apply_failed', errorMessage: `tailscale ${mode} exited with code ${result.code}.` });
      return { applied: false };
    }
    return { applied: true };
  };

  /**
   * Reconcile desired (config) vs actual (serve status) state. Never throws:
   * every failure is captured in the status model with a stable error code.
   * Runs serialized via `reconcile()`: `myGeneration` is the generation this
   * run was scheduled under.
   */
  const runReconcile = async (myGeneration) => {
    clearProbeTimer();
    setRuntime({ approvalUrl: null, errorCode: null, errorMessage: null });
    const boundPort = getPort();
    if (!Number.isInteger(boundPort) || boundPort <= 0) {
      setRuntime({ state: 'error', errorCode: 'unknown', errorMessage: 'Server port is not bound yet.' });
      return getStatus();
    }

    if (!config.enabled) {
      // Disabled: remove any stale mapping PiChamber created, leave foreign
      // mappings untouched, and report off. Without a successful status
      // query there is no positive ownership, so the record is kept for the
      // next reconcile to retry with verification.
      const record = await readMappingRecord();
      if (myGeneration !== generation) return getStatus();
      const removal = record ? await removeVerifiedOwnMapping(record, myGeneration) : null;
      if (myGeneration !== generation) return getStatus();
      // Still report host prerequisites (`status --json` only, no
      // serve/funnel commands) so the UI shows Not installed / Not signed
      // in accurately instead of a blanket Off; retry re-checks them.
      const hostInfo = await queryStatus();
      if (myGeneration !== generation) return getStatus();
      applyHostInfo(hostInfo);
      const failure = removalFailure(removal, record);
      if (failure) {
        setRuntime({ state: 'error', url: null, ...failure });
        return getStatus();
      }
      setRuntime({ state: 'off', url: null });
      return getStatus();
    }

    const gate = checkTailscaleAuthGate({
      enabled: true,
      mode: config.mode,
      uiPasswordConfigured: isUiAuthEnabled(),
      unsafeUnauthenticatedLanAllowed: isUnsafeUnauthenticatedLanAllowed(),
    });
    if (!gate.allowed) {
      // Blocked (e.g. the desktop password was cleared and the app
      // restarted): tailscaled persists serve config, so an existing mapping
      // PiChamber created would stay reachable without auth. Remove it with
      // the same verified ownership check as the disabled path, then report
      // blocked. A query failure or a failed removal keeps the record and
      // reports `error` instead: a surviving mapping here is reachable
      // without auth, so it must never be reported as `blocked`.
      const record = await readMappingRecord();
      if (myGeneration !== generation) return getStatus();
      const removal = record ? await removeVerifiedOwnMapping(record, myGeneration) : null;
      if (myGeneration !== generation) return getStatus();
      // Same host-prerequisite refresh as the disabled path.
      const hostInfo = await queryStatus();
      if (myGeneration !== generation) return getStatus();
      applyHostInfo(hostInfo);
      const failure = removalFailure(removal, record);
      if (failure) {
        setRuntime({ state: 'error', url: null, ...failure });
        return getStatus();
      }
      setRuntime({ state: 'blocked', url: null, errorCode: gate.code, errorMessage: gate.message });
      return getStatus();
    }

    setRuntime({ state: 'starting', url: null });
    const hostInfo = await queryStatus();
    if (myGeneration !== generation) return getStatus();
    applyHostInfo(hostInfo);
    if (!hostInfo.installed) {
      setRuntime({ state: 'unavailable', errorCode: 'not_installed', errorMessage: 'The tailscale executable was not found. Install Tailscale to use remote access.' });
      return getStatus();
    }
    if (!hostInfo.running) {
      setRuntime({ state: 'unavailable', errorCode: 'not_running', errorMessage: 'The Tailscale daemon is not running. Start it, then retry.' });
      return getStatus();
    }
    if (!hostInfo.loggedIn || !hostInfo.magicDnsName) {
      setRuntime({ state: 'unavailable', errorCode: 'not_logged_in', errorMessage: 'Tailscale is not logged in. Run: tailscale up' });
      return getStatus();
    }

    // Crash safety: a stale record for a different port/mode must be removed
    // (when it is ours) before the new mapping is applied. A failed status
    // query leaves the old record in place and ends in error/retry — in
    // particular a public→private switch never leaves a live Funnel behind
    // while claiming success.
    const stale = await readMappingRecord();
    if (stale && (stale.httpsPort !== config.httpsPort || stale.mode !== config.mode)) {
      // A failed removal keeps the old record: never apply the new mapping
      // while the old one may still be live, so retry can remove it first.
      // The generation is checked before interpreting the result, so a
      // superseded removal (which removed nothing) never reports an error.
      const removal = await removeVerifiedOwnMapping(stale, myGeneration);
      if (myGeneration !== generation) return getStatus();
      const failure = removalFailure(removal, stale);
      if (failure) {
        setRuntime({ state: 'error', url: null, ...failure });
        return getStatus();
      }
    }

    const queried = await queryServeMapping(config.mode);
    if (myGeneration !== generation) return getStatus();
    if (!queried.ok) {
      // Unknown, not absent: refuse to apply rather than overwriting a
      // mapping we cannot see. The stale record (if any) is kept for
      // cleanup once the query succeeds.
      setRuntime({ state: 'error', url: null, errorCode: 'status_query_failed', errorMessage: STATUS_QUERY_FAILED_MESSAGE });
      return getStatus();
    }
    const mapping = queried.status ? findServeMappingForPort(queried.status, config.httpsPort) : null;
    const classification = classifyServeMapping({ mapping, httpsPort: config.httpsPort, boundPort });
    if (classification.kind === 'foreign') {
      // Crash-restart on a new local port: the live mapping points at the
      // recorded port instead of this bound port. The record (same
      // port+mode) proves PiChamber created it, so re-verify the live
      // targets against the recorded port and repoint instead of conflict.
      // (When the stale cleanup above cleared the record it no longer
      // applies, so fall back to a fresh read.) Ownership still needs BOTH
      // the record and the live targets — never repoint on the record alone.
      const record = stale && stale.httpsPort === config.httpsPort && stale.mode === config.mode
        ? stale
        : await readMappingRecord();
      const recordedOurs = record
        && record.httpsPort === config.httpsPort
        && record.mode === config.mode
        && record.localPort !== boundPort
        && classifyServeMapping({ mapping, httpsPort: config.httpsPort, boundPort: record.localPort }).kind === 'ours';
      if (!recordedOurs) {
        setRuntime({ state: 'conflict', url: null, errorCode: 'conflict', errorMessage: conflictMessageForPort(config.httpsPort) });
        return getStatus();
      }
      // Ours by record, still pointing at the previous local port: fall
      // through and repoint it at this bound port.
    }
    if (classification.kind === 'ours') {
      const record = await readMappingRecord();
      const sameTarget = record && record.httpsPort === config.httpsPort && record.mode === config.mode && record.localPort === boundPort;
      if (sameTarget) {
        // Mapping already fronts this server: verify it answers as us.
        const url = buildTailscaleUrl({ magicDnsName: hostInfo.magicDnsName, httpsPort: config.httpsPort });
        const ok = await probeUrl(url);
        if (myGeneration !== generation) return getStatus();
        if (ok) {
          setRuntime({ state: 'active', url, approvalUrl: null });
        } else {
          setRuntime({ state: 'starting', url: null });
          scheduleProbeRetries(myGeneration, url, PROBE_RETRY_DELAYS_MS);
        }
        return getStatus();
      }
      // Ours and already pointing at this bound port, but the record is
      // missing or names a different port: fall through and re-apply it so
      // the record is rewritten.
    }

    const applied = await applyMapping(myGeneration, { mode: config.mode, httpsPort: config.httpsPort, localPort: boundPort });
    if (myGeneration !== generation) return getStatus();
    if (!applied.applied) return getStatus();
    await writeMappingRecord({ httpsPort: config.httpsPort, mode: config.mode, localPort: boundPort });
    const url = buildTailscaleUrl({ magicDnsName: hostInfo.magicDnsName, httpsPort: config.httpsPort });
    const ok = await probeUrl(url);
    if (myGeneration !== generation) return getStatus();
    if (ok) {
      setRuntime({ state: 'active', url, approvalUrl: null });
    } else {
      // First-use HTTPS/DNS provisioning can take minutes: report starting
      // and keep re-probing in the background with backoff.
      setRuntime({ state: 'starting', url: null });
      scheduleProbeRetries(myGeneration, url, PROBE_RETRY_DELAYS_MS);
    }
    return getStatus();
  };

  const getStatus = () => {
    const authGateFor = (mode) => {
      try {
        return checkTailscaleAuthGate({
          enabled: true,
          mode,
          uiPasswordConfigured: isUiAuthEnabled(),
          unsafeUnauthenticatedLanAllowed: isUnsafeUnauthenticatedLanAllowed(),
        }).allowed === true;
      } catch {
        return false;
      }
    };
    return {
      installed: status.installed,
      running: status.running,
      loggedIn: status.loggedIn,
      magicDnsName: status.magicDnsName,
      httpsCertsAvailable: status.httpsCertsAvailable,
      config: { ...config },
      state: status.state,
      url: status.state === 'active' ? status.url : null,
      approvalUrl: status.approvalUrl,
      errorCode: status.errorCode,
      errorMessage: status.errorMessage,
      authGate: { privateAllowed: authGateFor('private'), publicAllowed: authGateFor('public') },
    };
  };

  // Serialized entry point: reconciles run one at a time in call order. A
  // run superseded while queued is skipped; a superseded in-flight run
  // finishes quickly (`bumpGeneration()` aborts its apply) and never
  // removes a mapping after the newer run starts (generation re-checked
  // after the serve-status query and before every state write).
  const reconcile = () => {
    const myGeneration = generation;
    const pending = reconcileTail.catch(() => {}).then(() => {
      if (myGeneration !== generation) return getStatus();
      return runReconcile(myGeneration);
    });
    reconcileTail = pending.catch(() => {});
    return pending;
  };

  // Config/retry responses wait for reconcile only up to a short grace,
  // then return the current (possibly transitional) status while
  // reconcile continues in the background. Callers poll `GET /status`
  // until a terminal state. Validation/auth-gate errors still throw
  // synchronously before kickoff via `setConfig` above.
  const reconcileWithGrace = () => {
    const myGeneration = generation;
    const pending = reconcile();
    // Background safety net (same precedent as the startup reconcile in
    // `server/index.js`): never an unhandled rejection. Only records when
    // still current so a superseded generation cannot clobber live state.
    pending.catch((error) => {
      logWarn(`[tailscale] Background reconcile failed: ${error?.message || error}`);
      if (myGeneration === generation) {
        setRuntime({ state: 'error', errorCode: 'unknown', errorMessage: 'Tailscale reconcile failed unexpectedly.' });
      }
    });
    const graceMs = Number.isFinite(configResponseGraceMs) && configResponseGraceMs >= 0
      ? configResponseGraceMs
      : CONFIG_RESPONSE_GRACE_MS;
    let timer = null;
    const graceElapsed = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), graceMs);
      if (timer?.unref) timer.unref();
    });
    const settled = pending.then(
      (result) => {
        if (timer) clearTimeout(timer);
        return result;
      },
      () => {
        if (timer) clearTimeout(timer);
        return getStatus();
      },
    );
    return Promise.race([settled, graceElapsed.then(() => getStatus())]);
  };

  const setConfig = async (patch) => {
    const merged = normalizeTailscaleConfig({ ...config, ...(patch || {}) });
    const validation = validateTailscaleConfig({ ...config, ...(patch || {}) });
    if (!validation.ok) {
      const error = new Error(validation.errors.join('; '));
      error.code = 'invalid_config';
      throw error;
    }
    if (merged.enabled) {
      const gate = checkTailscaleAuthGate({
        enabled: true,
        mode: merged.mode,
        uiPasswordConfigured: isUiAuthEnabled(),
        unsafeUnauthenticatedLanAllowed: isUnsafeUnauthenticatedLanAllowed(),
      });
      if (!gate.allowed) {
        const error = new Error(gate.message);
        error.code = gate.code;
        throw error;
      }
    }
    bumpGeneration();
    await persistConfig(merged);
    return reconcileWithGrace();
  };

  const shutdown = async () => {
    bumpGeneration();
    clearProbeTimer();
    try {
      // Verify ownership before removing: a failed status query leaves the
      // mapping (and the record) untouched so the next start's stale
      // cleanup can retry with verification. Each step is bounded by the
      // shutdown timeouts, which fit inside Electron's quit timeout.
      const record = await readMappingRecord();
      if (record) {
        const queried = await queryServeMapping(record.mode, SHUTDOWN_STATUS_TIMEOUT_MS);
        if (!queried.ok) {
          logWarn('[tailscale] Shutdown: serve status query failed; leaving the mapping for next-start cleanup.');
        } else {
          const mapping = queried.status ? findServeMappingForPort(queried.status, record.httpsPort) : null;
          const classification = classifyServeMapping({ mapping, httpsPort: record.httpsPort, boundPort: record.localPort });
          if (classification.kind === 'ours') {
            const { removed } = await removeMapping({ mode: record.mode, httpsPort: record.httpsPort, timeoutMs: SHUTDOWN_REMOVE_TIMEOUT_MS });
            if (!removed) {
              logWarn(`[tailscale] Shutdown: could not remove ${record.mode} mapping on https port ${record.httpsPort}; leaving it for next-start cleanup.`);
            } else {
              await clearMappingRecord();
            }
          } else if (classification.kind === 'foreign') {
            logWarn(`[tailscale] Shutdown: mapping on port ${record.httpsPort} is not ours; leaving it alone.`);
            await clearMappingRecord();
          } else {
            await clearMappingRecord();
          }
        }
      }
    } catch (error) {
      logWarn(`[tailscale] Shutdown cleanup failed: ${error?.message || error}`);
    }
    setRuntime({ state: config.enabled ? status.state : 'off', url: null, approvalUrl: null });
  };

  const dispose = () => {
    bumpGeneration();
    clearProbeTimer();
  };

  const getPairingCandidate = () => {
    if (status.state !== 'active' || !status.url) return null;
    return { type: 'tailscale', url: status.url, mode: config.mode, priority: 20 };
  };

  const getTransports = () => {
    const active = status.state === 'active';
    // A starting/needs-approval mapping that is already written still
    // fronts this server (or is about to), so quitting without the
    // removal step orphans it — treat it as quit-risky like active.
    const pendingRisky = (status.state === 'starting' || status.state === 'needs-approval') && mappingRecordPresent;
    const available = active || pendingRisky;
    return {
      available,
      url: active ? status.url : null,
      mode: config.mode,
    };
  };

  return {
    loadConfig,
    getConfig: () => ({ ...config }),
    setConfig,
    getStatus,
    reconcile,
    retry: () => {
      bumpGeneration();
      return reconcileWithGrace();
    },
    shutdown,
    dispose,
    getPairingCandidate,
    getTransports,
    validateTailscaleConfig,
  };
};

/**
 * CLI/serve startup helper: persist config without starting the service.
 * Enforces the auth gate itself (core-enforced, never CLI-only): enabling
 * without a UI password rejects with `auth_required`.
 */
export const persistTailscaleConfigForStartup = async ({
  dataDir,
  patch,
  fsPromises = fs.promises,
  uiPasswordConfigured = false,
  unsafeUnauthenticatedLanAllowed = false,
}) => {
  const current = normalizeTailscaleConfig(await readJsonFile(fsPromises, path.join(dataDir, TAILSCALE_CONFIG_FILE)));
  const merged = normalizeTailscaleConfig({ ...current, ...(patch || {}) });
  const validation = validateTailscaleConfig({ ...current, ...(patch || {}) });
  if (!validation.ok) {
    throw new Error(validation.errors.join('; '));
  }
  if (merged.enabled) {
    const gate = checkTailscaleAuthGate({
      enabled: true,
      mode: merged.mode,
      uiPasswordConfigured,
      unsafeUnauthenticatedLanAllowed,
    });
    if (!gate.allowed) {
      const error = new Error(gate.message);
      error.code = gate.code;
      throw error;
    }
  }
  await writeJsonFileAtomic(fsPromises, path.join(dataDir, TAILSCALE_CONFIG_FILE), merged);
  return merged;
};
