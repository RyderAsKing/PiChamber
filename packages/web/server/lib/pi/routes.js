/**
 * Browser-visible Pi routes deliberately translate the authenticated server
 * boundary to private daemon requests. They never expose local daemon details.
 */

import { createPiArchiveStore } from './archive-store.js';
import { createPiAttachmentStore } from './attachment-store.js';
import { checkForUpdates } from '../package-manager.js';
import { listPiCustomThemes } from './custom-themes.js';
import { createPiSettingsStore } from './settings-store.js';
import { createPiSessionFoldersStore } from './session-folders-store.js';
import { createPiUiSettingsStore } from './ui-settings-store.js';

const UNAVAILABLE_CODES = new Set([
  'DAEMON_UNAVAILABLE',
  'DAEMON_AUTH_FAILED',
  'DAEMON_REQUEST_FAILED',
  'DAEMON_TIMEOUT',
  'DAEMON_PROTOCOL_MISMATCH',
  'DAEMON_ENDPOINT_UNVERIFIED',
  'DAEMON_CREDENTIAL_UNAVAILABLE',
  'MALFORMED_SESSION_JSONL',
  'SESSION_JSONL_UNREADABLE',
  'ARCHIVE_METADATA_INVALID',
]);

const writeDaemonError = (res, error) => {
  const code = typeof error?.code === 'string' ? error.code : 'DAEMON_REQUEST_FAILED';
  const status = UNAVAILABLE_CODES.has(code) ? 503 : code === 'INVALID_SESSION' ? 404 : 400;
  res.status(status).json({ error: { code } });
};

const getDaemonRuntime = (getPiSessionDaemonRuntime) => {
  const runtime = getPiSessionDaemonRuntime();
  if (!runtime) {
    const error = new Error('The Pi session daemon is unavailable.');
    error.code = 'DAEMON_UNAVAILABLE';
    throw error;
  }
  return runtime;
};

const protocolMismatch = () => {
  const error = new Error('The Pi session daemon returned an invalid response.');
  error.code = 'DAEMON_PROTOCOL_MISMATCH';
  return error;
};

const projectSession = (value) => {
  if (!value || typeof value !== 'object'
    || typeof value.id !== 'string' || value.id.length === 0
    || typeof value.directory !== 'string' || value.directory.length === 0
    || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) {
    throw protocolMismatch();
  }
  return {
    id: value.id,
    directory: value.directory,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.parentId === 'string' || value.parentId === null ? { parentId: value.parentId } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(Number.isSafeInteger(value.messageCount) && value.messageCount >= 0 ? { messageCount: value.messageCount } : {}),
    ...(value.model && typeof value.model.providerId === 'string' && typeof value.model.modelId === 'string' ? { model: { providerId: value.model.providerId, modelId: value.model.modelId } } : {}),
    ...(typeof value.thinking === 'string' ? { thinking: value.thinking } : {}),
    ...(value.archived === true ? { archived: true } : {}),
    ...(Number.isFinite(value.timeArchived) ? { timeArchived: value.timeArchived } : {}),
  };
};

const projectSessionList = (sessions) => {
  if (!Array.isArray(sessions)) throw protocolMismatch();
  return sessions.map((item) => {
    if (!item || typeof item !== 'object' || !Number.isFinite(item.updatedAt)) throw protocolMismatch();
    return {
      session: projectSession(item.session),
      ...(typeof item.preview === 'string' ? { preview: item.preview } : {}),
      updatedAt: item.updatedAt,
    };
  });
};

