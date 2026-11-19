import { describe, expect, it } from 'vitest';

import {
  commandName,
  normalizeExtensionCommandArgs,
  parseExtensionCommandName,
  parseExtensionCommandText,
} from './extension-commands.js';

describe('extension command rule', () => {
  it('reads a name with or without one leading slash', () => {
    expect(parseExtensionCommandName('review')).toBe('review');
    expect(parseExtensionCommandName('/review')).toBe('review');
    expect(parseExtensionCommandName('agents:run')).toBe('agents:run');
    expect(parseExtensionCommandName('review.staged')).toBe('review.staged');
    expect(parseExtensionCommandName('a'.repeat(128))).toBe('a'.repeat(128));
  });

  it('refuses what is not a command name', () => {
    for (const bad of ['', '/', '//review', 'a/b', '..etc', '.hidden', 'run now', 'a'.repeat(129), 3, undefined]) {
      expect(parseExtensionCommandName(bad)).toBeNull();
    }
  });

  it('keeps arguments to one trimmed line of 2,000 characters', () => {
    expect(normalizeExtensionCommandArgs('  one\ntwo\t')).toBe('one two');
    expect(normalizeExtensionCommandArgs('x'.repeat(3000))).toHaveLength(2000);
    expect(normalizeExtensionCommandArgs(undefined)).toBe('');
  });

  it('reads a command with its arguments in one string', () => {
    expect(parseExtensionCommandText('/plan on')).toBe('plan on');
    expect(parseExtensionCommandText('review --staged')).toBe('review --staged');
    expect(parseExtensionCommandText('plan')).toBe('plan');
    expect(parseExtensionCommandText('a/b on')).toBeNull();
    expect(commandName('review --staged')).toBe('review');
  });
});
