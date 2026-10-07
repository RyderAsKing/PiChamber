/**
 * Session engine registry: the Pi-neutral seam that lets a build register
 * extra session "engines" (other coding agents) without touching the Pi
 * runtime code. PiChamber main ships zero engines, so every daemon behavior
 * stays byte-identical to the Pi-only path until a factory is registered.
 *
 * An engine translates its own agent events into PiChamber's existing
 * session event protocol and publishes them through the host `publish`
 * wrapper, so engine events share the global sequence, stream epoch, and
 * replay log and are indistinguishable on the wire.
 *
 * All engine output (list rows, provider rows, event payloads, detail and
 * command results, snapshot fields) is redacted through the injected
 * `redact` dependency (the daemon passes `redactAttachmentValues`), so a
 * server-local attachment path an engine echoes back never reaches the
 * public wire.
 *
 * Pending input: engines MAY carry `inputState: { pending }` on list rows,
 * snapshot fields, and detail results, where `pending` is
 * `{ count, kind, since }` (`count` an integer 1..99, `kind` `'input'` or
 * `'approval'`, `since` epoch ms of the oldest open request) or `null` when
 * authoritatively nothing is pending. `kind: 'approval'` marks a
 * permission-style request; `'input'` marks any other request. A missing or
 * malformed value falls back to the daemon index without failing the row.
 * Engines MUST publish `session.input { pending }` on every pending-input
 * transition for live updates; the daemon normalizes the summary (unknown
 * kinds become `'input'`) and republishes it canonically, rejecting a
 * malformed summary as `INVALID_ARGUMENT`.
 */

/**
 * Stable error code an engine throws (as `.code` on the thrown error) when
 * it does not implement a session-scoped command routed to it. The router
 * throws this automatically for a routed command with no handler, so
 * engines never write it themselves.
 */
export const ENGINE_UNSUPPORTED_OPERATION = 'ENGINE_UNSUPPORTED_OPERATION';

const ENGINE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Whether a value is usable as a session engine id. `'pi'` is reserved for
 * the built-in Pi runtime and can never name an engine.
 */
export const isValidEngineId = (value) => typeof value === 'string'
  && value !== 'pi'
  && ENGINE_ID_PATTERN.test(value);

/**
 * Whether a value is usable as a session engine label: a non-empty string
 * of at most 64 characters. Missing labels default to the engine id.
 */
export const isValidEngineLabel = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 64;

/**
 * Session-scoped daemon commands routed to the engine that owns the
 * session. All other commands (extension, resource, settings, provider
 * auth, `sessions.list`, `sessions.create`, `sessions.sendReceipt`,
 * `extensions.draft`, `engines.list`) stay Pi-only or are dispatched
 * separately.
 */
export const ENGINE_SESSION_COMMANDS = Object.freeze(new Set([
  'sessions.open',
  'sessions.messages',
  'sessions.rename',
  'sessions.delete',
  'sessions.tree',
  'sessions.navigate',
  'sessions.fork',
  'sessions.clone',
  'sessions.prompt',
  'sessions.steer',
  'sessions.followUp',
  'sessions.abort',
  'sessions.setModel',
  'sessions.setThinking',
  'sessions.compact',
]));

/**
 * Commands an engine may implement in its handler map: the routed session
 * commands plus `sessions.create`. `engines.list` command strings are drawn
 * from this set, and the route projector keeps only these values.
 */
export const ENGINE_HANDLER_COMMANDS = Object.freeze(new Set([
  ...ENGINE_SESSION_COMMANDS,
  'sessions.create',
]));

const sanitizeLogToken = (value, fallback) => {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const cleaned = value.replace(/[\r\n]/g, '').slice(0, 128);
  return cleaned.length > 0 ? cleaned : fallback;
};

const defaultSessionEngineLogger = (engineId, event, code) => {
  process.stderr.write(
    `[session-engine] ${sanitizeLogToken(engineId, 'unknown')} ${sanitizeLogToken(event, 'event')} ${sanitizeLogToken(code, 'UNKNOWN')}\n`,
  );
};

/**
 * Report an engine failure through the registry logger. Only the engine id,
 * a short event name, and the error's stable `code` cross the boundary:
 * error messages, payloads, credentials, and paths are never logged.
 * A throwing logger cannot break daemon dispatch.
 */
export const logSessionEngineError = (logger, engineId, event, error) => {
  const code = typeof error?.code === 'string' && ERROR_CODE_PATTERN.test(error.code) ? error.code : 'UNKNOWN';
  try {
    (typeof logger === 'function' ? logger : defaultSessionEngineLogger)(engineId, event, code);
  } catch {}
};

