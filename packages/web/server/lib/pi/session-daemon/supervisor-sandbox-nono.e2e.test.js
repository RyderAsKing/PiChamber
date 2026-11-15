import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpenUrlIntake } from '../../open-url/intake.js';
import { createNonoLauncher } from '../sandbox/nono-launcher.js';
import { prepareProjectSandbox } from '../sandbox/project-sandbox.js';
import { getPiSessionDirectory } from './session-jsonl.js';
import { readSessionLeaseOwner } from './session-lease.js';
import { createSandboxedPiSessionDaemonSupervisor } from './supervisor.js';

// Runs only where nono can sandbox (Linux with Landlock and nono >= 0.82.0).
// CI and the development container have no Landlock, so this skips there;
// run it on a Landlock machine before a release.
const probe = await createNonoLauncher().probe();

// The faux model answers the first prompt with one bash tool call carrying
// the prompt text as its command, then with plain text.
const EXTENSION = `
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

const lastUserText = (context) => {
  const message = [...context.messages].reverse().find((entry) => entry.role === 'user');
  if (!message) return '';
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((part) => part.text || '').join('');
};

export default function (pi) {
  const faux = fauxProvider({
    provider: 'sandbox-mock-provider',
    models: [{
      id: 'sandbox-mock-model',
      name: 'Sandbox Mock Model',
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16384,
      maxTokens: 2048,
    }],
    tokensPerSecond: 1000,
  });
  faux.setResponses([
    (context) => fauxAssistantMessage(
      [fauxToolCall('bash', { command: lastUserText(context) }, { id: 'call-sandbox-1' })],
      { stopReason: 'toolUse' },
    ),
    () => fauxAssistantMessage('done'),
  ]);
  pi.registerProvider(faux.provider);
}
`;

