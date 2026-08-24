import { describe, expect, test } from 'bun:test';

import {
  buildCommandPromptText,
  sanitizeCommandTriggers,
  triggerPromptText,
} from './command-triggers';

describe('command triggers', () => {
  test('builds one normalized prompt shape for every command surface', () => {
    expect(buildCommandPromptText('economy')).toBe('/economy');
    expect(buildCommandPromptText('economy', '  fast\nnow  ')).toBe('/economy fast now');
    expect(triggerPromptText({ id: 'mode', label: 'Mode', command: 'mode', args: ' next ' }))
      .toBe('/mode next');
  });

  test('bounds command arguments', () => {
    expect(buildCommandPromptText('run', 'a'.repeat(2_001))).toBe(`/run ${'a'.repeat(2_000)}`);
  });

  test('rejects invalid persisted command names and normalizes duplicate ids', () => {
    expect(sanitizeCommandTriggers([
      { id: 'same', label: 'Valid', command: 'valid' },
      { id: 'same', label: 'Other', command: 'other', combo: 'Ctrl+K' },
      { id: 'bad', label: 'Path', command: 'nested/path' },
      { id: 'dot', label: 'Dot', command: '.hidden' },
    ])).toEqual([
      { id: 'same', label: 'Valid', command: 'valid' },
      { id: 'trigger-2-other', label: 'Other', command: 'other', combo: 'ctrl+k' },
    ]);
  });
});
