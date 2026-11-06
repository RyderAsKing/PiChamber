import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionDaemon } from './session-daemon.js';

// End-to-end validation against the pinned Pi SDK: two real projects, each
// with its own AGENTS.md-level skills and prompt templates, are read through
// one daemon. The project that happens to hold the resident runtime must never
// supply the other project's slash commands (issue #199).
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
      const response = await next((message) => message.kind === 'response' && message.requestId === requestId);
      if (response.error) throw Object.assign(new Error(response.error), { code: response.code });
      return response.result;
    },
    close() {
      socket.end();
    },
  };
}

async function createProject(root, name) {
  const directory = join(root, name);
  await mkdir(join(directory, '.pi', 'prompts'), { recursive: true });
  await mkdir(join(directory, '.pi', 'skills', `${name}skill`), { recursive: true });
  await writeFile(join(directory, '.pi', 'prompts', `${name}prompt.md`), `Body of ${name}\n`);
  await writeFile(join(directory, '.pi', 'skills', `${name}skill`, 'SKILL.md'), [
    '---',
    `name: ${name}skill`,
    `description: ${name} skill`,
    '---',
    'Body',
    '',
  ].join('\n'));
  return directory;
}

describe('Pi session daemon directory-scoped catalogs with the real SDK', () => {
  let daemon;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
  });

  it('reads each project\'s own skills and prompts through one daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-directory-catalog-sdk-'));
    const alphaDir = await createProject(root, 'alpha');
    const betaDir = await createProject(root, 'beta');
    const agentDir = join(root, 'agent');
    await mkdir(agentDir, { recursive: true });

    const endpoint = testDaemonEndpoint(root);
    daemon = createSessionDaemon({ endpoint, credential, cwd: betaDir, agentDir });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();

    // Beta holds the resident runtime first, which is the state that answered
    // for every other directory.
    const beta = await client.request('resources.list', { directory: betaDir });
    expect(beta.skills.map((skill) => skill.name)).toEqual(['betaskill']);
    expect(beta.prompts.map((prompt) => prompt.name)).toEqual(['betaprompt']);

    const alpha = await client.request('resources.list', { directory: alphaDir });
    expect(alpha.skills.map((skill) => skill.name)).toEqual(['alphaskill']);
    expect(alpha.prompts.map((prompt) => prompt.name)).toEqual(['alphaprompt']);

    // Each catalog names the directory it was read from.
    const alphaExtensions = await client.request('extensions.list', { directory: alphaDir });
    expect(alphaExtensions.directory).toBe(alphaDir);
    const betaExtensions = await client.request('extensions.list', { directory: betaDir });
    expect(betaExtensions.directory).toBe(betaDir);

    client.close();
  }, 120_000);
});
