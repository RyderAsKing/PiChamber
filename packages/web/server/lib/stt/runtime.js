import { WebSocketServer } from 'ws';

import { STT_MAX_BINARY_FRAME_BYTES, STT_WS_PATH, parseRequestPathname, parseSttAudioFrame, parseSttControlFrame } from './protocol.js';
import { createSttService } from './service.js';
import { SttStreamManager } from './stream-manager.js';

const HEARTBEAT_MS = 30_000;

export function createSttRuntime({ app, server, express, uiAuthController, isRequestOriginAllowed, rejectWebSocketUpgrade, modelsDir, configFile }) {
  const service = createSttService({ modelsDir, configFile });
  const manager = new SttStreamManager({ createTranscriber: (providerConfigId) => service.createTranscriber(providerConfigId) });

  app.get('/api/stt/status', async (_req, res) => {
    try { res.json(await service.getStatus()); }
    catch (error) { res.status(500).json({ error: error?.message || 'Failed to read STT status' }); }
  });
  app.put('/api/stt/config', express.json({ limit: '32kb' }), async (req, res) => {
    try { res.json({ config: await service.updateConfig(req.body ?? {}) }); }
    catch (error) { res.status(400).json({ error: error?.message || 'Invalid STT configuration' }); }
  });
  app.post('/api/stt/models/:modelId/download', async (req, res) => {
    try { res.status(202).json(await service.requestModelDownload(req.params.modelId)); }
    catch (error) { res.status(400).json({ error: error?.message || 'Failed to download STT model' }); }
  });
  app.delete('/api/stt/models/:modelId', async (req, res) => {
    try { res.json(await service.deleteModel(req.params.modelId)); }
    catch (error) { res.status(400).json({ error: error?.message || 'Failed to delete STT model' }); }
  });

  let wsServer = new WebSocketServer({ noServer: true, maxPayload: STT_MAX_BINARY_FRAME_BYTES });
  wsServer.on('connection', (socket) => {
    let recordingId = null;
    let starting = false;
    let closed = false;
    const emit = (message) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    };
    emit({ version: 1, type: 'hello' });
    const heartbeat = setInterval(() => { try { socket.ping(); } catch {} }, HEARTBEAT_MS);
    heartbeat.unref?.();

    socket.on('message', (raw, isBinary) => {
      try {
        if (isBinary) {
          if (!recordingId) throw new Error('Start the STT recording before sending audio');
          const frame = parseSttAudioFrame(raw);
          manager.append(recordingId, frame.sequence, frame.pcm16);
          return;
        }
        const message = parseSttControlFrame(raw);
        if (message.type === 'ping') { emit({ version: 1, type: 'pong' }); return; }
        if (message.type === 'start') {
          if (starting) throw new Error('STT recording is already starting');
          if (recordingId && recordingId !== message.recordingId) throw new Error('Only one recording is allowed per connection');
          recordingId = message.recordingId;
          starting = true;
          void manager.start({ recordingId, providerConfigId: message.providerConfigId, emit }).then(() => {
            starting = false;
            if (closed && recordingId) manager.detach(recordingId, emit);
          }).catch((error) => {
            starting = false;
            emit({ version: 1, type: 'error', recordingId, code: error?.code || 'STT_START_FAILED', message: error?.message || 'Failed to start STT' });
            recordingId = null;
          });
          return;
        }
        if (!recordingId || message.recordingId !== recordingId) throw new Error('Invalid STT recording id');
        if (message.type === 'finish') { manager.finish(recordingId, message.finalSequence); return; }
        if (message.type === 'cancel') { manager.cancel(recordingId); recordingId = null; return; }
        throw new Error('Unknown STT control frame');
      } catch (error) {
        emit({ version: 1, type: 'error', recordingId, code: error?.code || 'BAD_FRAME', message: error?.message || 'Invalid STT frame' });
        if (error?.code === 'RECORDING_LIMIT' && recordingId) { manager.cancel(recordingId); recordingId = null; }
      }
    });
    const detach = () => {
      closed = true;
      clearInterval(heartbeat);
      if (recordingId) manager.detach(recordingId, emit);
    };
    socket.once('close', detach);
    socket.on('error', () => {});
  });

  const upgradeHandler = (req, socket, head) => {
    if (parseRequestPathname(req.url) !== STT_WS_PATH) return;
    void (async () => {
      try {
        if (uiAuthController?.enabled) {
          if (!await uiAuthController.ensureSessionToken(req, null)) { rejectWebSocketUpgrade(socket, 401, 'UI authentication required'); return; }
          if (!await isRequestOriginAllowed(req)) { rejectWebSocketUpgrade(socket, 403, 'Invalid origin'); return; }
        }
        if (!wsServer) { rejectWebSocketUpgrade(socket, 503, 'STT WebSocket unavailable'); return; }
        wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
      } catch { rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); }
    })();
  };
  server.on('upgrade', upgradeHandler);

  const shutdown = async () => {
    server.off('upgrade', upgradeHandler);
    manager.shutdown();
    service.shutdown();
    if (!wsServer) return;
    for (const client of wsServer.clients) client.terminate();
    const current = wsServer;
    wsServer = null;
    await Promise.race([new Promise((resolve) => current.close(resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
  };
  return { shutdown };
}
