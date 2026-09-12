import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPiUiSettingsStore } from './ui-settings-store.js';

const makeStore = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-ui-settings-'));
  const file = join(root, 'settings.json');
  const runtimeFile = join(root, 'runtime-state.json');
  return { file, runtimeFile, store: createPiUiSettingsStore({ file, runtimeFile }) };
};

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

describe('Pi UI settings store', () => {
  it('distinguishes malformed persisted settings from a fresh store', async () => {
    const { file, store } = await makeStore();
    await expect(store.read()).resolves.toEqual({});
    await writeFile(file, '{broken');
    await expect(store.read()).rejects.toThrow('UI_SETTINGS_INVALID');
  });

  it('migrates a flat settings file into portable and local allowlists', async () => {
    const { file, runtimeFile, store } = await makeStore();
    await writeFile(file, JSON.stringify({
      themeId: 'nord',
      homeDirectory: '/old-home',
      projects: [{ id: 'old', path: '/old-home/project' }],
      desktopUiPassword: 'secret',
      unknownField: 'drop-me',
    }));

    await expect(store.read()).resolves.toMatchObject({
      themeId: 'nord',
      homeDirectory: '/old-home',
      projects: [{ id: 'old', path: '/old-home/project' }],
      desktopUiPassword: 'secret',
    });
    await expect(readJson(file)).resolves.toEqual({
      __pichamberSettingsScope: 'portable-v1',
      themeId: 'nord',
    });
    await expect(readJson(runtimeFile)).resolves.toEqual({
      homeDirectory: '/old-home',
      projects: [{ id: 'old', path: '/old-home/project' }],
      desktopUiPassword: 'secret',
    });
  });

  it('does not apply local fields copied in from another home', async () => {
    const source = await makeStore();
    await source.store.write({ themeId: 'nord', homeDirectory: '/mnt/data', projects: [{ id: 'one', path: '/mnt/data/project' }] });

    const target = await makeStore();
    await target.store.write({ homeDirectory: '/root', projects: [{ id: 'two', path: '/root/project' }] });
    await writeFile(target.file, await readFile(source.file));

    await expect(target.store.read()).resolves.toEqual({
      themeId: 'nord',
      homeDirectory: '/root',
      projects: [{ id: 'two', path: '/root/project' }],
    });
  });

  it('serializes scoped merge writes without dropping unrelated fields', async () => {
    const { file, runtimeFile, store } = await makeStore();
    await Promise.all([
      store.write({ themeId: 'dark' }),
      store.write({ projects: [{ id: 'one', path: '/one' }], desktopCloseToTrayEnabled: false }),
    ]);
    await expect(store.read()).resolves.toEqual({
      themeId: 'dark',
      projects: [{ id: 'one', path: '/one' }],
      desktopCloseToTrayEnabled: false,
    });
    await expect(readJson(file)).resolves.toEqual({
      __pichamberSettingsScope: 'portable-v1',
      themeId: 'dark',
    });
    await expect(readJson(runtimeFile)).resolves.toEqual({
      projects: [{ id: 'one', path: '/one' }],
      desktopCloseToTrayEnabled: false,
    });
  });

  it('persists the desktop update subscription locally and rejects unknown channels', async () => {
    const { file, runtimeFile, store } = await makeStore();

    await expect(store.write({ themeId: 'dark', desktopUpdateChannel: 'rc' })).resolves.toMatchObject({
      themeId: 'dark',
      desktopUpdateChannel: 'rc',
    });
    await expect(readJson(file)).resolves.toEqual({
      __pichamberSettingsScope: 'portable-v1',
      themeId: 'dark',
    });
    await expect(readJson(runtimeFile)).resolves.toEqual({ desktopUpdateChannel: 'rc' });
    await expect(store.write({ desktopUpdateChannel: 'beta' })).rejects.toThrow('UI_SETTINGS_INVALID');
    await expect(store.read()).resolves.toMatchObject({ desktopUpdateChannel: 'rc' });
  });

  it('rejects prototype-polluting keys', async () => {
    const { store } = await makeStore();
    const changes = JSON.parse('{"__proto__":{"polluted":true}}');
    await expect(store.write(changes)).rejects.toThrow('UI_SETTINGS_INVALID');
  });

  it('ignores retired preferences while preserving unrelated data', async () => {
    const { file, runtimeFile, store } = await makeStore();
    const retiredPortable = {
      showReasoningTraces: false,
      collapsibleThinkingBlocks: false,
      collapseThinkingByDefault: true,
      defaultFileViewerPreview: true,
      inputSpellcheckEnabled: true,
      showToolFileIcons: false,
      codeBlockLineWrap: false,
      showTurnChangedFiles: true,
      showExpandedBashTools: true,
      showExpandedEditTools: true,
      mermaidRenderingMode: 'ascii',
      userMessageRenderingMode: 'plain',
      collapsibleUserMessages: false,
      stickyUserHeader: true,
      promptNavigatorEnabled: false,
      wideChatLayoutEnabled: true,
      showSplitAssistantMessageActions: true,
      directoryShowHidden: false,
      gitmojiEnabled: true,
    };
    const retiredLocal = {
      desktopWindowControlsPosition: 'left',
      desktopWindowControlsStyle: 'traffic-lights',
    };

    // Writes accept unrelated fields and drop retired keys without failing.
    await expect(store.write({
      themeId: 'nord',
      diffLayoutPreference: 'side-by-side',
      draftStartersVisible: false,
      gitChangesViewMode: 'tree',
      autoCreateWorktree: true,
      ...retiredPortable,
      ...retiredLocal,
    })).resolves.toMatchObject({
      themeId: 'nord',
      diffLayoutPreference: 'side-by-side',
      draftStartersVisible: false,
      gitChangesViewMode: 'tree',
      autoCreateWorktree: true,
    });
    const readBack = await store.read();
    for (const key of [...Object.keys(retiredPortable), ...Object.keys(retiredLocal)]) {
      expect(readBack[key]).toBe(undefined);
    }
    expect(readBack.themeId).toBe('nord');
    expect(readBack.diffLayoutPreference).toBe('side-by-side');
    expect(readBack.draftStartersVisible).toBe(false);
    expect(readBack.gitChangesViewMode).toBe('tree');
    expect(readBack.autoCreateWorktree).toBe(true);
    // Retired keys never reach either backing file.
    const portable = await readJson(file);
    const runtime = await readJson(runtimeFile);
    for (const key of Object.keys(retiredPortable)) {
      expect(portable[key]).toBe(undefined);
    }
    for (const key of Object.keys(retiredLocal)) {
      expect(runtime[key]).toBe(undefined);
    }
    expect(portable.themeId).toBe('nord');

    // A legacy flat file carrying retired keys migrates only allowlisted data.
    const legacy = await makeStore();
    await writeFile(legacy.file, JSON.stringify({
      themeId: 'legacy',
      diffLayoutPreference: 'inline',
      ...retiredPortable,
      ...retiredLocal,
      unknownField: 'drop-me',
    }));
    await expect(legacy.store.read()).resolves.toMatchObject({
      themeId: 'legacy',
      diffLayoutPreference: 'inline',
    });
    const legacyRead = await legacy.store.read();
    for (const key of [...Object.keys(retiredPortable), ...Object.keys(retiredLocal)]) {
      expect(legacyRead[key]).toBe(undefined);
    }
  });

  it('preserves failure behavior for malformed and oversized payloads', async () => {
    const { file, store } = await makeStore();
    await writeFile(file, '{broken');
    await expect(store.read()).rejects.toThrow('UI_SETTINGS_INVALID');
    const changes = JSON.parse('{"constructor":{"polluted":true}}');
    await expect(store.write(changes)).rejects.toThrow('UI_SETTINGS_INVALID');
  });
});
