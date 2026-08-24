import { describe, expect, test } from 'bun:test';

import { parseExtensionAppCommand } from './extension-app-command';

const context = { appId: 'board', token: 'secret' };

describe('parseExtensionAppCommand', () => {
  test('accepts only the bound app capability', () => {
    expect(parseExtensionAppCommand({
      type: 'pichamber-app-command',
      appId: 'board',
      token: 'secret',
      command: 'agents:run',
      args: '  one\ntwo ',
    }, context)).toBe('/agents:run one two');
  });

  test('rejects stale tokens, other apps, and unsafe commands', () => {
    expect(parseExtensionAppCommand({ type: 'pichamber-app-command', appId: 'board', token: 'stale', command: 'run' }, context)).toBe(undefined);
    expect(parseExtensionAppCommand({ type: 'pichamber-app-command', appId: 'other', token: 'secret', command: 'run' }, context)).toBe(undefined);
    expect(parseExtensionAppCommand({ type: 'pichamber-app-command', appId: 'board', token: 'secret', command: '../run' }, context)).toBe(undefined);
    expect(parseExtensionAppCommand({ type: 'other', appId: 'board', token: 'secret', command: 'run' }, context)).toBe(undefined);
  });
});
