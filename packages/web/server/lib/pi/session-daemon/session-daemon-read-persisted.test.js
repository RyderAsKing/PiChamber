import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { hasTrustRequiringProjectResources } from '@earendil-works/pi-coding-agent';

import { createSessionDaemon } from './session-daemon.js';

// `sessions.readPersisted` projects a transcript straight from its JSONL
// file: no Pi runtime, extension, or tool starts, and nothing is written.
// The server uses it to show a sandboxed project's transcripts while its
// sandbox cannot run (#242, "Fail closed").

const credential = 'a-private-daemon-credential';

const endpointFor = (root) => (process.platform === 'win32'
  ? `\\\\.\\pipe\\pichamber-test-${createHash('sha1').update(root).digest('hex').slice(0, 16)}`
  : join(root, 'daemon.sock'));

const connect = (endpoint) => {
  const socket = createConnection({ path: endpoint });
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const messages = [];
  const waiters = [];
  socket.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      messages.push(message);
      for (let at = waiters.length - 1; at >= 0; at -= 1) {
        if (waiters[at].predicate(message)) waiters.splice(at, 1)[0].resolve(message);
      }
    }
  });
  const waitFor = (predicate) => {
    const hit = messages.find(predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => waiters.push({ predicate, resolve }));
  };
  return {
    async authenticate() {
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      socket.write(`${JSON.stringify({ kind: 'authenticate', credential })}\n`);
      await waitFor((message) => message.kind === 'authenticated');
    },
    request(command, payload = {}) {
      const requestId = `request-${messages.length}-${Math.random()}`;
      socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', requestId, command, payload })}\n`);
      // A failed request answers with an `error` frame (no request id) and
      // closes the connection.
      return waitFor((message) => message.kind === 'error' || (message.kind === 'response' && message.requestId === requestId));
    },
    close: () => socket.destroy(),
  };
};

const line = (value) => `${JSON.stringify(value)}\n`;
const at = (minute) => `2026-01-01T00:0${minute}:00.000Z`;

describe('sessions.readPersisted', () => {
  let daemon;
  let client;
  const roots = [];

  afterEach(async () => {
    client?.close();
    await daemon?.stop().catch(() => {});
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  const start = async (daemonOptions = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-read-persisted-'));
    roots.push(root);
    const sessionFile = join(root, 'session.jsonl');
    const content = line({ type: 'session', version: 3, id: 'read-only-session', cwd: root, timestamp: at(0) })
      + line({ type: 'message', id: 'u1', parentId: null, timestamp: at(1), message: { role: 'user', content: 'first question', timestamp: Date.parse(at(1)) } })
      + line({ type: 'message', id: 'a1', parentId: 'u1', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }], provider: 'test', model: 'model-a', timestamp: Date.parse(at(2)) } })
      + line({ type: 'session_info', id: 'i1', parentId: 'a1', timestamp: at(3), name: 'Read me' })
      + line({ type: 'message', id: 'u2', parentId: 'i1', timestamp: at(4), message: { role: 'user', content: 'second question', timestamp: Date.parse(at(4)) } });
    await writeFile(sessionFile, content);
    const createdRuntimes = [];
    daemon = createSessionDaemon({
      endpoint: endpointFor(root),
      credential,
      cwd: root,
      agentDir: root,
      listSessions: async () => [{ path: sessionFile, id: 'read-only-session', cwd: root }],
      createRuntime: async (options) => {
        createdRuntimes.push(options);
        throw new Error('a read must not start a Pi runtime');
      },
      ...daemonOptions,
    });
    await daemon.start();
    client = connect(endpointFor(root));
    await client.authenticate();
    return { root, sessionFile, content, createdRuntimes };
  };

  it('projects the transcript from JSONL without starting a runtime or writing the file', async () => {
    const { root, sessionFile, content, createdRuntimes } = await start();

    const response = await client.request('sessions.readPersisted', { sessionId: 'read-only-session', directory: root });

    expect(response.kind).toBe('response');
    const { result } = response;
    expect(result.readOnly).toBe(true);
    expect(result.session).toMatchObject({ id: 'read-only-session', directory: root, title: 'Read me', messageCount: 3 });
    expect(result.messages.map((item) => item.message.id)).toEqual(['u1', 'a1', 'u2']);
    expect(result.messages[1].parts).toEqual([expect.objectContaining({ type: 'text', text: 'first answer' })]);
    // Read-only and idle: no live claims that belong to a running daemon.
    expect(result).toMatchObject({ isStreaming: false, lifecycle: 'idle', lastSequence: -1 });
    expect(result).not.toHaveProperty('streamEpoch');
    expect(result).not.toHaveProperty('inputState');
    expect(createdRuntimes).toEqual([]);
    await expect(readFile(sessionFile, 'utf8')).resolves.toBe(content);
    await expect(client.request('runtime.health')).resolves.toMatchObject({ result: { residentSessions: 0 } });
  });

  it('pages older messages with the same cursor as sessions.messages', async () => {
    const { root } = await start();

    const latest = await client.request('sessions.readPersisted', { sessionId: 'read-only-session', directory: root, limit: 1 });
    expect(latest.result.messages.map((item) => item.message.id)).toEqual(['u2']);
    expect(latest.result).toMatchObject({ hasMoreBefore: true, beforeCursor: expect.any(String) });

    const older = await client.request('sessions.readPersisted', {
      sessionId: 'read-only-session', directory: root, before: latest.result.beforeCursor, limit: 5,
    });
    expect(older.result.messages.map((item) => item.message.id)).toEqual(['u1', 'a1']);
    expect(older.result.hasMoreBefore).toBe(false);
  });

  it('does not trust the folder it reads from', async () => {
    const trustWrites = [];
    const { root } = await start({
      createTrustStore: () => ({ get: () => null, set: (directory, value) => { trustWrites.push([directory, value]); } }),
    });
    // A project extension is what makes Pi ask for trust.
    await mkdir(join(root, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(root, '.pi', 'extensions', 'demo.ts'), 'export default () => {};\n');
    expect(hasTrustRequiringProjectResources(root)).toBe(true);

    const response = await client.request('sessions.readPersisted', { sessionId: 'read-only-session', directory: root });

    expect(response.kind).toBe('response');
    expect(trustWrites).toEqual([]);
  });

  it('answers INVALID_SESSION for an unknown session', async () => {
    const { root } = await start();

    const response = await client.request('sessions.readPersisted', { sessionId: 'missing-session', directory: root });

    expect(response.kind).toBe('error');
    expect(response.error.code).toBe('INVALID_SESSION');
  });
});
