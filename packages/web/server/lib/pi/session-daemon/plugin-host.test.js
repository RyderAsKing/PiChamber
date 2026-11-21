import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginHost, parsePluginConfig } from './plugin-host.js';

const pluginsRoot = async (files) => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-plugin-host-'));
  for (const [name, source] of Object.entries(files)) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'extension.js'), source);
  }
  return root;
};

const plugin = (root, id, state = { global: { on: true } }) => ({ id, entry: join(root, id, 'extension.js'), state });

// A minimal stand-in for the Pi extension API: records handlers so a test can
// fire `session_shutdown`.
const fakePi = () => {
  const handlers = new Map();
  return {
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    emit: (event) => (handlers.get(event) ?? []).forEach((handler) => handler({ type: event }, {})),
  };
};

describe('daemon plugin host', () => {
  it('has no plugins until configured', () => {
    expect(createPluginHost().extensionFactories()).toEqual([]);
  });

  it('builds named factories that receive the plugin handle with resolved state', async () => {
    const root = await pluginsRoot({ demo: 'export default function (pi, pichamber) { globalThis.__pluginHostDemo = { pi, pichamber }; }' });
    const host = createPluginHost({ pluginsRoot: root });
    const result = await host.configure({
      plugins: [{ ...plugin(root, 'demo', { global: { on: true, mode: 'a' }, projects: { '/p': { mode: 'b' } } }), replaceable: true }],
    });
    expect(result).toEqual({ enabledChanged: true, plugins: [{ id: 'demo', loaded: true }] });
    const factories = host.extensionFactories();
    expect(factories).toEqual([{ name: 'pichamber:demo', replaceable: true, factory: expect.any(Function) }]);
    const pi = fakePi();
    await factories[0].factory(pi);
    const { pichamber } = globalThis.__pluginHostDemo;
    expect(pichamber.id).toBe('demo');
    expect(Object.keys(pichamber).sort()).toEqual(['id', 'onStateChange', 'state']);
    expect(pichamber.state('/p')).toEqual({ on: true, mode: 'b' });
    expect(pichamber.state('/p/')).toEqual({ on: true, mode: 'b' });
    expect(pichamber.state('/q')).toEqual({ on: true, mode: 'a' });
    expect(pichamber.state()).toEqual({ on: true, mode: 'a' });
    delete globalThis.__pluginHostDemo;
  });

  it('resolves a session value over the project and global values', async () => {
    const root = await pluginsRoot({ demo: 'export default function (pi, pichamber) { globalThis.__pluginHostSession = pichamber; }' });
    const host = createPluginHost({ pluginsRoot: root });
    await host.configure({
      plugins: [plugin(root, 'demo', {
        global: { on: true, mode: 'a' },
        projects: { '/p': { mode: 'b' } },
        sessions: { s1: { on: false } },
      })],
    });
    await host.extensionFactories()[0].factory(fakePi());
    const pichamber = globalThis.__pluginHostSession;
    expect(pichamber.state('/p', 's1')).toEqual({ on: false, mode: 'b' });
    expect(pichamber.state('/p', 's2')).toEqual({ on: true, mode: 'b' });
    expect(pichamber.state(undefined, 's1')).toEqual({ on: false, mode: 'a' });
    delete globalThis.__pluginHostSession;
  });

  it('calls state listeners when only a session value changes', async () => {
    const root = await pluginsRoot({ demo: 'export default function (pi, pichamber) { pichamber.onStateChange(() => globalThis.__pluginHostSessionSeen.push(pichamber.state(undefined, \'s1\').on)); }' });
    globalThis.__pluginHostSessionSeen = [];
    const host = createPluginHost({ pluginsRoot: root });
    await host.configure({ plugins: [plugin(root, 'demo', { global: { on: true } })] });
    await host.extensionFactories()[0].factory(fakePi());
    await host.configure({ plugins: [plugin(root, 'demo', { global: { on: true }, sessions: { s1: { on: false } } })] });
    expect(globalThis.__pluginHostSessionSeen).toEqual([false]);
    delete globalThis.__pluginHostSessionSeen;
  });

  it('reports an enabled-set change only when the loaded set changes', async () => {
    const root = await pluginsRoot({ a: 'export default () => {}', b: 'export default () => {}' });
    const host = createPluginHost({ pluginsRoot: root });
    expect((await host.configure({ plugins: [] })).enabledChanged).toBe(false);
    expect((await host.configure({ plugins: [plugin(root, 'a')] })).enabledChanged).toBe(true);
    expect((await host.configure({ plugins: [plugin(root, 'a', { global: { on: false } })] })).enabledChanged).toBe(false);
    expect((await host.configure({ plugins: [plugin(root, 'a'), plugin(root, 'b')] })).enabledChanged).toBe(true);
    expect((await host.configure({ plugins: [plugin(root, 'b')] })).enabledChanged).toBe(true);
    expect(host.extensionFactories().map((entry) => entry.name)).toEqual(['pichamber:b']);
    expect((await host.configure({ plugins: [] })).enabledChanged).toBe(true);
    expect(host.extensionFactories()).toEqual([]);
  });

  it('calls state listeners on a state-only change and drops them at session shutdown', async () => {
    const root = await pluginsRoot({ demo: 'export default function (pi, pichamber) { pichamber.onStateChange(() => globalThis.__pluginHostSeen.push(pichamber.state().on)); }' });
    globalThis.__pluginHostSeen = [];
    const host = createPluginHost({ pluginsRoot: root });
    await host.configure({ plugins: [plugin(root, 'demo', { global: { on: true } })] });
    const pi = fakePi();
    await host.extensionFactories()[0].factory(pi);

    await host.configure({ plugins: [plugin(root, 'demo', { global: { on: true } })] });
    expect(globalThis.__pluginHostSeen).toEqual([]);
    await host.configure({ plugins: [plugin(root, 'demo', { global: { on: false } })] });
    expect(globalThis.__pluginHostSeen).toEqual([false]);

    pi.emit('session_shutdown');
    await host.configure({ plugins: [plugin(root, 'demo', { global: { on: true } })] });
    expect(globalThis.__pluginHostSeen).toEqual([false]);
    delete globalThis.__pluginHostSeen;
  });

  it('isolates a plugin that fails to import', async () => {
    const root = await pluginsRoot({ good: 'export default () => {}', broken: 'export default (' , nodefault: 'export const x = 1;' });
    const logger = { warn: vi.fn() };
    const host = createPluginHost({ pluginsRoot: root, logger });
    const result = await host.configure({ plugins: [plugin(root, 'broken'), plugin(root, 'good'), plugin(root, 'nodefault')] });
    expect(result.plugins).toEqual([
      { id: 'broken', loaded: false, error: 'The plugin could not be loaded.' },
      { id: 'good', loaded: true },
      { id: 'nodefault', loaded: false, error: 'The plugin could not be loaded.' },
    ]);
    expect(host.extensionFactories().map((entry) => entry.name)).toEqual(['pichamber:good']);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('refuses modules outside the plugins folder', async () => {
    const root = await pluginsRoot({ inside: 'export default () => {}' });
    const outside = await pluginsRoot({ evil: 'export default () => {}' });
    const host = createPluginHost({ pluginsRoot: root, logger: { warn: () => {} } });
    const result = await host.configure({ plugins: [{ id: 'evil', entry: join(outside, 'evil', 'extension.js'), state: {} }] });
    expect(result.plugins).toEqual([{ id: 'evil', loaded: false, error: 'The plugin could not be loaded.' }]);
    expect(host.extensionFactories()).toEqual([]);
  });

  it('validates the payload', () => {
    const bad = [
      undefined,
      {},
      { plugins: [{ id: 'Bad', entry: '/x.js' }] },
      { plugins: [{ id: 'a', entry: 'relative.js' }] },
      { plugins: [{ id: 'a', entry: '/x.js' }, { id: 'a', entry: '/y.js' }] },
      { plugins: [{ id: 'a', entry: '/x.js', state: { global: { on: 1 } } }] },
      { plugins: [{ id: 'a', entry: '/x.js', state: { projects: { relative: {} } } }] },
      { plugins: [{ id: 'a', entry: '/x.js', state: { sessions: { s1: { on: 1 } } } }] },
      { plugins: [{ id: 'a', entry: '/x.js', state: { sessions: { ['x'.repeat(257)]: {} } } }] },
      { plugins: [{ id: 'a', entry: '/x.js', replaceable: 'yes' }] },
    ];
    for (const payload of bad) expect(() => parsePluginConfig(payload)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('records the names a plugin registers and still runs its factory through the wrapper', async () => {
    const root = await pluginsRoot({
      demo: `export default function (pi, pichamber) {
        pi.registerTool({ name: 'demo_tool', parameters: {} });
        pi.registerCommand('demo-cmd', { handler() {} });
        pi.registerFlag('demo-flag', { type: 'boolean' });
        globalThis.__pluginHostWrapped = { returned: pi.on('session_start', () => {}), id: pichamber.id };
      }`,
      quiet: 'export default function () {}',
    });
    const host = createPluginHost({ pluginsRoot: root });
    await host.configure({ plugins: [plugin(root, 'demo'), plugin(root, 'quiet')] });
    expect(host.configuredIds().sort()).toEqual(['demo', 'quiet']);
    expect(host.registeredNames().size).toBe(0);

    const calls = [];
    const pi = {
      ...fakePi(),
      registerTool: (tool) => { calls.push(['tool', tool.name]); return 'tool-result'; },
      registerCommand: (name) => { calls.push(['command', name]); },
      registerFlag: (name) => { calls.push(['flag', name]); },
    };
    const [demo] = host.extensionFactories();
    await demo.factory(pi);
    expect(calls).toEqual([['tool', 'demo_tool'], ['command', 'demo-cmd'], ['flag', 'demo-flag']]);
    expect(globalThis.__pluginHostWrapped).toEqual({ returned: expect.any(Function), id: 'demo' });
    expect(host.registeredNames()).toEqual(new Map([['demo', ['tool:demo_tool', 'command:demo-cmd', 'flag:demo-flag']]]));

    // Dropping the plugin forgets its names.
    await host.configure({ plugins: [plugin(root, 'quiet')] });
    expect(host.registeredNames().size).toBe(0);
    delete globalThis.__pluginHostWrapped;
  });
});
