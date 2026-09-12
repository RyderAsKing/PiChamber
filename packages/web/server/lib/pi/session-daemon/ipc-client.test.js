import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requestSessionDaemon, subscribeSessionDaemon } from './ipc-client.js';
import { SESSION_DAEMON_MAX_FRAME_BYTES } from './ipc-protocol.js';

const credential = 'test-private-credential';
const roots = [];
const servers = [];

const endpointFor = (root) => process.platform === 'win32'
  ? `\\\\.\\pipe\\pichamber-ipc-test-${createHash('sha1').update(root).digest('hex').slice(0, 16)}`
  : join(root, 'daemon.sock');

const startServer = async (respond) => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-ipc-client-'));
  roots.push(root);
  const endpoint = endpointFor(root);
  const server = createServer((socket) => {
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n');
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        if (frame.kind === 'authenticate') {
          socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'authenticated' })}\n`);
        } else if (frame.kind === 'request') {
          respond(socket, frame);
        }
      }
    });
  });
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: endpoint }, resolve);
  });
  return endpoint;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('session daemon IPC client framing', () => {
  it('distinguishes malformed JSON from an oversized response frame', async () => {
    const malformedEndpoint = await startServer((socket) => socket.end('{not-json}\n'));
    await expect(requestSessionDaemon({
      endpoint: malformedEndpoint,
      credential,
      command: 'runtime.health',
    })).rejects.toMatchObject({ code: 'MALFORMED_DAEMON_RESPONSE' });

    const oversizedEndpoint = await startServer((socket) => {
      socket.end(`${'A'.repeat(SESSION_DAEMON_MAX_FRAME_BYTES + 1)}\n`);
    });
    await expect(requestSessionDaemon({
      endpoint: oversizedEndpoint,
      credential,
      command: 'runtime.health',
    })).rejects.toMatchObject({ code: 'DAEMON_RESPONSE_TOO_LARGE' });
  }, 20_000);

  it('parses complete frames before bounding the incomplete remainder', async () => {
    const endpoint = await startServer((socket, request) => {
      const response = JSON.stringify({
        protocolVersion: 1,
        kind: 'response',
        requestId: request.requestId,
        result: { ok: true },
      });
      socket.end(`${response}\n${'A'.repeat(SESSION_DAEMON_MAX_FRAME_BYTES)}`);
    });

    await expect(requestSessionDaemon({ endpoint, credential, command: 'runtime.health' }))
      .resolves.toEqual({ ok: true });
  });

  it('stamps the subscribe authenticate frame with the cursor streamEpoch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-ipc-client-'));
    roots.push(root);
    const endpoint = endpointFor(root);
    let seenAuthenticate;
    const peers = new Set();
    const server = createServer((socket) => {
      peers.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => peers.delete(socket));
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n');
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.kind === 'authenticate') {
            seenAuthenticate = frame;
            socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'authenticated' })}\n`);
            socket.write(`${JSON.stringify({
              protocolVersion: 1,
              kind: 'event',
              event: 'session.snapshot',
              sequence: 0,
              streamEpoch: 'epoch-abc123',
            })}\n`);
          }
        }
      });
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: endpoint }, resolve);
    });

    const events = [];
    const close = subscribeSessionDaemon({
      endpoint,
      credential,
      sessionId: 'pi-session-1',
      fromSequence: 7,
      streamEpoch: 'epoch-abc123',
      onEvent: (event) => events.push(event),
      onError: () => {},
    });
    try {
      for (let attempt = 0; attempt < 50 && events.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(seenAuthenticate).toMatchObject({
        credential,
        sessionId: 'pi-session-1',
        fromSequence: 7,
        streamEpoch: 'epoch-abc123',
      });
      expect(events[0]).toMatchObject({ kind: 'event', streamEpoch: 'epoch-abc123' });
    } finally {
      close();
      for (const peer of peers) peer.destroy();
    }
  }, 20_000);
});