const projectSessionDetail = (value) => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.messages) || !Number.isSafeInteger(value.lastSequence)) throw protocolMismatch();
  const messages = value.messages.map((item) => {
    if (!item || typeof item !== 'object' || !item.message || !Array.isArray(item.parts)) throw protocolMismatch();
    const message = item.message;
    if (typeof message.id !== 'string' || typeof message.sessionId !== 'string' || typeof message.directory !== 'string'
      || !Number.isFinite(message.createdAt) || (message.role !== 'user' && message.role !== 'assistant')) throw protocolMismatch();
    const projected = {
      id: message.id, sessionId: message.sessionId, directory: message.directory, role: message.role, createdAt: message.createdAt,
      ...(typeof message.parentId === 'string' ? { parentId: message.parentId } : {}),
      ...(typeof message.text === 'string' ? { text: message.text } : {}),
      ...(message.role === 'assistant' && typeof message.thinking === 'string' ? { thinking: message.thinking } : {}),
      ...(message.model && typeof message.model.providerId === 'string' && typeof message.model.modelId === 'string' ? { model: { providerId: message.model.providerId, modelId: message.model.modelId } } : {}),
      ...(message.error && typeof message.error.code === 'string' ? { error: { code: message.error.code } } : {}),
    };
    const parts = item.parts.map((part) => {
      if (!part || typeof part !== 'object' || typeof part.type !== 'string' || typeof part.id !== 'string' || !Number.isSafeInteger(part.index)) throw protocolMismatch();
      if (part.type === 'text' || part.type === 'thinking') {
        if (typeof part.text !== 'string') throw protocolMismatch();
        return { type: part.type, id: part.id, index: part.index, text: part.text };
      }
      if (part.type === 'tool' && typeof part.toolCallId === 'string' && typeof part.name === 'string') {
        return {
          type: 'tool', id: part.id, index: part.index, toolCallId: part.toolCallId, name: part.name,
          ...(part.input !== undefined ? { input: part.input } : {}),
          ...(part.output !== undefined ? { output: part.output } : {}),
          ...(typeof part.error === 'string' ? { error: part.error } : {}),
          ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
          ...(part.isError === true ? { isError: true } : {}),
          ...(Number.isFinite(part.startedAt) ? { startedAt: part.startedAt } : {}),
          ...(Number.isFinite(part.endedAt) ? { endedAt: part.endedAt } : {}),
          state: ['pending', 'running', 'completed', 'error', 'cancelled'].includes(part.state) ? part.state : 'completed',
        };
      }
      throw protocolMismatch();
    });
    return { message: projected, parts };
  });
  return { session: projectSession(value.session), messages, lastSequence: value.lastSequence };
};

const projectProviders = (value) => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.providers)) throw protocolMismatch();
  return {
    providers: value.providers.map((provider) => {
      if (!provider || typeof provider !== 'object' || typeof provider.id !== 'string'
        || typeof provider.label !== 'string' || typeof provider.authenticated !== 'boolean' || !Array.isArray(provider.models)) throw protocolMismatch();
      return {
        id: provider.id,
        label: provider.label,
        authenticated: provider.authenticated,
        models: provider.models.map((model) => {
          if (!model || typeof model !== 'object' || typeof model.id !== 'string' || typeof model.providerId !== 'string') throw protocolMismatch();
          return {
            id: model.id,
            providerId: model.providerId,
            ...(typeof model.label === 'string' ? { label: model.label } : {}),
            ...(Number.isSafeInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
            ...(model.supportsThinking === true ? { supportsThinking: true } : {}),
            ...(Array.isArray(model.thinkingLevels) ? { thinkingLevels: model.thinkingLevels.filter((level) => ['off', 'low', 'medium', 'high', 'xhigh'].includes(level)) } : {}),
          };
        }),
      };
    }),
  };
};

