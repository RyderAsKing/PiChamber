import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionDaemon } from './session-daemon.js';

// End-to-end validation against the pinned Pi SDK (issue #252). Pi assigns a
// fresh session a JSONL path but writes the file only with the first message.
// Saving a provider recreates the runtime, which must not try to reopen that
// never-written file and leave every later provider read failing.
const credential = 'a-private-daemon-credential';

function testDaemonEndpoint(root) {
  if (process.platform === 'win32') {
    const pipeHash = createHash('sha1').update(root).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\pichamber-test-${pipeHash}`;
  }
  return join(root, 'daemon.sock');
}

function connectClient(endpoint) {
  const socket = createConnection({ path: endpoint });
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const messages = [];
  const waiters = [];

  const publish = (message) => {
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.predicate(message)) {
        waiters.splice(index, 1);
        waiter.resolve(message);
      }
    }
  };

  socket.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line) publish(JSON.parse(line));
    }
  });

  const next = (predicate) => new Promise((resolve, reject) => {
    const existing = messages.find(predicate);
    if (existing) {
      resolve(existing);
      return;
    }
    const timer = setTimeout(() => {
      const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
      if (index !== -1) waiters.splice(index, 1);
      reject(new Error('Timed out waiting for daemon message'));
    }, 30_000);
    waiters.push({
      predicate,
      reject,
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    });
  });

  return {
    async authenticate() {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({ kind: 'authenticate', credential })}\n`);
      await next((message) => message.kind === 'authenticated');
    },
    async request(command, payload = {}) {
      const requestId = `request-${Math.random()}`;
      socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', requestId, command, payload })}\n`);
      // A failed request answers with an error frame that carries no
      // requestId and closes the connection.
      const response = await next((message) => message.requestId === requestId || message.kind === 'error');
      if (response.kind !== 'response') {
        throw Object.assign(new Error(`Daemon request failed: ${response.error?.code}`), { code: response.error?.code });
      }
      return response.result;
    },
    close() {
      socket.end();
    },
  };
}

describe('Pi session daemon provider changes with the real SDK', () => {
  let daemon;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
  });

  it('keeps listing providers after a provider is saved before any message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-provider-fresh-sdk-'));
    const projectDir = join(root, 'project');
    await mkdir(projectDir);
    // No agent directory: a fresh install.
    const agentDir = join(root, 'agent');

    const endpoint = testDaemonEndpoint(root);
    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();

    const before = await client.request('providers.list');
    expect(before.providers.length).toBeGreaterThan(0);

    const saved = await client.request('providers.models.set', {
      providerId: 'example-gateway',
      label: 'Example gateway',
      baseUrl: 'https://gateway.example.test/v1',
      api: 'openai-completions',
      models: [{ id: 'example-model' }],
    });
    expect(saved).toEqual({ config: expect.objectContaining({ providerId: 'example-gateway' }) });

    const after = await client.request('providers.list');
    expect(after.providers.map((provider) => provider.id)).toContain('example-gateway');

    // Nothing was sent, so Pi wrote no session file.
    const sessionDirs = await readdir(join(agentDir, 'sessions'));
    for (const dir of sessionDirs) {
      expect(await readdir(join(agentDir, 'sessions', dir))).toEqual([]);
    }

    client.close();
  }, 120_000);
});
