/**
 * Session engine router: daemon-owned dispatch that keeps session-daemon.js
 * to thin call sites. The registry stays in `session-engines.js`; this
 * module owns ownership-first routing, `sessions.create` targeting,
 * listing merges, snapshot framing data, the redacting publish wrapper, and
 * the `engines.list` description.
 *
 * Every function is a cheap guard when no engines are registered (or no
 * registry exists), so the zero-engine path runs exactly the Pi-only code.
 * All engine output is redacted through the injected `redact` dependency
 * (the daemon passes `redactAttachmentValues`).
 */

import { isAbsolute } from 'node:path';

import {
  ENGINE_SESSION_COMMANDS,
  ENGINE_UNSUPPORTED_OPERATION,
} from './session-engines.js';
import { normalizePendingInputSummary } from './pending-input.js';

const DETAIL_COMMANDS = new Set([
  'sessions.open',
  'sessions.messages',
  'sessions.navigate',
  'sessions.fork',
  'sessions.clone',
  'sessions.create',
]);

const PROMPT_COMMANDS = new Set(['sessions.prompt', 'sessions.steer', 'sessions.followUp']);

const deliveryOf = (command) => (
  command === 'sessions.steer' ? 'steer' : command === 'sessions.followUp' ? 'followUp' : undefined
);

const invalidArgument = (createError, message) => {
  throw createError('INVALID_ARGUMENT', message);
};

/**
 * @param {{
 *   getRegistry: () => ({ size: number } | undefined),
 *   resolveDirectory: (requested: unknown) => Promise<string>,
 *   sessionInput: (payload: object, delivery?: string, execute?: (payload: object) => Promise<object>) => Promise<object>,
 *   redact: (value: unknown) => unknown,
 *   createError: (code: string, message: string) => Error,
 *   logEngineError?: (engineId: string, event: string, error: unknown) => void,
 *   writeFrame: (socket: object, frame: object) => void,
 *   writeDetail: (socket: object, requestId: string, detail: object) => void,
 *   publish: (event: string, payload: object, sessionId: string, directory?: string) => void,
 *   getStreamEpoch: () => string,
 *   allocateSequence: () => number,
 *   protocolVersion: number,
 *   pendingInput?: { applyEngineSummary: (sessionId: string, directory: string, summary: object | null) => void, summaryFor: (sessionId: string) => object | null, forgetSession: (sessionId: string) => void },
 *   getSequence?: () => number,
 * }} deps
 */