const projectProviderConfig = (value) => {
  const config = value?.config;
  if (config === null) return { config: null };
  if (!config || typeof config !== 'object' || typeof config.providerId !== 'string' || typeof config.label !== 'string'
    || typeof config.baseUrl !== 'string' || typeof config.api !== 'string' || !Array.isArray(config.models)) throw protocolMismatch();
  return {
    config: {
      providerId: config.providerId,
      label: config.label,
      baseUrl: config.baseUrl,
      api: config.api,
      models: config.models.map((model) => {
        if (!model || typeof model !== 'object' || typeof model.id !== 'string' || typeof model.providerId !== 'string') throw protocolMismatch();
        return {
          id: model.id,
          providerId: model.providerId,
          ...(typeof model.label === 'string' ? { label: model.label } : {}),
          ...(Number.isSafeInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
          ...(model.supportsThinking === true ? { supportsThinking: true } : {}),
        };
      }),
    },
  };
};

const projectProviderStatus = (value) => {
  if (!value || typeof value !== 'object' || typeof value.providerId !== 'string' || typeof value.authenticated !== 'boolean') throw protocolMismatch();
  return { providerId: value.providerId, authenticated: value.authenticated };
};

const projectProviderLogin = (value) => {
  const login = value?.login;
  if (!login || typeof login !== 'object' || typeof login.id !== 'string' || typeof login.providerId !== 'string'
    || !['pending', 'complete', 'failed'].includes(login.state)) throw protocolMismatch();
  const projected = { id: login.id, providerId: login.providerId, state: login.state };
  if (login.prompt && typeof login.prompt === 'object' && ['text', 'secret', 'select', 'manual_code'].includes(login.prompt.type)) {
    projected.prompt = {
      type: login.prompt.type,
      ...(typeof login.prompt.message === 'string' ? { message: login.prompt.message } : {}),
      ...(typeof login.prompt.placeholder === 'string' ? { placeholder: login.prompt.placeholder } : {}),
      ...(Array.isArray(login.prompt.options) ? { options: login.prompt.options
        .filter((option) => option && typeof option.id === 'string' && typeof option.label === 'string')
        .map((option) => ({ id: option.id, label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) })) } : {}),
    };
  }
  if (login.authUrl && typeof login.authUrl.url === 'string' && login.authUrl.url.length <= 8_192) {
    projected.authUrl = { url: login.authUrl.url, ...(typeof login.authUrl.instructions === 'string' ? { instructions: login.authUrl.instructions } : {}) };
  }
  if (login.deviceCode && typeof login.deviceCode.userCode === 'string' && typeof login.deviceCode.verificationUri === 'string') {
    projected.deviceCode = {
      userCode: login.deviceCode.userCode,
      verificationUri: login.deviceCode.verificationUri,
      ...(Number.isFinite(login.deviceCode.intervalSeconds) ? { intervalSeconds: login.deviceCode.intervalSeconds } : {}),
      ...(Number.isFinite(login.deviceCode.expiresInSeconds) ? { expiresInSeconds: login.deviceCode.expiresInSeconds } : {}),
    };
  }
  if (login.error && typeof login.error.code === 'string') projected.error = { code: login.error.code };
  return { login: projected };
};

const projectPiSettings = (value) => {
  if (!value || typeof value !== 'object' || !value.global || !value.project) throw protocolMismatch();
  const project = value.project;
  if (typeof project.trusted !== 'boolean') throw protocolMismatch();
  const copy = (settings) => ({
    ...(typeof settings.defaultProvider === 'string' ? { defaultProvider: settings.defaultProvider } : {}),
    ...(typeof settings.defaultModel === 'string' ? { defaultModel: settings.defaultModel } : {}),
    ...(typeof settings.defaultThinking === 'string' ? { defaultThinking: settings.defaultThinking } : {}),
    ...(typeof settings.defaultProjectTrust === 'string' ? { defaultProjectTrust: settings.defaultProjectTrust } : {}),
  });
  return { pi: { global: copy(value.global), project: { trusted: project.trusted, ...(project.denied === true ? { denied: true } : {}), ...(project.requiresTrust === true ? { requiresTrust: true } : {}), ...copy(project) } } };
};

const projectResources = (value) => {
  if (!value || typeof value !== 'object') throw protocolMismatch();
  const project = (resources, kind) => {
    if (!Array.isArray(resources)) throw protocolMismatch();
    return resources.map((resource) => {
      if (!resource || typeof resource !== 'object' || resource.kind !== kind || typeof resource.id !== 'string' || resource.id.length === 0
        || typeof resource.name !== 'string' || !['global', 'project', 'package', 'path'].includes(resource.location)) throw protocolMismatch();
      return {
        id: resource.id,
        kind,
        name: resource.name,
        location: resource.location,
        ...(typeof resource.description === 'string' ? { description: resource.description } : {}),
        ...(typeof resource.content === 'string' ? { content: resource.content } : {}),
        ...(resource.editable === true ? { editable: true } : {}),
      };
    });
  };
  return { skills: project(value.skills, 'skill'), prompts: project(value.prompts, 'prompt'), agents: project(value.agents, 'agents') };
};

