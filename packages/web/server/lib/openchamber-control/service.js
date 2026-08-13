import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { PiChamberControlError, asControlError } from './error.js';
import { OPENCHAMBER_CONTROL_ACTIONS } from './actions.js';

const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
const MAX_WAIT_TIMEOUT_SECONDS = 86_400;
const WAIT_POLL_INTERVAL_MS = 500;
const CONTROL_ACTIONS = new Set(OPENCHAMBER_CONTROL_ACTIONS);

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const positiveInteger = (value, fallback, field) => {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new PiChamberControlError(`${field} must be a positive integer`, 400);
  }
  return number;
};

const normalizeWaitTimeoutMs = (value) => {
  const seconds = value === undefined || value === null ? DEFAULT_WAIT_TIMEOUT_SECONDS : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_TIMEOUT_SECONDS) {
    throw new PiChamberControlError(`timeout must be from 1 to ${MAX_WAIT_TIMEOUT_SECONDS} seconds`, 400);
  }
  return seconds * 1000;
};

const extractTextMessages = (messages, role = 'all') => {
  const result = [];
  for (const record of Array.isArray(messages) ? messages : []) {
    const info = record?.info;
    const messageRole = info?.role;
    if ((messageRole !== 'user' && messageRole !== 'assistant') || (role !== 'all' && role !== messageRole)) continue;
    const text = Array.isArray(record?.parts)
      ? record.parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('').trim()
      : '';
    if (!text) continue;
    const providerID = asNonEmptyString(info.providerID);
    const modelID = asNonEmptyString(info.modelID);
    result.push({
      id: asNonEmptyString(info.id) || '',
      role: messageRole,
      createdAt: Number.isFinite(info?.time?.created) ? info.time.created : null,
      completedAt: Number.isFinite(info?.time?.completed) ? info.time.completed : null,
      model: providerID && modelID ? `${providerID}/${modelID}` : null,
      text,
    });
  }
  return result.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
};