export const createSessionEngineRouter = ({
  getRegistry,
  resolveDirectory,
  sessionInput,
  redact,
  createError,
  logEngineError,
  writeFrame,
  writeDetail,
  publish,
  getStreamEpoch,
  allocateSequence,
  protocolVersion,
  pendingInput,
  getSequence,
} = {}) => {
  // Redaction is mandatory: engine output never reaches the wire unredacted.
  if (typeof redact !== 'function') throw new TypeError('Session engine output requires a redact function.');
  const applyRedact = redact;
  const fail = (code, message) => {
    throw createError(code, message);
  };

  const hasEngines = () => {
    const registry = getRegistry?.();
    return Boolean(registry) && registry.size > 0;
  };

  const ownerOfSession = (sessionId, directory) => getRegistry?.()?.ownerOfSession?.(sessionId, directory);

  const publishEngineEvent = (event, payload, sessionId, directory) => {
    if (typeof event !== 'string' || event.length === 0 || event === 'session.snapshot') {
      return fail('INVALID_ARGUMENT', 'The session engine event is invalid.');
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return fail('INVALID_ARGUMENT', 'The session engine event session is invalid.');
    }
    if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload))) {
      return fail('INVALID_ARGUMENT', 'The session engine event payload is invalid.');
    }
    if (typeof directory !== 'string' || directory.length === 0 || !isAbsolute(directory)) {
      return fail('INVALID_ARGUMENT', 'The session engine event directory is invalid.');
    }
    // Engines MUST publish `session.input { pending }` on every pending-input
    // transition for live updates. The summary is normalized and folded into
    // the daemon pending-input index, which publishes the canonical event;
    // the engine payload itself is never published directly.
    if (event === 'session.input') {
      const pending = normalizePendingInputSummary(payload?.pending);
      if (pending === undefined) {
        return fail('INVALID_ARGUMENT', 'The session engine pending input is invalid.');
      }
      pendingInput?.applyEngineSummary(sessionId, directory, pending);
      return;
    }
    // `session.deleted` already tells clients; drop pending-input state
    // without publishing a redundant `session.input`.
    if (event === 'session.deleted') {
      pendingInput?.forgetSession(sessionId);
    }
    const { sessionId: _payloadSessionId, directory: _payloadDirectory, ...cleanPayload } = payload ?? {};
    publish(event, applyRedact(cleanPayload), sessionId, directory);
  };

  const snapshotEvent = (sessionId, { resync = false } = {}) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || !hasEngines()) return undefined;
    const owner = ownerOfSession(sessionId);
    if (!owner) return undefined;
    let fields;
    try {
      fields = owner.snapshot(sessionId);
    } catch (error) {
      try {
        logEngineError?.(owner.id, 'snapshot-failed', error);
      } catch {}
      return undefined;
    }
    if (!fields || typeof fields !== 'object' || typeof fields.then === 'function') return undefined;
    const safeFields = applyRedact(fields);
    if (typeof safeFields?.directory !== 'string' || safeFields.directory.length === 0
      || !isAbsolute(safeFields.directory)) return undefined;
    const nextSequence = allocateSequence();
    // Daemon-owned pending input: the engine MAY carry
    // `inputState: { pending }` on snapshot fields; otherwise the last
    // `session.input` summary from the index applies. Placed after spreading
    // safeFields so the engine cannot inject a malformed value.
    const snapshotPending = normalizePendingInputSummary(safeFields?.inputState?.pending);
    return {
      sequence: nextSequence,
      payload: {
        isStreaming: false,
        lifecycle: 'idle',
        queue: { steering: 0, followUp: 0 },
        ...safeFields,
        inputState: {
          pending: snapshotPending === undefined ? (pendingInput?.summaryFor(sessionId) ?? null) : snapshotPending,
        },
        sessionId,
        directory: safeFields.directory,
        ...(resync ? { resync: true } : {}),
        serverNow: Date.now(),
        lastSequence: nextSequence,
      },
    };
  };

  const stampDetail = (detail, engineId) => {
    if (!detail || typeof detail !== 'object') return detail;
    const safe = applyRedact(detail);
    const detailPending = normalizePendingInputSummary(safe?.inputState?.pending);
    const sessionId = safe?.session && typeof safe.session === 'object' ? safe.session.id : undefined;
    const withInput = {
      inputState: {
        pending: detailPending === undefined
          ? (typeof sessionId === 'string' ? (pendingInput?.summaryFor(sessionId) ?? null) : null)
          : detailPending,
      },
    };
    if (safe.session && typeof safe.session === 'object') {
      return { ...safe, ...withInput, session: { ...safe.session, engine: engineId } };
    }
    return { ...safe, ...withInput };
  };

  const runHandler = async (engine, command, payload) => {
    const handler = engine.handlers?.[command];
    if (typeof handler !== 'function') {
      return fail(ENGINE_UNSUPPORTED_OPERATION, 'The session engine does not support this command.');
    }
    return handler(payload);
  };

  const dispatch = async (socket, message) => {
    const registry = getRegistry?.();
    if (!registry || registry.size === 0) return false;
    if (ENGINE_SESSION_COMMANDS.has(message?.command)) {
      const engineSessionId = message?.payload?.sessionId;
      if (typeof engineSessionId === 'string' && engineSessionId.length > 0) {
        const owner = registry.ownerOfSession(engineSessionId, message.payload?.directory || message.payload?.cwd);
        if (owner) {
          const payload = message.payload ?? {};
          const requestedDir = payload.directory || payload.cwd;
          const enginePayload = requestedDir !== undefined
            ? { ...payload, directory: await resolveDirectory(requestedDir) }
            : payload;
          if (PROMPT_COMMANDS.has(message.command)) {
            const delivery = deliveryOf(message.command);
            const result = await sessionInput(enginePayload, delivery, (promptPayload) => Promise.resolve()
              .then(() => runHandler(owner, message.command, promptPayload))
              .then((engineResult) => {
                if (!engineResult || typeof engineResult !== 'object'
                  || typeof engineResult.messageId !== 'string' || engineResult.messageId.length === 0) {
                  return fail('MALFORMED_DAEMON_RESPONSE', 'The session engine returned an invalid response.');
                }
                return { ...applyRedact(engineResult), accepted: true };
              }));
            writeFrame(socket, {
              protocolVersion, kind: 'response', requestId: message.requestId, result,
            });
            return true;
          }
          const engineResult = await runHandler(owner, message.command, enginePayload);
          if (DETAIL_COMMANDS.has(message.command)) {
            if (!engineResult || typeof engineResult !== 'object') {
              return fail('MALFORMED_DAEMON_RESPONSE', 'The session engine returned an invalid response.');
            }
            writeDetail(socket, message.requestId, stampDetail(engineResult, owner.id));
            return true;
          }
          writeFrame(socket, {
            protocolVersion, kind: 'response', requestId: message.requestId, result: applyRedact(engineResult ?? {}),
          });
          return true;
        }
      }
      return false;
    }
    if (message?.command === 'extensions.draft') {
      const engineSessionId = message?.payload?.sessionId;
      if (typeof engineSessionId === 'string' && engineSessionId.length > 0
        && registry.ownerOfSession(engineSessionId, message.payload?.directory || message.payload?.cwd)) {
        return fail(ENGINE_UNSUPPORTED_OPERATION, 'The session engine does not support drafts.');
      }
    }
    return false;
  };

  const resolveCreateOwner = (createPayload) => {
    const requestedEngine = createPayload && typeof createPayload === 'object' ? createPayload.engine : undefined;
    const registry = getRegistry?.();
    if (requestedEngine !== undefined) {
      if (requestedEngine === 'pi') return undefined;
      const owner = typeof requestedEngine === 'string' ? registry?.get?.(requestedEngine) : undefined;
      if (!owner) return fail('INVALID_ARGUMENT', 'The requested session engine is invalid.');
      if (typeof owner.handlers?.['sessions.create'] !== 'function') {
        return fail(ENGINE_UNSUPPORTED_OPERATION, 'The session engine does not support creation.');
      }
      return owner;
    }
    if (!hasEngines() || !createPayload || typeof createPayload !== 'object'
      || typeof createPayload.model?.providerId !== 'string') {
      return undefined;
    }
    const owner = registry.ownerOfProvider(createPayload.model.providerId);
    if (!owner) return undefined;
    if (typeof owner.handlers?.['sessions.create'] !== 'function') return undefined;
    return owner;
  };

  const create = async (socket, message) => {
    const createPayload = message?.payload;
    const owner = resolveCreateOwner(createPayload);
    if (!owner) return false;
    if (!createPayload || typeof createPayload !== 'object') {
      return invalidArgument(createError, 'The requested session creation options are invalid.');
    }
    const createTargetCwd = await resolveDirectory(createPayload.cwd);
    const created = await runHandler(owner, 'sessions.create', { ...createPayload, cwd: createTargetCwd });
    if (!created || typeof created !== 'object') {
      return fail('MALFORMED_DAEMON_RESPONSE', 'The session engine returned an invalid response.');
    }
    writeDetail(socket, message.requestId, stampDetail(created, owner.id));
    return true;
  };

  const mergeSessionList = async (piSessions, targetDir) => {
    const registry = getRegistry?.();
    if (!registry || registry.size === 0) return { sessions: piSessions };
    const engineSessions = await registry.listSessions(targetDir);
    // Sampled once when the engine result is merged so every engine row
    // carries the same sequence.
    const observedSequence = typeof getSequence === 'function' ? getSequence() : 0;
    const seenSessionIds = new Set(piSessions.map((item) => item?.session?.id));
    const mergedSessions = [...piSessions];
    const failedSessionEngines = [...engineSessions.failed];
    for (const item of engineSessions.items) {
      if (seenSessionIds.has(item?.session?.id)) {
        if (!failedSessionEngines.includes(item.session.engine)) failedSessionEngines.push(item.session.engine);
        continue;
      }
      seenSessionIds.add(item?.session?.id);
      // Engines MAY carry `inputState: { pending }` on list rows; a missing
      // or malformed value falls back to the index without failing the row.
      // The redaction step above never breaks this: the summary carries only
      // count/kind/since, never paths.
      const rowPending = normalizePendingInputSummary(item?.inputState?.pending);
      mergedSessions.push({
        ...item,
        inputState: {
          pending: rowPending === undefined
            ? (pendingInput?.summaryFor(item?.session?.id) ?? null)
            : rowPending,
          sequence: observedSequence,
        },
      });
    }
    return {
      sessions: mergedSessions,
      ...(failedSessionEngines.length > 0 ? { incompleteEngines: failedSessionEngines } : {}),
    };
  };

  const mergeProviders = async (piResult) => {
    const registry = getRegistry?.();
    if (!registry || registry.size === 0) return { providers: piResult.providers };
    const engineProviders = await registry.listProviders();
    const seenProviderIds = new Set(piResult.providers.map((provider) => provider.id));
    const mergedProviders = [...piResult.providers];
    const failedProviderEngines = [...engineProviders.failed];
    for (const provider of engineProviders.providers) {
      if (seenProviderIds.has(provider.id)) {
        if (!failedProviderEngines.includes(provider.engine)) failedProviderEngines.push(provider.engine);
        continue;
      }
      seenProviderIds.add(provider.id);
      const { engine: _providerEngine, ...cleanProvider } = provider;
      mergedProviders.push(applyRedact(cleanProvider));
    }
    return {
      providers: mergedProviders,
      ...(failedProviderEngines.length > 0 ? { incompleteEngines: failedProviderEngines } : {}),
    };
  };

  const describe = () => {
    const registry = getRegistry?.();
    if (!registry || registry.size === 0) return { engines: [] };
    return {
      engines: registry.describeEngines().map((entry) => ({
        id: entry.id,
        label: entry.label,
        commands: [...entry.commands],
      })),
    };
  };

  return {
    hasEngines,
    publish: publishEngineEvent,
    snapshotEvent,
    dispatch,
    create,
    resolveCreateOwner,
    mergeSessionList,
    mergeProviders,
    describe,
  };
};
