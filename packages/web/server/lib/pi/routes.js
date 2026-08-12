/**
 * Browser-visible Pi routes deliberately translate the authenticated server
 * boundary to private daemon requests. They never expose local daemon details.
 */

import { createPiArchiveStore } from './archive-store.js';
import { createPiAttachmentStore } from './attachment-store.js';

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
        return { type: 'tool', id: part.id, index: part.index, toolCallId: part.toolCallId, name: part.name, ...(part.input !== undefined ? { input: part.input } : {}), ...(part.output !== undefined ? { output: part.output } : {}), ...(part.isError === true ? { isError: true } : {}), state: ['pending', 'running', 'completed', 'error', 'cancelled'].includes(part.state) ? part.state : 'completed' };
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
    case 'assistant.message.start': return { ...common, payload: { messageId: frame.payload.messageId, role: frame.payload.role, startedAt: frame.payload.startedAt, ...(typeof frame.payload.text === 'string' ? { text: frame.payload.text } : {}), ...(frame.payload.model ? { model: frame.payload.model } : {}) } };
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
    case 'session.tool.end': return { ...common, payload: { toolCallId: frame.payload.toolCallId, partId: frame.payload.partId, messageId: frame.payload.messageId, name: frame.payload.name, state: frame.payload.state, ...(frame.payload.input !== undefined ? { input: frame.payload.input } : {}), ...(frame.payload.output !== undefined ? { output: frame.payload.output } : {}), ...(frame.payload.isError === true ? { isError: true } : {}) } };
    default: return null;
  }
};

const requestSessionOperation = async (req, res, getPiSessionDaemonRuntime, command, payload = {}) => {
  const sessionId = sessionIdFrom(req);
  if (!sessionId) {
    res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
    return undefined;
  }
  try {
    return await getDaemonRuntime(getPiSessionDaemonRuntime).request(command, { ...payload, sessionId });
  } catch (error) {
    writeDaemonError(res, error);
    return undefined;
  }
};

/**
 * Browser-visible Pi runtime and session-collection routes. The authenticated
 * /api middleware is registered by the server composition root before these
 * adapters; this function is mounted before the generic OpenCode proxy.
 */
export const registerPiRuntimeRoutes = (app, {
  getPiSessionDaemonRuntime,
  archiveStore = createPiArchiveStore(),
  attachmentStore = createPiAttachmentStore(),
}) => {
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

  app.get('/api/pi/events', async (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId.length > 0 ? req.query.sessionId : undefined;
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
      close = await runtime.subscribe({ sessionId, fromSequence, onEvent: send, onError: () => res.end() });
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
    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof title !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }

    try {
      await getDaemonRuntime(getPiSessionDaemonRuntime).request('sessions.rename', { sessionId, title });
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
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.cwd !== 'string' || input.cwd.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }

    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('sessions.create', input);
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
