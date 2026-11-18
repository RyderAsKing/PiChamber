import { describe, expect, test } from 'bun:test';
import type { PiProjectSandboxState } from '@/lib/pi/protocol';
import { buildSetting, draftFromState, parseHosts, parsePorts, settingDiffers, settingToSave,
  choiceSandboxes,
  hasPreset,
  HOST_PRESETS,
  withPreset,
} from './projectSandboxDraft';

const state: PiProjectSandboxState = {
  projectId: 'p1',
  mode: 'nono',
  launcher: 'nono',
  availability: { state: 'available' },
  allowHosts: ['registry.npmjs.org', 'github.com'],
  allowLocalPorts: [8080],
  extraFolders: [{ path: '/home/me/docs', access: 'read' }],
};

describe('project sandbox draft', () => {
  test('a draft with a bad port saves nothing, except that Off saves with the grants the server holds', () => {
    const draft = { ...draftFromState(state), portsText: '8080, nope' };
    const refused = settingToSave(draft, state);
    expect(refused.setting).toBeNull();
    expect(refused.error).toContain('nope');

    const off = settingToSave({ ...draft, mode: 'off' }, state);
    expect(off.setting).toEqual({
      mode: 'off',
      allowHosts: ['registry.npmjs.org', 'github.com'],
      allowLocalPorts: [8080],
      extraFolders: [{ path: '/home/me/docs', access: 'read' }],
    });
    // The unfinished grant is still reported.
    expect(off.error).toContain('nope');
    // With nothing loaded from the server there are no grants to keep.
    expect(settingToSave({ ...draft, mode: 'off' }, undefined).setting).toBeNull();
    // A draft that builds is saved as it is.
    expect(settingToSave(draftFromState(state), state)).toMatchObject({ setting: { mode: 'nono', allowLocalPorts: [8080] }, error: null });
  });

  test('round-trips the server state without a change', () => {
    const built = buildSetting(draftFromState(state));
    expect(built).toEqual({
      ok: true,
      setting: {
        mode: 'nono',
        allowHosts: ['registry.npmjs.org', 'github.com'],
        allowLocalPorts: [8080],
        extraFolders: [{ path: '/home/me/docs', access: 'read' }],
      },
    });
    if (built.ok) expect(settingDiffers(built.setting, state)).toBe(false);
  });

  test('a project without state follows the default, with empty lists', () => {
    expect(draftFromState(undefined)).toEqual({ mode: 'default', hostsText: '', portsText: '', folders: [] });
  });

  test('Default sandboxes only when the server default is on or unreadable', () => {
    expect(choiceSandboxes('default', { mode: 'nono', allowHosts: [] }, undefined)).toBe(true);
    expect(choiceSandboxes('default', { mode: 'off', allowHosts: [] }, undefined)).toBe(false);
    expect(choiceSandboxes('default', { mode: 'off', allowHosts: [], invalid: true }, undefined)).toBe(true);
    expect(choiceSandboxes('off', { mode: 'nono', allowHosts: [] }, undefined)).toBe(false);
  });

  test('a preset adds its hosts once and reads as added only when all are there', () => {
    const hosts = withPreset(['github.com', 'example.com'], HOST_PRESETS.github);
    expect(hosts.filter((host) => host === 'github.com')).toHaveLength(1);
    expect(hosts[1]).toBe('example.com');
    expect(hasPreset(hosts, HOST_PRESETS.github)).toBe(true);
    expect(hasPreset(['github.com'], HOST_PRESETS.github)).toBe(false);
  });

  test('parses hosts by line, comma or space, without duplicates', () => {
    expect(parseHosts(' a.example\nb.example, a.example  c.example\n\n')).toEqual(['a.example', 'b.example', 'c.example']);
  });

  test('parses ports and reports the first bad entry', () => {
    expect(parsePorts('8080, 11434 8080')).toEqual({ ok: true, ports: [8080, 11434] });
    expect(parsePorts('')).toEqual({ ok: true, ports: [] });
    expect(parsePorts('80, 70000')).toEqual({ ok: false, invalid: '70000' });
    expect(parsePorts('0')).toEqual({ ok: false, invalid: '0' });
    expect(parsePorts('8o80')).toEqual({ ok: false, invalid: '8o80' });
  });

  test('refuses to build a setting with a bad port', () => {
    const built = buildSetting({ ...draftFromState(state), portsText: 'abc' });
    expect(built).toEqual({ ok: false, error: '"abc" is not a port number from 1 to 65535.' });
  });

  test('leaves out folder rows that have no path yet', () => {
    const draft = draftFromState(state);
    draft.folders.push({ path: '   ', access: 'readWrite' });
    const built = buildSetting(draft);
    expect(built.ok && built.setting.extraFolders).toEqual([{ path: '/home/me/docs', access: 'read' }]);
  });

  test('turning the sandbox off keeps the lists and is a change', () => {
    const built = buildSetting({ ...draftFromState(state), mode: 'off' });
    expect(built.ok && built.setting.allowHosts).toEqual(['registry.npmjs.org', 'github.com']);
    if (built.ok) expect(settingDiffers(built.setting, state)).toBe(true);
  });
});