const invalidEngineError = (message) => {
  const error = new Error(message);
  error.code = 'INVALID_ENGINE';
  return error;
};

const REQUIRED_ENGINE_METHODS = ['ownsSession', 'ownsProvider', 'listSessions', 'snapshot', 'dispose'];

const isInvalidHandlersShape = (handlers) => {
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) return true;
  return Object.entries(handlers).some(([command, handler]) => (
    !ENGINE_HANDLER_COMMANDS.has(command) || typeof handler !== 'function'
  ));
};

const isInvalidEngineShape = (engine) => {
  if (!engine || typeof engine !== 'object') return true;
  if (!isValidEngineId(engine.id)) return true;
  if (engine.label !== undefined && !isValidEngineLabel(engine.label)) return true;
  if (engine.listProviders !== undefined && typeof engine.listProviders !== 'function') return true;
  if (isInvalidHandlersShape(engine.handlers)) return true;
  return REQUIRED_ENGINE_METHODS.some((method) => typeof engine[method] !== 'function');
};

const engineLabelOf = (engine) => (
  typeof engine.label === 'string' && engine.label.length > 0 ? engine.label : engine.id
);

export const engineCommandsOf = (engine) => Object.keys(engine?.handlers ?? {}).sort();

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isValidListRow = (row) => {
  if (!isRecord(row) || !isRecord(row.session)) return false;
  if (typeof row.session.id !== 'string' || row.session.id.length === 0) return false;
  return Number.isFinite(row.session.createdAt)
    && Number.isFinite(row.session.updatedAt)
    && Number.isFinite(row.updatedAt);
};

const isValidProviderRow = (provider) => isRecord(provider)
  && typeof provider.id === 'string'
  && typeof provider.label === 'string'
  && typeof provider.authenticated === 'boolean'
  && Array.isArray(provider.models);

const extractProviderRows = (result) => {
  if (Array.isArray(result)) return result;
  if (isRecord(result) && Array.isArray(result.providers)) return result.providers;
  return undefined;
};

/**
 * @typedef {object} SessionEngineHost
 * @property {(event: string, payload: object | undefined, sessionId: string, directory: string) => void} publish
 *   Engine-facing publish wrapper. `directory` is required and must be an
 *   absolute path; it is passed through as-is and never falls back to Pi's
 *   active project. Engine events share the daemon's global
 *   sequence, stream epoch, and replay log. The wrapper redacts attachment
 *   paths and strips `sessionId` / `directory` keys from the payload so an
 *   engine cannot spoof them.
 * @property {(attachments: Array<object> | undefined) => Promise<{ text: string, images: Array<object>, files: Array<object> }>} prepareAttachments
 *   Same attachment preparation Pi prompts use: validates the shape,
 *   reads image bytes as base64 `images`, and turns other files into
 *   `[Attachment <name> is available at <path>]` text lines alongside
 *   path-free `files` metadata (`{ mime, filename }`). The returned `text`
 *   and `images` contain server-local paths and file bytes and must go
 *   only to the native agent, never into published events or results;
 *   router redaction still covers events and results as a backstop.
 *   `files` is path-free metadata safe to publish.
 * @property {string} streamEpoch Opaque stream-lifetime id of the daemon process.
 * @property {string} agentDir Server-side Pi agent directory.
 * @property {string} dataDir PiChamber data root.
 * @property {(engineId: string, event: string, error: unknown) => void} logger
 *   Sanitizing logger: only the engine id, event name, and stable error
 *   code are recorded, never messages or payloads.
 * @property {(code: string, message: string) => Error} createError Builds a
 *   daemon protocol error with the given stable code.
 */