export const createPiChamberControlService = (dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    sessionService,
    createClient = createOpencodeClient,
    sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
    now = Date.now,
  } = dependencies;

  const wait = (duration, signal) => {
    if (!signal) return sleep(duration);
    if (signal.aborted) return Promise.reject(new PiChamberControlError('PiChamber action was cancelled', 499));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new PiChamberControlError('PiChamber action was cancelled', 499));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      sleep(duration).then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  };

  const getClient = async () => {
    if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);
    return createClient({
      baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
      headers: getOpenCodeAuthHeaders(),
    });
  };

  const projects = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []).map((project) => ({
      id: project.id,
      path: path.resolve(project.path),
      label: asNonEmptyString(project.label) || path.basename(project.path) || project.path,
    }));
  };

  const models = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return {
      defaultModel: asNonEmptyString(settings?.defaultModel),
      defaultVariant: asNonEmptyString(settings?.defaultVariant),
      defaultAgent: asNonEmptyString(settings?.defaultAgent),
      favoriteModels: Array.isArray(settings?.favoriteModels) ? settings.favoriteModels : [],
      recentModels: Array.isArray(settings?.recentModels) ? settings.recentModels : [],
    };
  };

  const sessionStatus = async (client, sessionID, directory) => {
    const response = await client.session.status({ directory });
    const statuses = response?.data;
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) {
      throw new PiChamberControlError('Invalid session status response', 500);
    }
    return statuses[sessionID] || { type: 'idle' };
  };

  const sessionMessages = async (client, sessionID, directory, role, limit) => {
    const fetchLimit = limit === undefined ? undefined : Math.max(100, limit * 4);
    let response = await client.session.messages({ sessionID, directory, ...(fetchLimit ? { limit: fetchLimit } : {}) });
    let raw = Array.isArray(response?.data) ? response.data : [];
    let messages = extractTextMessages(raw, role);
    if (limit !== undefined && messages.length < limit && raw.length >= fetchLimit) {
      response = await client.session.messages({ sessionID, directory });
      raw = Array.isArray(response?.data) ? response.data : [];
      messages = extractTextMessages(raw, role);
    }
    return limit === undefined ? messages : messages.slice(-limit);
  };

  const waitForIdle = async ({ client, sessionID, directory, timeoutMs, requireActivity, baselineMessageID, startedAt, signal }) => {
    const deadline = now() + timeoutMs;
    let observedActivity = false;
    while (true) {
      if (signal?.aborted) throw new PiChamberControlError('PiChamber action was cancelled', 499);
      const status = await sessionStatus(client, sessionID, directory);
      if (status.type === 'busy' || status.type === 'retry') {
        observedActivity = true;
      } else if (!requireActivity || observedActivity) {
        return status;
      } else {
        const messages = await sessionMessages(client, sessionID, directory, 'assistant', 1);
        const message = messages[0];
        if (message?.completedAt && (baselineMessageID ? message.id !== baselineMessageID : message.completedAt >= startedAt)) {
          return status;
        }
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new PiChamberControlError(`Session did not become idle within ${Math.ceil(timeoutMs / 1000)} seconds`, 500);
      }
      await wait(Math.min(WAIT_POLL_INTERVAL_MS, remaining), signal);
    }
  };

  // session.send/fork default the directory to the caller's context directory,
  // which is wrong for sessions living in other worktrees: prompt_async then
  // targets an instance that does not hold the session and the run dies with
  // UnknownError. Resolve the target session's directory from the global
  // session list when the caller did not scope explicitly.
  const resolveSessionDirectory = async (sessionID) => {
    try {
      const client = await getClient();
      const response = await client.experimental?.session?.list?.({});
      const sessions = Array.isArray(response?.data) ? response.data : [];
      const session = sessions.find((item) => item?.id === sessionID);
      return asNonEmptyString(session?.directory) || null;
    } catch {
      return null;
    }
  };

  const executeSessionAction = async (action, input, contextDirectory, signal) => {
    if (input.timeout !== undefined && input.wait !== true) throw new PiChamberControlError('timeout requires wait', 400);
    if (input.lastAssistant === true && input.wait !== true) throw new PiChamberControlError('lastAssistant requires wait', 400);
    const sessionID = asNonEmptyString(input.sessionId);
    let directory = asNonEmptyString(input.directory) || (!input.projectId ? asNonEmptyString(contextDirectory) : null);
    if (sessionID && action !== 'session.create' && !asNonEmptyString(input.directory) && !input.projectId) {
      const resolvedSessionDirectory = await resolveSessionDirectory(sessionID);
      if (resolvedSessionDirectory) directory = resolvedSessionDirectory;
    }
    const payload = {
      ...(directory ? { directory } : {}),
      ...(asNonEmptyString(input.projectId) ? { projectId: input.projectId.trim() } : {}),
      ...(asNonEmptyString(input.title) ? { title: input.title.trim() } : {}),
      ...(asNonEmptyString(input.prompt) ? { prompt: input.prompt.trim() } : {}),
      ...(asNonEmptyString(input.model) ? { model: input.model.trim() } : {}),
      ...(asNonEmptyString(input.agent) ? { agent: input.agent.trim() } : {}),
      ...(asNonEmptyString(input.variant) ? { variant: input.variant.trim() } : {}),
      ...(asNonEmptyString(input.worktree) ? { worktree: {
        name: input.worktree.trim(),
        ...(asNonEmptyString(input.branch) ? { branchName: input.branch.trim() } : {}),
        ...(asNonEmptyString(input.startRef) ? { startRef: input.startRef.trim() } : {}),
      } } : {}),
      ...(typeof input.setUpstream === 'boolean' ? { setUpstream: input.setUpstream } : {}),
      ...(asNonEmptyString(input.messageId) ? { messageId: input.messageId.trim() } : {}),
    };
    const startedAt = now();
    let result;
    if (action === 'session.create') {
      result = await sessionService.create(payload);
    } else {
      if (!sessionID) throw new PiChamberControlError('sessionId is required', 400);
      if (action === 'session.send') {
        result = await sessionService.send(sessionID, payload);
      } else {
        result = await sessionService.fork(sessionID, payload);
      }
    }
    if (input.wait !== true) {
      const publicResult = { ...result };
      delete publicResult.baselineAssistantMessageId;
      return publicResult;
    }
    const client = await getClient();
    const status = await waitForIdle({
      client,
      sessionID: result.sessionId,
      directory: result.directory,
      timeoutMs: normalizeWaitTimeoutMs(input.timeout),
      requireActivity: result.promptDispatched === true,
      baselineMessageID: result.baselineAssistantMessageId,
      startedAt,
      signal,
    });
    const publicResult = { ...result, sessionStatus: status };
    delete publicResult.baselineAssistantMessageId;
    if (input.lastAssistant === true) {
      publicResult.lastAssistantMessage = (await sessionMessages(client, result.sessionId, result.directory, 'assistant', 1))[0] || null;
    }
    return publicResult;
  };

  const execute = async (action, input = {}, contextDirectory, options = {}) => {
    try {
      if (!CONTROL_ACTIONS.has(action)) {
        throw new PiChamberControlError(`Unsupported PiChamber action: ${action || 'missing'}`, 400);
      }
      if (action === 'projects.list') return { projects: await projects() };
      if (action === 'models.list') return models();
      if (action === 'session.create' || action === 'session.send' || action === 'session.fork') {
        return executeSessionAction(action, input, contextDirectory, options.signal);
      }
      if (action.startsWith('session.')) {
        const directory = asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory);
        const sessionID = asNonEmptyString(input.sessionId);
        const client = await getClient();
        if (action === 'session.list') {
          const limit = positiveInteger(input.limit, 10, 'limit');
          const response = await client.session.list(directory ? { directory } : {});
          let sessions = Array.isArray(response?.data) ? response.data : [];
          if (input.all !== true) sessions = sessions.filter((session) => !session?.time?.archived);
          sessions = sessions.slice(0, limit);
          if (input.withStatus === true) {
            const cache = new Map();
            sessions = await Promise.all(sessions.map(async (session) => {
              const sessionDirectory = asNonEmptyString(session?.directory);
              if (!sessionDirectory) return { ...session, status: { type: 'unknown' } };
              if (!cache.has(sessionDirectory)) {
                const statusRequest = client.session.status({ directory: sessionDirectory }).catch(() => null);
                cache.set(sessionDirectory, statusRequest);
              }
              const statusResponse = await cache.get(sessionDirectory);
              return { ...session, status: statusResponse?.data?.[session.id] || (statusResponse ? { type: 'idle' } : { type: 'unknown' }) };
            }));
          }
          return { sessions, limit, directory, archived: input.all === true ? 'included' : 'excluded' };
        }
        if (!sessionID) throw new PiChamberControlError('sessionId is required', 400);
        if (!directory) throw new PiChamberControlError('directory is required', 400);
        if (action === 'session.status') {
          return { sessionId: sessionID, directory, sessionStatus: await sessionStatus(client, sessionID, directory) };
        }
        if (action === 'session.messages') {
          if (input.timeout !== undefined && input.wait !== true) throw new PiChamberControlError('timeout requires wait', 400);
          const role = input.lastAssistant === true ? 'assistant' : (asNonEmptyString(input.role) || 'all');
          if (!['all', 'user', 'assistant'].includes(role)) throw new PiChamberControlError('role must be all, user, or assistant', 400);
          const last = input.last === true || input.lastAssistant === true;
          if (input.all === true && (last || input.limit !== undefined)) throw new PiChamberControlError('all cannot be combined with last or limit', 400);
          if (last && input.limit !== undefined) throw new PiChamberControlError('last cannot be combined with limit', 400);
          const currentStatus = input.wait === true
            ? await waitForIdle({ client, sessionID, directory, timeoutMs: normalizeWaitTimeoutMs(input.timeout), requireActivity: false, startedAt: now(), signal: options.signal })
            : await sessionStatus(client, sessionID, directory);
          const limit = input.all === true ? undefined : (last ? 1 : positiveInteger(input.limit, 10, 'limit'));
          return { sessionId: sessionID, directory, role, sessionStatus: currentStatus, messages: await sessionMessages(client, sessionID, directory, role, limit) };
        }
      }
      throw new PiChamberControlError(`Unsupported PiChamber action: ${action || 'missing'}`, 400);
    } catch (error) {
      throw asControlError(error, `Failed to execute ${action || 'PiChamber action'}`);
    }
  };

  return { execute };
};
