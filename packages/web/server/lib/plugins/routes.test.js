import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadBundledPlugins } from './registry.js';
import { registerPluginRoutes } from './routes.js';
import { createPluginService } from './service.js';
import { createPluginStore } from './store.js';

const listen = (app) => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
});

const writePlugin = async (root, id, pichamber, { entrySource = 'export default function () {}' } = {}) => {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'extension.js'), entrySource);
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    version: '1.0.0',
    pi: { extensions: ['./extension.js'] },
    pichamber: { apiVersion: 1, id, name: 'Fixture', description: 'A fixture.', icon: 'artboard', ...pichamber },
  }));
};

describe('plugin registry', () => {
  it('skips an invalid plugin without blocking the others', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-plugin-registry-'));
    await writePlugin(root, 'good', {});
    await writePlugin(root, 'enabled-by-default', { defaultEnabled: true });
    await writePlugin(root, 'mismatch', { id: 'other' });
    await writeFile(join(root, 'registry.json'), JSON.stringify({ version: 1, plugins: ['good', 'enabled-by-default', 'mismatch', 'missing', '../escape'] }));
    const logger = { warn: vi.fn() };
    const plugins = await loadBundledPlugins({ pluginsDir: root, logger });
    expect([...plugins.keys()]).toEqual(['good']);
    expect(logger.warn).toHaveBeenCalledTimes(4);
  });

  it('throws when the registry file is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-plugin-registry-'));
    await writeFile(join(root, 'registry.json'), '{');
    await expect(loadBundledPlugins({ pluginsDir: root })).rejects.toMatchObject({ code: 'PLUGINS_UNREADABLE' });
  });
});