/**
 * @typedef {object} SessionEngine
 * @property {string} id Engine id (`isValidEngineId`; never `'pi'`).
 * @property {string} [label] Optional display label (non-empty, at most 64
 *   characters; defaults to the id).
 * @property {(sessionId: string, directory?: string) => boolean} ownsSession
 *   Sync and cheap, answered from the engine's own index.
 * @property {(providerId: string) => boolean} ownsProvider Sync ownership check.
 * @property {(directory: string, options?: { signal?: AbortSignal }) => Promise<Array<object>>} listSessions
 *   Async rows in Pi's list-row shape. Must THROW on failure so the listing
 *   reports the engine in `failed` instead of empty success. Receives an
 *   AbortSignal aborted when the per-engine timeout fires. Output is
 *   redacted in core before it reaches the wire.
 * @property {((options?: { signal?: AbortSignal }) => Promise<object>) | undefined} [listProviders] Optional
 *   async Pi provider shape (`{ providers: [...] }` or a bare array).
 *   Receives an AbortSignal aborted when the per-engine timeout fires.
 * @property {Record<string, (payload: object) => Promise<object | undefined>>} handlers
 *   Handler map for session-scoped commands. Keys must belong to
 *   `ENGINE_HANDLER_COMMANDS` (the routed session commands plus
 *   `sessions.create`); values must be functions. Detail commands
 *   (open/messages/navigate/fork/clone/create) return a Pi-shaped detail
 *   (`{ session, messages, lastSequence, ... }`); prompt/steer/followUp
 *   return `{ messageId }`; others return a result object or undefined.
 *   A routed command with no handler fails as
 *   `ENGINE_UNSUPPORTED_OPERATION` automatically. Engines own their own
 *   event publication (e.g. `session.deleted` after delete,
 *   `session.updated` after rename). An engine publishing its own live
 *   user start publishes `assistant.message.start` with `role: 'user'` and
 *   includes the `files` metadata from `host.prepareAttachments` as
 *   path-free `file` parts
 *   (`{ type: 'file', id: `${messageId}:file:${index}`, index, mime, filename }`),
 *   the same shape Pi uses, so the browser shows the attachment footer
 *   immediately.
 * @property {(sessionId: string) => object | undefined} snapshot SYNC
 *   snapshot payload fields, or undefined when unavailable (never an empty
 *   session). Must include an absolute `directory`; a snapshot without one
 *   is treated as unavailable. Output is redacted in core.
 * @property {() => Promise<void>} dispose Async teardown.
 */

/**
 * @typedef {object} SessionEngineRegistry
 * @property {number} size Number of registered engines.
 * @property {(id: string) => SessionEngine | undefined} get
 * @property {(sessionId: string, directory?: string) => SessionEngine | undefined} ownerOfSession
 * @property {(providerId: string) => SessionEngine | undefined} ownerOfProvider
 * @property {(directory: string) => Promise<{ items: Array<object>, failed: Array<string> }>} listSessions
 * @property {() => Promise<{ providers: Array<object>, failed: Array<string> }>} listProviders
 * @property {() => Array<{ id: string, label: string, commands: Array<string> }>} describeEngines
 * @property {() => Promise<void>} disposeAll
 */

/**
 * Build the engine registry from an ordered list of factories. Each factory
 * runs as `factory(host)` in registration order; ownership follows that
 * order (first owner wins). A factory that throws is isolated (logged and
 * skipped) so the daemon still starts; a duplicate id or invalid id/shape
 * (including an unknown handler key, a non-function handler, a missing
 * `handlers` object, or an invalid label) is a programming error that
 * throws `INVALID_ENGINE` after best-effort disposal of already-created
 * engines.
 *
 * Listing calls share one in-flight result per directory (sessions) or one
 * global result (providers) across concurrent callers; the entry clears
 * when it settles and failures are never cached beyond the flight. Each
 * engine call receives an AbortSignal aborted when its per-engine timeout
 * fires so a hung engine can stop its work. Returned rows are redacted
 * through `redact` before attribution.
 *
 * @param {{ factories?: Array<(host: SessionEngineHost) => SessionEngine | Promise<SessionEngine>>, host: SessionEngineHost, logger?: (engineId: string, event: string, code: string) => void, listTimeoutMs?: number, redact: (value: unknown) => unknown }} [options]
 * @returns {Promise<SessionEngineRegistry>}
 */
