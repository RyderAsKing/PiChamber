import { describe, expect, test } from 'bun:test';
import type { PiProjectSandboxState } from '@/lib/pi/protocol';
import { buildSetting, draftFromState, parseHosts, parsePorts, settingDiffers } from './projectSandboxDraft';

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

  test('a project without state reads as off with empty lists', () => {
    expect(draftFromState(undefined)).toEqual({ mode: 'off', hostsText: '', portsText: '', folders: [] });
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