const projectSessionTree = (value) => {
  if (!value || typeof value !== 'object' || typeof value.rootId !== 'string' || !Array.isArray(value.nodes)) throw protocolMismatch();
  const projectNode = (node) => {
    if (!node || typeof node !== 'object' || typeof node.entryId !== 'string'
      || (node.parentId !== undefined && node.parentId !== null && typeof node.parentId !== 'string')
      || !Number.isFinite(node.updatedAt) || !Array.isArray(node.children)) throw protocolMismatch();
    return {
      entryId: node.entryId,
      ...(typeof node.parentId === 'string' ? { parentId: node.parentId } : {}),
      ...(typeof node.title === 'string' ? { title: node.title } : {}),
      updatedAt: node.updatedAt,
      children: node.children.map(projectNode),
    };
  };
  return { rootId: value.rootId, nodes: value.nodes.map(projectNode) };
};

const sessionIdFrom = (req) => typeof req.params.sessionId === 'string' && req.params.sessionId.length > 0 ? req.params.sessionId : undefined;

const projectEventFrame = (frame) => {
  if (!frame || frame.kind !== 'event' || typeof frame.event !== 'string' || !Number.isSafeInteger(frame.sequence)
    || !frame.payload || typeof frame.payload.sessionId !== 'string' || typeof frame.payload.directory !== 'string') return null;
  const { sessionId, directory } = frame.payload;
  const common = { protocolVersion: 1, kind: 'event', name: frame.event, sequence: frame.sequence, sessionId, directory };
  switch (frame.event) {
    case 'session.snapshot': {
      const snapshot = frame.payload;
      return { ...common, payload: { snapshot: {
        sessionId, directory, isStreaming: snapshot.isStreaming === true,
        lifecycle: ['idle', 'busy', 'retry', 'error', 'interrupted'].includes(snapshot.lifecycle) ? snapshot.lifecycle : 'idle',
        queue: { steering: Number.isSafeInteger(snapshot.queue?.steering) ? snapshot.queue.steering : 0, followUp: Number.isSafeInteger(snapshot.queue?.followUp) ? snapshot.queue.followUp : 0 },
        ...(snapshot.model && typeof snapshot.model.providerId === 'string' && typeof snapshot.model.modelId === 'string' ? { model: { providerId: snapshot.model.providerId, modelId: snapshot.model.modelId } } : {}),
        ...(typeof snapshot.thinking === 'string' ? { thinking: snapshot.thinking } : {}),
        ...(typeof snapshot.lastText === 'string' ? { lastText: snapshot.lastText } : {}),
        ...(typeof snapshot.lastThinking === 'string' ? { lastThinking: snapshot.lastThinking } : {}),
        lastSequence: Number.isSafeInteger(snapshot.lastSequence) ? snapshot.lastSequence : frame.sequence,
      } } };
    }
    case 'session.lifecycle': return { ...common, payload: { state: frame.payload.state } };
    case 'assistant.message.start': return { ...common, payload: { messageId: frame.payload.messageId, role: frame.payload.role, startedAt: frame.payload.startedAt, ...(typeof frame.payload.parentId === 'string' ? { parentId: frame.payload.parentId } : {}), ...(typeof frame.payload.text === 'string' ? { text: frame.payload.text } : {}), ...(frame.payload.model ? { model: frame.payload.model } : {}) } };
    case 'assistant.message.delta':
    case 'assistant.thinking.delta': return { ...common, payload: { messageId: frame.payload.messageId, contentIndex: frame.payload.contentIndex, delta: frame.payload.delta, ...(typeof frame.payload.partId === 'string' ? { partId: frame.payload.partId } : {}) } };
    case 'assistant.message.end': return { ...common, payload: { messageId: frame.payload.messageId, ...(typeof frame.payload.text === 'string' ? { text: frame.payload.text } : {}), ...(typeof frame.payload.thinking === 'string' ? { thinking: frame.payload.thinking } : {}) } };
    case 'session.queue': return { ...common, payload: { steering: frame.payload.steering, followUp: frame.payload.followUp } };
    case 'session.model': return { ...common, payload: { model: frame.payload.model } };
    case 'session.thinking': return { ...common, payload: { thinking: frame.payload.thinking } };
    case 'session.compaction': return { ...common, payload: { running: frame.payload.running === true } };
    case 'session.error': return { ...common, payload: { code: frame.payload.code } };
    case 'session.interrupted': return { ...common, payload: { reason: frame.payload.reason, streaming: frame.payload.streaming === true } };
    case 'session.tool.start':
    case 'session.tool.update':
    case 'session.tool.end': return {
      ...common,
      payload: {
        toolCallId: frame.payload.toolCallId, partId: frame.payload.partId, messageId: frame.payload.messageId, name: frame.payload.name, state: frame.payload.state,
        ...(frame.payload.input !== undefined ? { input: frame.payload.input } : {}),
        ...(frame.payload.output !== undefined ? { output: frame.payload.output } : {}),
        ...(typeof frame.payload.error === 'string' ? { error: frame.payload.error } : {}),
        ...(frame.payload.metadata !== undefined ? { metadata: frame.payload.metadata } : {}),
        ...(frame.payload.isError === true ? { isError: true } : {}),
        ...(Number.isFinite(frame.payload.startedAt) ? { startedAt: frame.payload.startedAt } : {}),
        ...(Number.isFinite(frame.payload.endedAt) ? { endedAt: frame.payload.endedAt } : {}),
      },
    };
    default: return null;
  }
};

