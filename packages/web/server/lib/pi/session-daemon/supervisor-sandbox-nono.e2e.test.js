import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpenUrlIntake } from '../../open-url/intake.js';
import { createNonoLauncher } from '../sandbox/nono-launcher.js';
import { prepareProjectSandbox } from '../sandbox/project-sandbox.js';
import { getPiSessionDirectory } from './session-jsonl.js';
import { readSessionLeaseOwner } from './session-lease.js';
import { createSandboxedPiSessionDaemonSupervisor } from './supervisor.js';

// Runs only where nono can sandbox: Linux or WSL2 with Landlock, or macOS,
// with nono >= 0.82.0. Linux CI and the development container have no
// Landlock, so this skips there; the macOS CI job runs it. Run it on a
// Landlock machine before a release.
const probe = await createNonoLauncher().probe();
// WSL2 cannot mediate pathname Unix sockets (nono-launcher.js HOST_LIMITS).
const unixSocketsMediated = !probe.limits?.includes('UNIX_SOCKETS');

// Run inside the sandbox by the turn's bash tool: exits 0 when the attempt
// succeeds.
const PROBE_SCRIPT = `
import { connect } from 'node:net';
const [kind, target] = process.argv.slice(2);
const done = (ok) => process.exit(ok ? 0 : 1);
setTimeout(() => done(false), 8000);
const socket = kind === 'unix' ? connect(target) : connect(Number(target.split(':')[1]), target.split(':')[0]);
socket.on('connect', () => done(true)).on('error', () => done(false));
`;

const listen = (server, ...args) => new Promise((resolve) => server.listen(...args, () => resolve(server)));

// CI sets this where nono must work, so a broken probe fails instead of
// skipping the suite.
describe.runIf(process.env.PICHAMBER_REQUIRE_NONO_E2E === '1')('nono on a host that requires the e2e test', () => {
  it('can sandbox', () => {
    expect(probe).toMatchObject({ available: true });
  });
});

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

// The test's HOME holds nono's state folder (~/.local/state/nono), which
// nono refuses to start inside a folder its profile grants. macOS's temp
// folder sits under /private/var, which nono's macOS system group grants, so
// on macOS the test works under the real home, as a real home would be.
const testRootParent = process.platform === 'darwin' ? homedir() : tmpdir();
const roots = [];
const makeRoot = async () => {
  const root = await mkdtemp(join(testRootParent, process.platform === 'darwin' ? '.pichamber-nono-e2e-' : 'pichamber-nono-e2e-'));
  roots.push(root);
  return root;
};

describe.skipIf(!probe.available)('sandboxed daemon under real nono', () => {
  let supervisor;
  let intake;

  afterEach(async () => {
    await intake?.stop().catch(() => {});
    intake = undefined;
    await supervisor?.stop().catch(() => {});
    supervisor = undefined;
    // Kept on failure in CI, whose log step reads the daemon logs.
    if (!process.env.CI) await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('lets a turn\'s bash tool write in the project and denies everything outside it', async () => {
    const root = await makeRoot();
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
    const sharedLeases = join(agentDir, '.pichamber', 'locks', 'sessions');
    await mkdir(sharedLeases, { recursive: true });
    // The user's cache folders, so a refused write is the sandbox's doing.
    await mkdir(join(home, '.cache'), { recursive: true });
    await mkdir(join(home, 'Library', 'Caches'), { recursive: true });

    const env = {
      ...process.env,
      HOME: home,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: dataDir,
      PICHAMBER_PI_AGENT_DIR: agentDir,
      // Short on purpose: the daemon socket path must fit a Unix socket address.
      XDG_RUNTIME_DIR: await mkdtemp('/tmp/pcx-'),
    };
    // Local services outside the sandbox: a Unix socket (like the systemd
    // user manager's or Docker's) and a loopback TCP server (like PiChamber's).
    const outsideSocket = join(outside, 'service.sock');
    const unixServer = await listen(createNetServer(), outsideSocket);
    const tcpServer = await listen(createHttpServer((_request, response) => response.end('ok')), 0, '127.0.0.1');
    // A local port the project allows (like a local model server).
    const grantedServer = await listen(createHttpServer((_request, response) => response.end('ok')), 0, '127.0.0.1');
    const grantedPort = grantedServer.address().port;
    const probeFile = join(project, 'probe.mjs');
    await writeFile(probeFile, PROBE_SCRIPT);

    const sandbox = await prepareProjectSandbox({
      dataDir, agentDir, projectRoot: project, serverPort: 3000, allowLocalPorts: [grantedPort],
    });
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
      // Other projects' live session leases.
      check('sharedLeases', `ls ${sharedLeases}`),
      // The user's cache folders are not the sandbox's; it has its own.
      check('userCache', `echo x > "$HOME/.cache/probe" || echo x > "$HOME/Library/Caches/probe"`),
      check('ownCache', `echo x > "$XDG_CACHE_HOME/probe"`),
      check('unixOutside', `node ${probeFile} unix ${outsideSocket}`),
      check('tcpLoopback', `node ${probeFile} tcp 127.0.0.1:${tcpServer.address().port}`),
      check('tcpGranted', `node ${probeFile} tcp 127.0.0.1:${grantedPort}`),
      `echo END >> ${results}`,
    ].join('; ');

    const created = await supervisor.request('sessions.create', { cwd: project });
    await supervisor.request('sessions.prompt', { sessionId: created.session.id, text: script });
    const text = await waitForFile(results);
    unixServer.close();
    tcpServer.close();
    grantedServer.close();

    expect(text).toContain('project=allowed');
    expect(text).toContain('outside=denied');
    expect(text).toContain('otherSessionsRead=denied');
    expect(text).toContain('otherSessionsWrite=denied');
    expect(text).toContain('otherProject=denied');
    expect(text).toContain('piSettings=denied');
    expect(text).toContain('piExtensions=denied');
    expect(text).toContain('mainCredential=denied');
    expect(text).toContain('sharedLeases=denied');
    expect(text).toContain('userCache=denied');
    expect(text).toContain('ownCache=allowed');
    expect(text).toContain('tcpLoopback=denied');
    expect(text).toContain('tcpGranted=allowed');
    // The limit a WSL2 owner accepts: the socket is reachable there.
    expect(text).toContain(unixSocketsMediated ? 'unixOutside=denied' : 'unixOutside=allowed');
    await expect(readFile(join(agentDir, 'settings.json'), 'utf8')).resolves.toBe(settings);
  }, 120_000);

  it('keys its session lease on the real agent folder and reaches its own Open request intake', async () => {
    const root = await makeRoot();
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

    // The lease sits in the project's own lease folder under the real agent
    // folder, where a daemon outside the sandbox looks before it takes the
    // session.
    await expect(readSessionLeaseOwner({ agentDir, cwd: project, sessionId: created.session.id, scope: sandbox.leaseScope }))
      .resolves.toMatchObject({ profileKey: supervisor.paths.profileKey });
    await expect(readSessionLeaseOwner({ agentDir, cwd: project, sessionId: created.session.id })).resolves.toBeNull();
    expect(published).toContainEqual(expect.objectContaining({ url: 'https://example.test/from-sandbox' }));
  }, 120_000);
});