const waitForFile = async (path, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, 'utf8');
      if (text.includes('END')) return text;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${path}`);
};

describe.skipIf(!probe.available)('sandboxed daemon under real nono', () => {
  let supervisor;
  let intake;

  afterEach(async () => {
    await intake?.stop().catch(() => {});
    intake = undefined;
    await supervisor?.stop().catch(() => {});
    supervisor = undefined;
  });

  it('lets a turn\'s bash tool write in the project and denies everything outside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-nono-e2e-'));
    const home = join(root, 'home');
    const agentDir = join(home, '.pi', 'agent');
    const dataDir = join(root, 'data');
    const project = join(root, 'code', 'projA');
    const otherProject = join(root, 'code', 'projB');
    const outside = join(root, 'outside');
    await Promise.all([
      mkdir(join(agentDir, 'extensions'), { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(otherProject, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(join(agentDir, 'extensions', 'sandbox-mock.ts'), EXTENSION);
    const settings = JSON.stringify({ defaultProvider: 'sandbox-mock-provider', defaultModel: 'sandbox-mock-model' });
    await writeFile(join(agentDir, 'settings.json'), settings);
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
      'sandbox-mock-provider': { type: 'api_key', key: 'faux-test-key' },
    }));
    const otherSessions = getPiSessionDirectory({ cwd: otherProject, agentDir });
    await mkdir(otherSessions, { recursive: true });
    await writeFile(join(otherSessions, 'other.jsonl'), '{"type":"session"}\n');
    // Stand-in for the main daemon's credential in the same data folder.
    const mainCredential = join(dataDir, 'pi', 'daemons', 'web-p3000', 'session-daemon.key');
    await mkdir(join(dataDir, 'pi', 'daemons', 'web-p3000'), { recursive: true });
    await writeFile(mainCredential, 'main-daemon-credential\n');

    const env = {
      ...process.env,
      HOME: home,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: dataDir,
      PICHAMBER_PI_AGENT_DIR: agentDir,
      // Short on purpose: the daemon socket path must fit a Unix socket address.
      XDG_RUNTIME_DIR: await mkdtemp('/tmp/pcx-'),
    };
    const sandbox = await prepareProjectSandbox({ dataDir, agentDir, projectRoot: project, serverPort: 3000 });
    supervisor = await createSandboxedPiSessionDaemonSupervisor({ env, port: 3000, launcher: createNonoLauncher(), sandbox });
    await supervisor.start();

    const results = join(project, 'results.txt');
    const check = (name, command) => `if sh -c '${command}' >/dev/null 2>&1; then echo ${name}=allowed; else echo ${name}=denied; fi >> ${results}`;
    const script = [
      check('project', `echo x > ${join(project, 'inside.txt')}`),
      check('outside', `echo x > ${join(outside, 'w.txt')}`),
      check('otherSessionsRead', `cat ${join(otherSessions, 'other.jsonl')}`),
      check('otherSessionsWrite', `echo x > ${join(otherSessions, 'planted.jsonl')}`),
      check('otherProject', `ls ${otherProject}`),
      check('piSettings', `echo pwn >> ${join(agentDir, 'settings.json')}`),
      check('piExtensions', `mkdir ${join(agentDir, 'extensions', 'evil')}`),
      check('mainCredential', `cat ${mainCredential}`),
      `echo END >> ${results}`,
    ].join('; ');

    const created = await supervisor.request('sessions.create', { cwd: project });
    await supervisor.request('sessions.prompt', { sessionId: created.session.id, text: script });
    const text = await waitForFile(results);

    expect(text).toContain('project=allowed');
    expect(text).toContain('outside=denied');
    expect(text).toContain('otherSessionsRead=denied');
    expect(text).toContain('otherSessionsWrite=denied');
    expect(text).toContain('otherProject=denied');
    expect(text).toContain('piSettings=denied');
    expect(text).toContain('piExtensions=denied');
    expect(text).toContain('mainCredential=denied');
    await expect(readFile(join(agentDir, 'settings.json'), 'utf8')).resolves.toBe(settings);
  }, 120_000);

  it('keys its session lease on the real agent folder and reaches its own Open request intake', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-nono-e2e-'));
    const home = join(root, 'home');
    const agentDir = join(home, '.pi', 'agent');
    const dataDir = join(root, 'data');
    const project = join(root, 'code', 'projA');
    await Promise.all([
      mkdir(join(agentDir, 'extensions'), { recursive: true }),
      mkdir(project, { recursive: true }),
    ]);
    await writeFile(join(agentDir, 'extensions', 'sandbox-mock.ts'), EXTENSION);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'sandbox-mock-provider', defaultModel: 'sandbox-mock-model' }));
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
      'sandbox-mock-provider': { type: 'api_key', key: 'faux-test-key' },
    }));
    const env = {
      ...process.env,
      HOME: home,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: dataDir,
      PICHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: await mkdtemp('/tmp/pcx-'),
    };
    const sandbox = await prepareProjectSandbox({ dataDir, agentDir, projectRoot: project, serverPort: 3000 });
    supervisor = await createSandboxedPiSessionDaemonSupervisor({ env, port: 3000, launcher: createNonoLauncher(), sandbox });
    const published = [];
    intake = createOpenUrlIntake({
      socketPath: supervisor.paths.openUrlSocket,
      publish: async (payload) => {
        published.push(payload);
        return { published: true };
      },
      hasConnectedDevices: () => true,
    });
    await intake.start();
    await supervisor.start();

    const results = join(project, 'results.txt');
    const script = `"$BROWSER" https://example.test/from-sandbox >/dev/null 2>&1; echo END >> ${results}`;
    const created = await supervisor.request('sessions.create', { cwd: project });
    await supervisor.request('sessions.prompt', { sessionId: created.session.id, text: script });
    await waitForFile(results);

    // The main daemon computes the same lease file, so the two exclude each
    // other on this session.
    await expect(readSessionLeaseOwner({ agentDir, cwd: project, sessionId: created.session.id }))
      .resolves.toMatchObject({ profileKey: supervisor.paths.profileKey });
    expect(published).toContainEqual(expect.objectContaining({ url: 'https://example.test/from-sandbox' }));
  }, 120_000);
});