const requestSessionOperation = async (req, res, getPiSessionDaemonRuntime, command, payload = {}) => {
  const sessionId = sessionIdFrom(req);
  if (!sessionId) {
    res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
    return undefined;
  }
  const directory = typeof req.query?.directory === 'string' && req.query.directory.length > 0
    ? req.query.directory
    : (typeof req.body?.directory === 'string' && req.body.directory.length > 0
      ? req.body.directory
      : (typeof req.body?.cwd === 'string' && req.body.cwd.length > 0 ? req.body.cwd : undefined));
  try {
    return await getDaemonRuntime(getPiSessionDaemonRuntime).request(command, {
      ...payload,
      sessionId,
      ...(directory ? { directory } : {}),
    });
  } catch (error) {
    writeDaemonError(res, error);
    return undefined;
  }
};

/**
 * Browser-visible Pi runtime and session-collection routes. The authenticated
 * /api middleware is registered by the server composition root before these
 * adapters.
 */
export const registerPiRuntimeRoutes = (app, {
  getPiSessionDaemonRuntime,
  archiveStore = createPiArchiveStore(),
  attachmentStore = createPiAttachmentStore(),
  settingsStore = createPiSettingsStore(),
  sessionFoldersStore = createPiSessionFoldersStore(),
  uiSettingsStore = createPiUiSettingsStore(),
  listCustomThemes = listPiCustomThemes,
  updateChecker = checkForUpdates,
}) => {
  app.get('/api/pi/ui-settings', async (_req, res) => {
    try {
      res.json(await uiSettingsStore.read());
    } catch {
      res.status(500).json({ error: 'UI settings are unreadable' });
    }
  });

  app.put('/api/pi/ui-settings', async (req, res) => {
    try {
      res.json(await uiSettingsStore.write(req.body));
    } catch {
      res.status(400).json({ error: 'Invalid UI settings' });
    }
  });

  app.get('/api/pi/session-folders', async (_req, res) => {
    try {
      res.json(await sessionFoldersStore.read());
    } catch {
      res.status(500).json({ error: 'Session folders are unreadable' });
    }
  });

  app.put('/api/pi/session-folders', async (req, res) => {
    try {
      res.json(await sessionFoldersStore.write(req.body));
    } catch {
      res.status(400).json({ error: 'Invalid session folders' });
    }
  });

  app.get('/api/pi/themes', async (_req, res) => {
    try {
      res.json({ themes: await listCustomThemes() });
    } catch {
      res.status(500).json({ error: 'Custom themes are unavailable' });
    }
  });

  app.get('/api/pi/update-check', async (req, res) => {
    try {
      res.json(await updateChecker({
        currentVersion: typeof req.query.currentVersion === 'string' ? req.query.currentVersion : undefined,
        appType: typeof req.query.appType === 'string' ? req.query.appType : undefined,
        platform: typeof req.query.platform === 'string' ? req.query.platform : undefined,
        reportUsage: req.query.reportUsage === 'true',
      }));
    } catch {
      res.status(503).json({ error: 'Update check unavailable' });
    }
  });

  app.get('/api/pi/runtime', async (_req, res) => {
    const runtime = getPiSessionDaemonRuntime();
    if (!runtime) {
      res.status(503).json({
        protocolVersion: 1,
        state: 'unavailable',
        error: { code: 'DAEMON_UNAVAILABLE' },
      });
      return;
    }

    try {
      const health = await runtime.health();
      if (health.state !== 'ready') {
        res.status(503).json({
          protocolVersion: health.protocolVersion,
          state: 'unavailable',
          error: { code: health.error?.code ?? 'DAEMON_UNAVAILABLE' },
        });
        return;
      }
      res.json({
        protocolVersion: health.protocolVersion,
        state: 'ready',
        capabilities: Array.isArray(health.capabilities) ? health.capabilities : [],
      });
    } catch {
      res.status(503).json({ protocolVersion: 1, state: 'unavailable', error: { code: 'DAEMON_UNAVAILABLE' } });
    }
  });

  app.get('/api/pi/projects', async (_req, res) => {
    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('projects.list');
      if (!Array.isArray(result?.projects) || result.projects.some((project) => !project || typeof project.directory !== 'string' || typeof project.selected !== 'boolean')) throw protocolMismatch();
      res.json({ projects: result.projects.map((project) => ({ directory: project.directory, selected: project.selected })) });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/projects/select', async (req, res) => {
    const directory = req.body?.directory;
    if (typeof directory !== 'string' || directory.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('projects.select', { directory });
      if (typeof result?.directory !== 'string') throw protocolMismatch();
      res.json({ directory: result.directory });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/providers', async (_req, res) => {
    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('providers.list');
      res.json(projectProviders(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/providers/:providerId/config', async (req, res) => {
    const providerId = req.params.providerId;
    if (typeof providerId !== 'string' || providerId.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('providers.config.get', { providerId });
      res.json(projectProviderConfig(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.put('/api/pi/providers/:providerId/models', async (req, res) => {
    const providerId = req.params.providerId;
    const payload = req.body;
    if (typeof providerId !== 'string' || providerId.length === 0 || !payload || typeof payload !== 'object') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('providers.models.set', { ...payload, providerId });
      res.json(projectProviderConfig(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/providers/:providerId/status', async (req, res) => {
    const providerId = req.params.providerId;
    if (typeof providerId !== 'string' || providerId.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('providers.status', { providerId });
      res.json(projectProviderStatus(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/providers/:providerId/login', async (req, res) => {
    const providerId = req.params.providerId;
    const type = req.body?.type;
    const apiKey = req.body?.apiKey;
    if (typeof providerId !== 'string' || providerId.length === 0 || !['api_key', 'oauth'].includes(type)
      || (apiKey !== undefined && typeof apiKey !== 'string')) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('providers.login', {
        providerId, type, ...(typeof apiKey === 'string' ? { apiKey } : {}),
      });
      res.status(202).json(projectProviderLogin(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/providers/:providerId/login/:loginId', async (req, res) => {
    const providerId = req.params.providerId;
    const loginId = req.params.loginId;
    if (typeof providerId !== 'string' || typeof loginId !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('providers.login.status', { providerId, loginId });
      res.json(projectProviderLogin(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/providers/:providerId/login/:loginId/respond', async (req, res) => {
    const providerId = req.params.providerId;
    const loginId = req.params.loginId;
    const value = req.body?.value;
    if (typeof providerId !== 'string' || typeof loginId !== 'string' || typeof value !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('providers.login.respond', { providerId, loginId, value });
      res.json(projectProviderLogin(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/providers/:providerId/logout', async (req, res) => {
    const providerId = req.params.providerId;
    if (typeof providerId !== 'string' || providerId.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('providers.logout', { providerId });
      res.json(projectProviderStatus(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/settings', async (_req, res) => {
    try {
      const pi = projectPiSettings(await getDaemonRuntime(getPiSessionDaemonRuntime).request('settings.get'));
      const pichamber = await settingsStore.read();
      res.json({ ...pi, pichamber });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.put('/api/pi/settings/pi', async (req, res) => {
    const payload = req.body;
    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('settings.set', payload);
      res.json(projectPiSettings(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.put('/api/pi/settings/defaults', async (req, res) => {
    try {
      const pichamber = await settingsStore.update(req.body ?? {});
      res.json({ pichamber });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/resources', async (_req, res) => {
    try {
      res.json(projectResources(await getDaemonRuntime(getPiSessionDaemonRuntime).request('resources.list')));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.put('/api/pi/resources/:resourceId', async (req, res) => {
    const resourceId = req.params.resourceId;
    const content = req.body?.content;
    if (typeof resourceId !== 'string' || resourceId.length === 0 || typeof content !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      res.json(projectResources(await getDaemonRuntime(getPiSessionDaemonRuntime).request('resources.update', { resourceId, content })));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/resources/prompts', async (req, res) => {
    const { name, description, content, location } = req.body ?? {};
    if (typeof name !== 'string' || typeof description !== 'string' || typeof content !== 'string' || !['global', 'project'].includes(location)) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      res.status(201).json(projectResources(await getDaemonRuntime(getPiSessionDaemonRuntime).request('resources.prompts.create', { name, description, content, location })));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.delete('/api/pi/resources/prompts/:resourceId', async (req, res) => {
    const resourceId = req.params.resourceId;
    if (typeof resourceId !== 'string' || resourceId.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      res.json(projectResources(await getDaemonRuntime(getPiSessionDaemonRuntime).request('resources.prompts.delete', { resourceId })));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/events', async (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId.length > 0 ? req.query.sessionId : undefined;
    const directory = typeof req.query.directory === 'string' && req.query.directory.length > 0 ? req.query.directory : undefined;
    const rawCursor = req.query.fromSequence;
    const fromSequence = rawCursor === undefined ? undefined : Number(rawCursor);
    if (rawCursor !== undefined && (!Number.isSafeInteger(fromSequence) || fromSequence < 0)) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    let close;
    try {
      const runtime = getDaemonRuntime(getPiSessionDaemonRuntime);
      if (typeof runtime.subscribe !== 'function') throw protocolMismatch();
      res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.flushHeaders?.();
      const send = (frame) => {
        const event = projectEventFrame(frame);
        if (event) res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      close = await runtime.subscribe({ sessionId, directory, fromSequence, onEvent: send, onError: () => res.end() });
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
      const cleanup = () => {
        clearInterval(heartbeat);
        close?.();
      };
      req.once('close', cleanup);
      res.once('close', cleanup);
    } catch (error) {
      if (!res.headersSent) writeDaemonError(res, error);
      else res.end();
      close?.();
    }
  });

  app.get('/api/pi/sessions', async (req, res) => {
    const directory = req.query.directory;
    if (directory !== undefined && (typeof directory !== 'string' || directory.length === 0)) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }

    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('sessions.list', {
        ...(typeof directory === 'string' ? { directory } : {}),
      });
      const archived = await archiveStore.read();
      res.json({
        sessions: projectSessionList(result?.sessions).map((item) => archived[item.session.id]
          ? { ...item, session: { ...item.session, archived: true, timeArchived: archived[item.session.id] } }
          : item),
      });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.patch('/api/pi/sessions/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const title = req.body?.title;
    const directory = typeof req.body?.directory === 'string' && req.body.directory.length > 0
      ? req.body.directory
      : (typeof req.query?.directory === 'string' && req.query.directory.length > 0 ? req.query.directory : undefined);
    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof title !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }

    try {
      await getDaemonRuntime(getPiSessionDaemonRuntime).request('sessions.rename', {
        sessionId,
        title,
        ...(directory ? { directory } : {}),
      });
      res.status(204).end();
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  const sendSessionDetail = async (req, res) => {
    const result = await requestSessionOperation(req, res, getPiSessionDaemonRuntime, 'sessions.open');
    if (result === undefined) return;
    try {
      const detail = projectSessionDetail(result);
      const archived = await archiveStore.read();
      res.json(archived[detail.session.id]
        ? { ...detail, session: { ...detail.session, archived: true, timeArchived: archived[detail.session.id] } }
        : detail);
    } catch (error) {
      writeDaemonError(res, error);
    }
  };

  app.get('/api/pi/sessions/:sessionId', sendSessionDetail);
  app.get('/api/pi/sessions/:sessionId/snapshot', sendSessionDetail);

  app.delete('/api/pi/sessions/:sessionId', async (req, res) => {
    const result = await requestSessionOperation(req, res, getPiSessionDaemonRuntime, 'sessions.delete');
    if (result !== undefined) res.status(204).end();
  });

  app.post('/api/pi/sessions/:sessionId/archive', async (req, res) => {
    const archived = req.body?.archived;
    const sessionId = sessionIdFrom(req);
    if (!sessionId || typeof archived !== 'boolean') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      // Confirm membership without selecting/replacing the daemon's active
      // runtime: archive is PiChamber metadata, not a Pi session mutation.
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('sessions.list');
      const items = projectSessionList(result?.sessions);
      if (!items.some((item) => item.session.id === sessionId)) {
        const error = new Error('The Pi session does not exist.');
        error.code = 'INVALID_SESSION';
        throw error;
      }
      await archiveStore.set(sessionId, archived);
      res.status(204).end();
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/sessions/:sessionId/tree', async (req, res) => {
    const result = await requestSessionOperation(req, res, getPiSessionDaemonRuntime, 'sessions.tree');
    if (result !== undefined) res.json(projectSessionTree(result));
  });

  app.post('/api/pi/sessions/:sessionId/navigate', async (req, res) => {
    const result = await requestSessionOperation(req, res, getPiSessionDaemonRuntime, 'sessions.navigate', { messageId: req.body?.messageId });
    if (result !== undefined) res.json(projectSessionDetail(result));
  });

  for (const [suffix, command] of [['fork', 'sessions.fork'], ['clone', 'sessions.clone']]) {
    app.post(`/api/pi/sessions/:sessionId/${suffix}`, async (req, res) => {
      const result = await requestSessionOperation(req, res, getPiSessionDaemonRuntime, command, req.body && typeof req.body === 'object' ? req.body : {});
      if (result !== undefined) res.status(201).json(projectSessionDetail(result));
    });
  }

  for (const [suffix, command] of [['prompt', 'sessions.prompt'], ['steer', 'sessions.steer'], ['follow-up', 'sessions.followUp']]) {
    app.post(`/api/pi/sessions/:sessionId/${suffix}`, async (req, res) => {
      let payload = req.body && typeof req.body === 'object' ? req.body : {};
      try {
        if (payload.attachments !== undefined) {
          if (!Array.isArray(payload.attachments) || payload.attachments.some((attachment) => !attachment || typeof attachment.id !== 'string')) throw protocolMismatch();
          const attachments = await attachmentStore.resolve(payload.attachments.map((attachment) => attachment.id));
          payload = { ...payload, attachments };
        }
      } catch (error) {
        writeDaemonError(res, error);
        return;
      }
      const result = await requestSessionOperation(req, res, getPiSessionDaemonRuntime, command, payload);
      if (result !== undefined) {
        if (!result || result.accepted !== true || typeof result.messageId !== 'string') {
          writeDaemonError(res, protocolMismatch());
          return;
        }
        res.status(202).json({ accepted: true, messageId: result.messageId });
      }
    });
  }

  for (const [suffix, command] of [['abort', 'sessions.abort'], ['model', 'sessions.setModel'], ['thinking', 'sessions.setThinking'], ['compact', 'sessions.compact']]) {
    app.post(`/api/pi/sessions/:sessionId/${suffix}`, async (req, res) => {
      const result = await requestSessionOperation(req, res, getPiSessionDaemonRuntime, command, req.body && typeof req.body === 'object' ? req.body : {});
      if (result !== undefined) res.status(204).end();
    });
  }

  app.post('/api/pi/attachments', async (req, res) => {
    try {
      const attachment = await attachmentStore.create(req.body ?? {});
      if (!attachment || typeof attachment.id !== 'string' || typeof attachment.name !== 'string'
        || typeof attachment.mime !== 'string' || !Number.isSafeInteger(attachment.size)) throw protocolMismatch();
      res.status(201).json({ attachment: { id: attachment.id, name: attachment.name, mime: attachment.mime, size: attachment.size } });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/sessions', async (req, res) => {
    const input = req.body;
    const cwd = typeof input?.cwd === 'string' && input.cwd.length > 0
      ? input.cwd
      : (typeof input?.directory === 'string' && input.directory.length > 0 ? input.directory : undefined);
    if (!input || typeof input !== 'object' || Array.isArray(input) || !cwd) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }

    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('sessions.create', { ...input, cwd });
      if (!result || typeof result !== 'object' || !Array.isArray(result.messages) || result.messages.length !== 0 || !Number.isSafeInteger(result.lastSequence)) {
        throw protocolMismatch();
      }
      res.status(201).json({
        session: projectSession(result.session),
        messages: [],
        lastSequence: result.lastSequence,
      });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  return { dispose: () => attachmentStore.dispose?.() };
};