export const createSessionEngineRegistry = async ({
  factories = [],
  host,
  logger,
  listTimeoutMs = 10_000,
  redact,
} = {}) => {
  const log = typeof logger === 'function' ? logger : undefined;
  // Redaction is mandatory: engine output never reaches the wire unredacted.
  if (typeof redact !== 'function') throw new TypeError('Session engine output requires a redact function.');
  const applyRedact = redact;
  const engines = [];
  const byId = new Map();

  const disposeCreated = async () => {
    for (const created of engines) {
      try {
        await created.dispose();
      } catch (error) {
        logSessionEngineError(log, created.id, 'dispose-failed', error);
      }
    }
  };

  for (const factory of factories) {
    let engine;
    try {
      engine = await factory(host);
    } catch (error) {
      logSessionEngineError(log, 'unknown', 'factory-failed', error);
      continue;
    }
    if (isInvalidEngineShape(engine) || byId.has(engine.id)) {
      await disposeCreated();
      throw invalidEngineError('The session engine registration is invalid.');
    }
    byId.set(engine.id, engine);
    engines.push(engine);
  }

  const ownerOf = (id, directory, check) => {
    if (typeof id !== 'string' || id.length === 0) return undefined;
    for (const engine of engines) {
      try {
        if (check(engine, directory)) return engine;
      } catch (error) {
        logSessionEngineError(log, engine.id, 'owns-failed', error);
      }
    }
    return undefined;
  };

  const callWithTimeout = (engine, event, invoke) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller?.abort();
        } catch {}
        const error = new Error('The session engine listing timed out.');
        error.code = 'ENGINE_TIMEOUT';
        reject(error);
      }, listTimeoutMs);
    });
    const task = Promise.resolve().then(() => invoke(controller?.signal));
    return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
  };

  const listSessionsUnshared = async (directory) => {
    const settled = await Promise.allSettled(engines.map((engine) => callWithTimeout(
      engine,
      'list-failed',
      (signal) => engine.listSessions(directory, { signal }),
    )));
    const items = [];
    const failed = [];
    settled.forEach((outcome, index) => {
      const engine = engines[index];
      if (outcome.status !== 'fulfilled' || !Array.isArray(outcome.value) || !outcome.value.every(isValidListRow)) {
        logSessionEngineError(log, engine.id, 'list-failed', outcome.status === 'rejected' ? outcome.reason : invalidEngineError('The session engine returned an invalid listing.'));
        failed.push(engine.id);
        return;
      }
      for (const row of outcome.value) {
        const redacted = applyRedact(row);
        const safeRow = isRecord(redacted) ? redacted : row;
        const safeSession = isRecord(safeRow.session) ? safeRow.session : row.session;
        items.push({ ...safeRow, session: { ...safeSession, directory, engine: engine.id } });
      }
    });
    return { items, failed };
  };

  const listProvidersUnshared = async () => {
    const contributing = engines.filter((engine) => typeof engine.listProviders === 'function');
    const settled = await Promise.allSettled(contributing.map((engine) => callWithTimeout(
      engine,
      'list-failed',
      (signal) => engine.listProviders({ signal }),
    )));
    const providers = [];
    const failed = [];
    settled.forEach((outcome, index) => {
      const engine = contributing[index];
      const rows = outcome.status === 'fulfilled' ? extractProviderRows(outcome.value) : undefined;
      if (!rows || !rows.every(isValidProviderRow)) {
        logSessionEngineError(log, engine.id, 'list-failed', outcome.status === 'rejected' ? outcome.reason : invalidEngineError('The session engine returned invalid providers.'));
        failed.push(engine.id);
        return;
      }
      // Stamped for merge attribution; the daemon strips it before
      // responding so the provider wire shape stays Pi-shaped.
      for (const provider of rows) {
        const redacted = applyRedact(provider);
        const safeProvider = isRecord(redacted) ? redacted : provider;
        providers.push({ ...safeProvider, engine: engine.id });
      }
    });
    return { providers, failed };
  };

  const listSessionsInflightByDirectory = new Map();
  let listProvidersInflight = null;

  return {
    get size() {
      return engines.length;
    },
    get: (id) => byId.get(id),
    ownerOfSession: (sessionId, directory) => ownerOf(sessionId, directory,
      (engine, engineDirectory) => engine.ownsSession(sessionId, engineDirectory)),
    ownerOfProvider: (providerId) => ownerOf(providerId, undefined,
      (engine) => engine.ownsProvider(providerId)),
    listSessions: async (directory) => {
      const cached = listSessionsInflightByDirectory.get(directory);
      if (cached) return cached;
      const pending = listSessionsUnshared(directory).finally(() => {
        if (listSessionsInflightByDirectory.get(directory) === pending) listSessionsInflightByDirectory.delete(directory);
      });
      listSessionsInflightByDirectory.set(directory, pending);
      return pending;
    },
    listProviders: async () => {
      if (listProvidersInflight) return listProvidersInflight;
      const pending = listProvidersUnshared().finally(() => {
        if (listProvidersInflight === pending) listProvidersInflight = null;
      });
      listProvidersInflight = pending;
      return pending;
    },
    describeEngines: () => engines.map((engine) => ({
      id: engine.id,
      label: engineLabelOf(engine),
      commands: engineCommandsOf(engine),
    })),
    disposeAll: async () => {
      const errors = [];
      for (const engine of engines) {
        try {
          await engine.dispose();
        } catch (error) {
          logSessionEngineError(log, engine.id, 'dispose-failed', error);
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more session engines could not be disposed.');
      }
    },
  };
};
