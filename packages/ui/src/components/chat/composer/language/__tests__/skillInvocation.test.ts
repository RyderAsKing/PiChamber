import { describe, expect, test } from 'bun:test';

import {
  collectKnownTokenNames,
  filterKnownTokens,
  scanPrefixTokens,
} from '../prefixTokens';
import { resolveAutocompleteTrigger } from '../triggers';
import { tokenizeComposer } from '../tokenize';

describe('skill invocation tokenization — /skill:name is one token', () => {
  test('slash scanner keeps skill: prefix as a single token', () => {
    const tokens = scanPrefixTokens('/skill:code-review focus', '/');
    expect(tokens.map((t) => t.name)).toEqual(['skill:code-review']);
  });

  test('extension suffixes with colon stay one token', () => {
    expect(scanPrefixTokens('/hello:2 args', '/').map((t) => t.name)).toEqual(['hello:2']);
  });

  test('bare /code-review is a different token from /skill:code-review', () => {
    const bare = scanPrefixTokens('/code-review', '/').map((t) => t.name);
    const skill = scanPrefixTokens('/skill:code-review', '/').map((t) => t.name);
    expect(bare).toEqual(['code-review']);
    expect(skill).toEqual(['skill:code-review']);
    expect(bare[0]).not.toBe(skill[0]);
  });

  test('file paths still do not tokenize', () => {
    expect(scanPrefixTokens('see a/b', '/')).toEqual([]);
    expect(scanPrefixTokens('src/components/App.tsx', '/')).toEqual([]);
  });

  test('snippet #name never allows colon skill syntax', () => {
    expect(scanPrefixTokens('#skill:review', '#').map((t) => t.name)).toEqual(['skill']);
  });

  test('membership decides: bare skill name does not highlight as skill', () => {
    const ctx = {
      inputMode: 'normal' as const,
      knownAgentNames: new Set<string>(),
      confirmedMentions: new Set<string>(),
      knownSlashNames: new Set(['skill:code-review', 'review', 'hello']),
      knownSnippetTriggers: new Set<string>(),
      attachmentFilenames: [] as string[],
    };
    const styles = (text: string) =>
      tokenizeComposer(text, ctx).map((r) => text.slice(r.start, r.end));
    expect(styles('/skill:code-review work')).toContain('/skill:code-review');
    expect(styles('/review work')).toContain('/review');
    expect(styles('/hello work')).toContain('/hello');
    // Bare /code-review is not in the known set, so it stays prose.
    expect(styles('/code-review work')).toEqual([]);
  });

  test('command trigger allows colon; shell mode disables all pickers', () => {
    const at = (text: string, cursor: number, inputMode: 'normal' | 'shell' = 'normal') =>
      resolveAutocompleteTrigger(text, cursor, { inputMode });
    // Leading /skill: remains the command palette (authoritative / list).
    expect(at('/skill:co', 9)).toEqual({ kind: 'command', query: 'skill:co' });
    // Inline /skill: still opens the skill picker with a colon query.
    expect(at('run /skill:co', 13)).toEqual({ kind: 'skill', query: 'skill:co' });
    expect(at('/rev', 4, 'shell')).toBeNull();
    expect(at('run /skill:x', 13, 'shell')).toBeNull();
    expect(at('use #sig', 8, 'shell')).toBeNull();
  });

  test('filterKnownTokens matches skill invocations case-insensitively', () => {
    const tokens = scanPrefixTokens('/SKILL:Code-Review', '/');
    const known = filterKnownTokens(tokens, new Set(['skill:code-review']));
    expect(known.map((t) => t.name)).toEqual(['SKILL:Code-Review']);
  });

  test('collectKnownTokenNames keeps skill invocations distinct from prompts', () => {
    const names = collectKnownTokenNames(
      '/review and /skill:review',
      '/',
      new Set(['review', 'skill:review']),
    );
    expect(names).toEqual(['review', 'skill:review']);
  });
});
