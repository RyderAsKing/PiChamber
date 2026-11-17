import { describe, expect, test } from 'bun:test';

import type { PiExtensionConfigItem, PiExtensionConfigResponse, PiExtensionReplacement } from '@/lib/pi/protocol';

import { findReplacement, replacementFix, replacementLine, replacementNotes, replacementReason } from './replacements';

const item = (id: string, name: string, extra: Partial<PiExtensionConfigItem> = {}): PiExtensionConfigItem => ({
  id,
  name,
  group: 'auto',
  scope: 'user',
  global: true,
  ...extra,
});

const config = (extra: Partial<PiExtensionConfigResponse> = {}): PiExtensionConfigResponse => ({
  project: { available: false, trusted: false },
  packages: [],
  extensions: [item('ext-sub', 'subagent'), item('builtin-mcp', 'mcp', { group: 'builtin' })],
  installFailures: [],
  ...extra,
});

const plugin: PiExtensionReplacement = {
  kind: 'plugin',
  id: 'subagents',
  registers: { kind: 'tool', name: 'subagent' },
  by: { id: 'ext-sub', name: 'subagent' },
};

describe('findReplacement', () => {
  test('matches kind and id', () => {
    const withReplaced = config({ replaced: [plugin] });
    expect(findReplacement(withReplaced, 'plugin', 'subagents')).toBe(plugin);
    expect(findReplacement(withReplaced, 'builtin', 'subagents')).toBeUndefined();
    expect(findReplacement(withReplaced, 'plugin', 'visuals')).toBeUndefined();
  });

  test('a list without the field reports nothing', () => {
    expect(findReplacement(config(), 'plugin', 'subagents')).toBeUndefined();
    expect(findReplacement(null, 'plugin', 'subagents')).toBeUndefined();
  });
});

describe('wording', () => {
  test('names the extension and what both register', () => {
    expect(replacementLine(plugin)).toBe('Not loaded: subagent takes its place');
    expect(replacementReason(plugin)).toBe('Pi loads subagent instead. Both register the subagent tool, and Pi keeps only one.');
    expect(replacementReason({ ...plugin, registers: { kind: 'command', name: 'mcp' } })).toContain('the /mcp command');
    expect(replacementReason({ ...plugin, registers: { kind: 'flag', name: 'plan' } })).toContain('the --plan flag');
  });

  test('stays true when the server could not name the details', () => {
    const bare: PiExtensionReplacement = { kind: 'plugin', id: 'subagents' };
    expect(replacementLine(bare)).toBe('Not loaded: another extension takes its place');
    expect(replacementReason(bare)).toBe('Pi loads another extension instead. Both register the same tool, command, or flag, and Pi keeps only one.');
  });
});

describe('replacementFix', () => {
  test('turns a global extension off globally', () => {
    expect(replacementFix(config(), plugin)).toEqual({ id: 'ext-sub', name: 'subagent', scope: 'global' });
  });

  test('offers nothing when the extension is not listed', () => {
    expect(replacementFix(config(), { ...plugin, by: { name: 'subagent' } })).toBeNull();
    expect(replacementFix(config(), { ...plugin, by: { id: 'gone', name: 'subagent' } })).toBeNull();
    expect(replacementFix(null, plugin)).toBeNull();
  });

  test('offers nothing when a global switch would not unload it', () => {
    const off = config({ extensions: [item('ext-sub', 'subagent', { global: false })] });
    expect(replacementFix(off, plugin)).toBeNull();
    const forced = config({
      directory: '/repo',
      project: { available: true, trusted: true },
      extensions: [item('ext-sub', 'subagent', { project: { state: 'load', inherited: true, enabled: true } })],
    });
    expect(replacementFix(forced, plugin)).toBeNull();
  });

  test('turns a project extension off in a trusted project only', () => {
    const projectItem = item('ext-sub', 'subagent', {
      scope: 'project',
      global: undefined,
      project: { state: 'inherit', inherited: true, enabled: true },
    });
    const trusted = config({ directory: '/repo', project: { available: true, trusted: true }, extensions: [projectItem] });
    expect(replacementFix(trusted, plugin)).toEqual({ id: 'ext-sub', name: 'subagent', scope: 'project' });
    const untrusted = config({ directory: '/repo', project: { available: true, trusted: false }, extensions: [projectItem] });
    expect(replacementFix(untrusted, plugin)).toBeNull();
  });
});

describe('replacementNotes', () => {
  test('marks the extension loaded in place of a plugin', () => {
    const notes = replacementNotes(config({ replaced: [plugin] }), { subagents: 'Sub-agents' });
    expect(notes.get('ext-sub')).toEqual({ text: 'Loaded in place of the Sub-agents plugin', warning: false });
    expect(notes.size).toBe(1);
  });

  test('marks a built-in that was left out and the extension that took its place', () => {
    const builtin: PiExtensionReplacement = {
      kind: 'builtin',
      id: 'builtin-mcp',
      registers: { kind: 'command', name: 'mcp' },
      by: { id: 'ext-sub', name: 'subagent' },
    };
    const notes = replacementNotes(config({ replaced: [builtin] }), {});
    expect(notes.get('builtin-mcp')).toEqual({ text: 'Not loaded: subagent takes its place', warning: true });
    expect(notes.get('ext-sub')).toEqual({ text: 'Loaded in place of Pi\'s mcp', warning: false });
  });

  test('skips what it cannot name', () => {
    expect(replacementNotes(config({ replaced: [plugin] }), {}).size).toBe(0);
    expect(replacementNotes(config({ replaced: [{ kind: 'builtin', id: 'unknown' }] }), {}).size).toBe(0);
    expect(replacementNotes(config(), {}).size).toBe(0);
  });
});
