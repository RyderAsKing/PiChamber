import { describe, expect, test } from 'bun:test';
import { marked, type Tokens } from 'marked';

import { IncrementalMarkdownStream, hasOpenFence, isPreformattedLiveMarkdown, streamMarkdownBlocks } from './markdownStreamBlocks';

const STREAM_DOC = [
  '# Title',
  '',
  'First paragraph with **strong** and `code`.',
  '',
  '- list item one',
  '- list item two',
  '',
  '```ts',
  'const x = 1',
  '',
  'still inside the fence',
  '```',
  '',
  '> quote with lazy',
  'continuation line',
  '',
  'Closing paragraph after enough blocks to freeze everything above.',
  '',
  'One more tail block.',
].join('\n');

const blockRaws = (blocks: ReturnType<typeof streamMarkdownBlocks>): string[] => (
  blocks.map((block) => `${block.mode}:${block.raw}`)
);

describe('IncrementalMarkdownStream', () => {
  test('matches a fresh full-prefix split at every append-only step', () => {
    const live = new IncrementalMarkdownStream();
    for (let end = 8; end < STREAM_DOC.length + 8; end += 8) {
      const prefix = STREAM_DOC.slice(0, Math.min(end, STREAM_DOC.length));
      expect(blockRaws(live.update(prefix))).toEqual(blockRaws(streamMarkdownBlocks(prefix, true)));
    }
  });

  test('re-lexes a bounded tail instead of the whole growing document', () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) => `Paragraph number ${index}.`);
    const doc = paragraphs.join('\n\n');
    let lexedChars = 0;
    const live = new IncrementalMarkdownStream((text) => {
      lexedChars += text.length;
      return marked.lexer(text) as Tokens.Generic[];
    });

    for (let end = 16; end < doc.length + 16; end += 16) {
      live.update(doc.slice(0, Math.min(end, doc.length)));
    }

    const naiveChars = (doc.length / 16) * (doc.length / 2);
    expect(lexedChars).toBeLessThan(doc.length * 6);
    expect(lexedChars).toBeLessThan(naiveChars);
  });

  test('resets when the source is not an append of the previous value', () => {
    const live = new IncrementalMarkdownStream();
    live.update('Hello world.\n\nSecond paragraph.');
    const replaced = live.update('Different document entirely.\n\nAnother paragraph.');
    expect(blockRaws(replaced)).toEqual(
      blockRaws(streamMarkdownBlocks('Different document entirely.\n\nAnother paragraph.', true)),
    );
  });

  test('live tail blocks skip highlighting until they freeze', () => {
    const blocks = streamMarkdownBlocks('Hello **world**.\n\nSecond paragraph.', true);
    expect(blocks.every((block) => block.highlight === false)).toBe(true);
    expect(blocks.at(-1)?.mode).toBe('live');
    expect(blocks[0]?.mode).toBe('full');
  });

  test('frozen stream blocks stay unhighlighted until settle', () => {
    const live = new IncrementalMarkdownStream();
    const text = Array.from({ length: 8 }, (_, index) => `Paragraph ${index}.`).join('\n\n');
    const blocks = live.update(text);
    expect(blocks.length).toBeGreaterThan(2);
    expect(blocks.every((block) => block.highlight === false)).toBe(true);
    expect(blocks.filter((block) => block.mode === 'live')).toHaveLength(1);
  });

  test('open fences are live pre-wrap sources and prose is not', () => {
    expect(hasOpenFence('```ts\nconst x = 1\n')).toBe(true);
    expect(hasOpenFence('The first cool night arrives,\nand I take stock:\n')).toBe(false);
    expect(hasOpenFence('```ts\nconst x = 1\n```\n')).toBe(false);
    expect(isPreformattedLiveMarkdown('```ts\nconst x = 1\n```\n')).toBe(true);
    expect(isPreformattedLiveMarkdown('- one\n- two\n')).toBe(true);
    expect(isPreformattedLiveMarkdown('The first cool night arrives,\nand I take stock:\n')).toBe(false);
  });
});
