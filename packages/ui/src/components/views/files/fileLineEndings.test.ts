import { describe, expect, test } from 'bun:test';

import { detectFileLineEnding, serializeEditorContent } from './filesViewModel';

describe('editor line endings', () => {
  test('round-trips CRLF without normalizing on save', () => {
    expect(detectFileLineEnding('one\r\ntwo\r\n')).toBe('\r\n');
    expect(serializeEditorContent('one\ntwo\n', '\r\n')).toBe('one\r\ntwo\r\n');
    expect(serializeEditorContent('one\r\ntwo\r\n', '\r\n')).toBe('one\r\ntwo\r\n');
    expect(serializeEditorContent('one\ntwo\n', '\n')).toBe('one\ntwo\n');
  });
});
