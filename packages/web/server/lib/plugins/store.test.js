import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parsePluginPackage } from './manifest.js';
import {
  createPluginStore,
  isPluginEnabled,
  MAX_SESSIONS_PER_PLUGIN,
  resolvePluginState,
  resolveSessionOverrides,
} from './store.js';

const manifest = parsePluginPackage({
  version: '1.0.0',
  pi: { extensions: ['./extension.js'] },
  pichamber: {
    apiVersion: 1,
    id: 'demo',
    name: 'Demo',
    description: 'A demo plugin.',
    icon: 'artboard',
    state: {
      on: { type: 'boolean', scope: 'global', default: true, label: 'On' },
      loud: { type: 'boolean', scope: 'global', default: false, label: 'Loud' },
      mode: {
        type: 'enum',
        scope: 'project',
        default: 'a',
        label: 'Mode',
        options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      },
    },
    contributes: { controls: [{ id: 'demo', kind: 'toggle', state: 'on', label: 'Demo', icon: 'artboard' }] },
  },
}, { packageDir: '/plugins/demo', bundled: true });

const tempFile = async () => join(await mkdtemp(join(tmpdir(), 'pichamber-plugins-store-')), 'pi', 'plugins.json');

describe('plugin store', () => {
  it('treats a missing file as empty and a malformed one as unreadable', async () => {
    const file = await tempFile();
    const store = createPluginStore({ file });
    const empty = await store.read();
    expect(empty).toEqual({ version: 1, enabled: {}, state: {} });
    expect(isPluginEnabled(manifest, empty)).toBe(false);
    expect(resolvePluginState(manifest, empty, null)).toEqual({ on: true, loud: false, mode: 'a' });

    await store.setEnabled(manifest, true);
    for (const bad of ['{not json', '[]', '{"version":2}', '{"version":1,"enabled":{"demo":"yes"}}', '{"version":1,"state":{"demo":{"global":{"on":1}}}}']) {
      await writeFile(file, bad);
      await expect(store.read()).rejects.toMatchObject({ code: 'PLUGINS_UNREADABLE' });
      // A malformed file is never overwritten.
      await expect(store.setEnabled(manifest, false)).rejects.toMatchObject({ code: 'PLUGINS_UNREADABLE' });
      expect(await readFile(file, 'utf8')).toBe(bad);
    }
  });

  it('round-trips enabled state and scoped values', async () => {
    const file = await tempFile();
    const store = createPluginStore({ file });
    await store.setEnabled(manifest, true);
    await store.setState(manifest, { key: 'loud', value: true });
    await store.setState(manifest, { key: 'mode', value: 'b', directory: '/work/project/' });

    const reread = await createPluginStore({ file }).read();
    expect(isPluginEnabled(manifest, reread)).toBe(true);
    expect(reread.state.demo).toEqual({ global: { loud: true }, projects: { '/work/project': { mode: 'b' } }, sessions: {} });
    expect(resolvePluginState(manifest, reread, '/work/project')).toEqual({ on: true, loud: true, mode: 'b' });
    expect(resolvePluginState(manifest, reread, '/work/other')).toEqual({ on: true, loud: true, mode: 'a' });
    expect(resolvePluginState(manifest, reread, null)).toEqual({ on: true, loud: true, mode: 'a' });
  });

  it('keeps unknown ids and ignores values the manifest no longer accepts', async () => {
    const file = await tempFile();
    await createPluginStore({ file }).setEnabled(manifest, true);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.enabled.retired = true;
    raw.state.demo = { global: { loud: 'maybe', mode: 'b' }, projects: { '/p': { mode: 'gone', loud: true } } };
    await writeFile(file, JSON.stringify(raw));
    const store = createPluginStore({ file });
    const snapshot = await store.read();
    expect(snapshot.enabled.retired).toBe(true);
    // `loud` is global-scoped, `mode` project-scoped: values in the wrong scope or of the wrong type fall back.
    expect(resolvePluginState(manifest, snapshot, '/p')).toEqual({ on: true, loud: false, mode: 'a' });
    await store.setState(manifest, { key: 'loud', value: true });
    expect((await store.read()).enabled.retired).toBe(true);
  });

  it('rejects invalid values and project values without a directory', async () => {
    const store = createPluginStore({ file: await tempFile() });
    await expect(store.setState(manifest, { key: 'loud', value: 'true' })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_REQUEST' });
    // A composer toggle's key is set per session only.
    await expect(store.setState(manifest, { key: 'on', value: false })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_REQUEST' });
    await expect(store.setState(manifest, { key: 'missing', value: true })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_REQUEST' });
    await expect(store.setState(manifest, { key: 'mode', value: 'z', directory: '/p' })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_REQUEST' });
    await expect(store.setState(manifest, { key: 'mode', value: 'b' })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_REQUEST' });
    await expect(store.setState(manifest, { key: 'mode', value: 'b', directory: 'relative' })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_REQUEST' });
    await expect(store.setEnabled(manifest, 'yes')).rejects.toMatchObject({ code: 'INVALID_PLUGIN_REQUEST' });
  });

  it('never drops a concurrent write, also across store instances', async () => {
    const file = await tempFile();
    const first = createPluginStore({ file });
    const second = createPluginStore({ file });
    await Promise.all([
      first.setEnabled(manifest, true),
      second.setState(manifest, { key: 'loud', value: true }),
      first.setState(manifest, { key: 'mode', value: 'b', directory: '/a' }),
      second.setState(manifest, { key: 'mode', value: 'b', directory: '/b' }),
    ]);
    const snapshot = await first.read();
    expect(snapshot.enabled.demo).toBe(true);
    expect(snapshot.state.demo).toEqual({ global: { loud: true }, projects: { '/a': { mode: 'b' }, '/b': { mode: 'b' } }, sessions: {} });
  });

  it('starts a composer toggle\'s key from the manifest default, whatever a global value says', async () => {
    const file = await tempFile();
    // Left by an older build that let Settings change it for every session.
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, state: { demo: { global: { on: false }, projects: { '/p': { on: false } } } } }));
    const snapshot = await createPluginStore({ file }).read();
    expect(resolvePluginState(manifest, snapshot, null)).toEqual({ on: true, loud: false, mode: 'a' });
    expect(resolvePluginState(manifest, snapshot, '/p')).toEqual({ on: true, loud: false, mode: 'a' });
  });

  it('stores, clears, and forgets one session\'s own values', async () => {
    const file = await tempFile();
    const store = createPluginStore({ file });
    await store.setSessionState(manifest, { sessionId: 's-1', key: 'on', value: false });
    await store.setSessionState(manifest, { sessionId: 's-2', key: 'on', value: false });

    let snapshot = await createPluginStore({ file }).read();
    expect(resolveSessionOverrides(manifest, snapshot, 's-1')).toEqual({ on: false });
    expect(resolveSessionOverrides(manifest, snapshot, 's-3')).toEqual({});
    // Settings values are untouched by a session value.
    expect(resolvePluginState(manifest, snapshot, null)).toEqual({ on: true, loud: false, mode: 'a' });

    await store.setSessionState(manifest, { sessionId: 's-1', key: 'on', value: null });
    snapshot = await store.read();
    expect(snapshot.state.demo.sessions).toEqual({ 's-2': { on: false } });

    expect(await store.forgetSession('s-2')).toBe(true);
    expect(await store.forgetSession('s-2')).toBe(false);
    expect((await store.read()).state.demo.sessions).toEqual({});
  });

  it('only lets a session set keys a composer toggle names', async () => {
    const store = createPluginStore({ file: await tempFile() });
    await expect(store.setSessionState(manifest, { sessionId: 's', key: 'mode', value: 'b' })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_REQUEST' });
    await expect(store.setSessionState(manifest, { sessionId: 's', key: 'on', value: 'yes' })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_REQUEST' });
    for (const sessionId of ['', '../x', 'constructor', 'a b', 'x'.repeat(257), 7]) {
      await expect(store.setSessionState(manifest, { sessionId, key: 'on', value: false })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_REQUEST' });
    }
  });

  it('ignores session values the manifest no longer accepts', async () => {
    const file = await tempFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, state: { demo: { sessions: { s: { on: 'maybe', mode: 'b' } } } } }));
    const snapshot = await createPluginStore({ file }).read();
    expect(resolveSessionOverrides(manifest, snapshot, 's')).toEqual({});
  });

  it('drops the least recently set sessions past the cap', async () => {
    const file = await tempFile();
    const sessions = {};
    for (let index = 0; index < MAX_SESSIONS_PER_PLUGIN; index += 1) sessions[`s${index}`] = { on: false };
    await createPluginStore({ file }).setEnabled(manifest, true);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.state.demo = { global: {}, projects: {}, sessions };
    await writeFile(file, JSON.stringify(raw));
    const store = createPluginStore({ file });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Setting s0 again moves it to the end, so s1 is the oldest.
    await store.setSessionState(manifest, { sessionId: 's0', key: 'on', value: true });
    expect(warn).not.toHaveBeenCalled();
    await store.setSessionState(manifest, { sessionId: 'new', key: 'on', value: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('s1');
    warn.mockRestore();
    const ids = Object.keys((await store.read()).state.demo.sessions);
    expect(ids).toHaveLength(MAX_SESSIONS_PER_PLUGIN);
    expect(ids).not.toContain('s1');
    expect(ids.slice(-2)).toEqual(['s0', 'new']);
  });
});
