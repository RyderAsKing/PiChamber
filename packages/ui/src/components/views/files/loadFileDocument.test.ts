import { describe, expect, test } from 'bun:test';

import { MAX_VIEW_CHARS } from './filesViewModel';
import { loadFileDocument } from './loadFileDocument';

describe('loadFileDocument', () => {
  test('does not read known binary assets as text', async () => {
    let reads = 0;
    const readText = async () => {
      reads += 1;
      return '';
    };

    expect(await loadFileDocument('/tmp/image.png', true, readText)).toEqual({ kind: 'desktop-image' });
    expect(await loadFileDocument('/tmp/image.png', false, readText)).toEqual({ kind: 'asset-image' });
    expect(await loadFileDocument('/tmp/report.pdf', false, readText)).toEqual({ kind: 'pdf' });
    expect(await loadFileDocument('/tmp/archive.zip', false, readText)).toEqual({
      kind: 'binary',
      detectedFromContent: false,
    });
    expect(reads).toBe(0);
  });

  test('normalizes editor text while retaining its line ending', async () => {
    const result = await loadFileDocument('/tmp/readme.md', false, async () => 'one\r\ntwo\r\n');
    expect(result).toEqual({
      kind: 'text',
      content: 'one\ntwo\n',
      draft: 'one\ntwo\n',
      lineEnding: '\r\n',
    });
  });

  test('classifies binary content discovered after a text read', async () => {
    const result = await loadFileDocument('/tmp/unknown.data', false, async () => 'prefix\0suffix');
    expect(result).toEqual({ kind: 'binary', detectedFromContent: true });
  });

  test('truncates the draft but retains complete normalized content', async () => {
    const raw = 'x'.repeat(MAX_VIEW_CHARS + 1);
    const result = await loadFileDocument('/tmp/large.txt', false, async () => raw);
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('expected text result');
    expect(result.content).toHaveLength(MAX_VIEW_CHARS + 1);
    expect(result.draft).toBe(`${raw.slice(0, MAX_VIEW_CHARS)}\n\n… truncated …`);
  });
});