describe('plugin routes', () => {
  let server;

  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    server = undefined;
  });

  const setup = async ({ loadPlugins } = {}) => {
    const file = join(await mkdtemp(join(tmpdir(), 'pichamber-plugin-routes-')), 'pi', 'plugins.json');
    const onChange = vi.fn();
    const service = createPluginService({
      store: createPluginStore({ file }),
      ...(loadPlugins ? { loadPlugins } : {}),
    });
    const app = express();
    app.use(express.json());
    registerPluginRoutes(app, { service, onChange });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    return { call, onChange, file };
  };

  it('lists the bundled plugins, off, with defaults and measured impact', async () => {
    const { call } = await setup();
    const { status, body } = await call('GET', '/api/pi/plugins');
    expect(status).toBe(200);
    expect(body.plugins.map((plugin) => plugin.id)).toEqual(['visuals', 'subagents']);
    expect(body.plugins[0]).toMatchObject({
      id: 'visuals',
      name: 'Visuals',
      icon: 'artboard',
      version: '1.1.0',
      bundled: true,
      enabled: false,
      state: { allowNetwork: false },
      contributes: {
        composerToggles: [],
        settings: ['allowNetwork'],
        ui: 'visuals',
      },
      impact: {
        tools: [
          { name: 'render_html', exposure: 'direct', tokens: expect.any(Number) },
          { name: 'render_choices', exposure: 'direct', tokens: expect.any(Number) },
        ],
        hooks: [],
        commands: [],
      },
    });
    expect(body.plugins[0]).not.toHaveProperty('entry');
    expect(body.plugins[0]).not.toHaveProperty('packageDir');
    expect(body.plugins[0]).not.toHaveProperty('impactError');
    expect(body.plugins[1]).toMatchObject({
      id: 'subagents',
      bundled: true,
      enabled: false,
      state: { on: true },
      contributes: {
        composerToggles: [{ id: 'subagents', state: 'on', label: 'Sub-agents', icon: 'robot-2', description: 'Let the agent hand tasks to sub-agents' }],
        settings: [],
        ui: 'subagents',
      },
      impact: { tools: [{ name: 'subagent', exposure: 'direct', tokens: expect.any(Number) }], hooks: [], commands: [] },
    });
  });

  it('enables, sets state, and notifies after each committed change', async () => {
    const { call, onChange } = await setup();
    const enabled = await call('PUT', '/api/pi/plugins/visuals', { enabled: true });
    expect(enabled).toMatchObject({ status: 200, body: { id: 'visuals', enabled: true } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const state = await call('PUT', '/api/pi/plugins/visuals/state', { key: 'allowNetwork', value: true });
    expect(state).toMatchObject({ status: 200, body: { state: { allowNetwork: true } } });
    expect(onChange).toHaveBeenCalledTimes(2);
    const listed = await call('GET', '/api/pi/plugins?directory=/some/project');
    expect(listed.body.plugins[0]).toMatchObject({ enabled: true, state: { allowNetwork: true } });
  });

  it('resolves project-scoped values for the requested directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-plugin-routes-fixture-'));
    await writePlugin(root, 'scoped', {
      state: { mode: { type: 'enum', scope: 'project', default: 'a', label: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } },
    });
    await writeFile(join(root, 'registry.json'), JSON.stringify({ version: 1, plugins: ['scoped'] }));
    const { call } = await setup({ loadPlugins: () => loadBundledPlugins({ pluginsDir: root }) });
    expect(await call('PUT', '/api/pi/plugins/scoped/state', { key: 'mode', value: 'b' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_PLUGIN_REQUEST' } } });
    expect(await call('PUT', '/api/pi/plugins/scoped/state', { key: 'mode', value: 'b', directory: '/p' })).toMatchObject({ status: 200, body: { state: { mode: 'b' } } });
    expect((await call('GET', '/api/pi/plugins?directory=/p')).body.plugins[0].state).toEqual({ mode: 'b' });
    expect((await call('GET', '/api/pi/plugins?directory=/q')).body.plugins[0].state).toEqual({ mode: 'a' });
    expect((await call('GET', '/api/pi/plugins')).body.plugins[0].state).toEqual({ mode: 'a' });
  });

  it('answers stable errors and never notifies on failure', async () => {
    const { call, onChange, file } = await setup();
    expect(await call('PUT', '/api/pi/plugins/missing', { enabled: true })).toEqual({ status: 404, body: { error: { code: 'PLUGIN_NOT_FOUND' } } });
    expect(await call('PUT', '/api/pi/plugins/visuals', { enabled: 'yes' })).toEqual({ status: 400, body: { error: { code: 'INVALID_PLUGIN_REQUEST' } } });
    expect(await call('PUT', '/api/pi/plugins/visuals/state', { key: 'allowNetwork', value: 1 })).toEqual({ status: 400, body: { error: { code: 'INVALID_PLUGIN_REQUEST' } } });
    expect(await call('PUT', '/api/pi/plugins/visuals/state', { key: 'nope', value: true })).toEqual({ status: 400, body: { error: { code: 'INVALID_PLUGIN_REQUEST' } } });
    expect(await call('GET', '/api/pi/plugins?directory=relative')).toEqual({ status: 400, body: { error: { code: 'INVALID_PLUGIN_REQUEST' } } });
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, '{broken');
    expect(await call('GET', '/api/pi/plugins')).toEqual({ status: 500, body: { error: { code: 'PLUGINS_UNREADABLE' } } });
    expect(await call('PUT', '/api/pi/plugins/visuals', { enabled: true })).toEqual({ status: 500, body: { error: { code: 'PLUGINS_UNREADABLE' } } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('names the npm packages of the bundled plugins', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'pichamber-plugin-config-')), 'plugins.json');
    const service = createPluginService({ store: createPluginStore({ file }) });
    expect((await service.bundledPackageNames()).sort()).toEqual([
      '@pi-chamber/plugin-subagents',
      '@pi-chamber/plugin-visuals',
    ]);
  });

  it('builds the daemon config from enabled plugins only', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'pichamber-plugin-config-')), 'plugins.json');
    const service = createPluginService({ store: createPluginStore({ file }) });
    expect(await service.daemonConfig()).toEqual({ plugins: [] });
    await service.setEnabled('visuals', true);
    await service.setState('visuals', { key: 'allowNetwork', value: true });
    expect(await service.daemonConfig()).toEqual({
      plugins: [{
        id: 'visuals',
        entry: expect.stringMatching(/plugins[\\/]visuals[\\/]extension\.js$/),
        replaceable: false,
        state: { global: { allowNetwork: true }, projects: {}, sessions: {} },
      }],
    });
  });

  it('keeps a composer switch to one session and leaves the settings alone', async () => {
    const { call, onChange } = await setup();
    await call('PUT', '/api/pi/plugins/subagents', { enabled: true });
    onChange.mockClear();
    expect(await call('GET', '/api/pi/plugins/sessions/s-1')).toEqual({ status: 200, body: { sessionId: 's-1', overrides: {} } });
    expect(await call('PUT', '/api/pi/plugins/subagents/sessions/s-1', { key: 'on', value: false }))
      .toEqual({ status: 200, body: { id: 'subagents', sessionId: 's-1', overrides: { on: false } } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((await call('GET', '/api/pi/plugins/sessions/s-1')).body.overrides).toEqual({ subagents: { on: false } });
    expect((await call('GET', '/api/pi/plugins/sessions/s-2')).body.overrides).toEqual({});
    expect((await call('GET', '/api/pi/plugins')).body.plugins[1].state).toEqual({ on: true });
    expect(await call('PUT', '/api/pi/plugins/subagents/sessions/s-1', { key: 'on', value: null }))
      .toEqual({ status: 200, body: { id: 'subagents', sessionId: 's-1', overrides: {} } });

    // Only keys a composer toggle names, valid values, and plain session ids.
    for (const [path, body] of [
      ['/api/pi/plugins/visuals/sessions/s-1', { key: 'allowNetwork', value: true }],
      ['/api/pi/plugins/subagents/sessions/s-1', { key: 'on', value: 'yes' }],
      ['/api/pi/plugins/subagents/sessions/s-1', { key: 'on' }],
      ['/api/pi/plugins/subagents/sessions/bad%20id', { key: 'on', value: false }],
    ]) {
      expect(await call('PUT', path, body)).toEqual({ status: 400, body: { error: { code: 'INVALID_PLUGIN_REQUEST' } } });
    }
    expect(await call('PUT', '/api/pi/plugins/missing/sessions/s-1', { key: 'on', value: false })).toMatchObject({ status: 404 });
    expect(await call('GET', '/api/pi/plugins/sessions/bad%20id')).toMatchObject({ status: 400 });
    // The set and the clear; no failed request notified.
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('sends session values to the daemon and forgets a deleted session', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'pichamber-plugin-config-')), 'plugins.json');
    const service = createPluginService({ store: createPluginStore({ file }) });
    await service.setEnabled('subagents', true);
    await service.setSessionState('subagents', 's-1', { key: 'on', value: false });
    const [subagents] = (await service.daemonConfig()).plugins;
    expect(subagents.state).toEqual({ global: { on: true }, projects: {}, sessions: { 's-1': { on: false } } });
    expect(await service.forgetSession('s-1')).toBe(true);
    expect((await service.daemonConfig()).plugins[0].state.sessions).toEqual({});
    expect(await service.forgetSession('s-1')).toBe(false);
  });
});
