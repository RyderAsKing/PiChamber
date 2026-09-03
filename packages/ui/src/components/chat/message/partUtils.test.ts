import { describe, expect, test } from 'bun:test';

import type { Part } from '@/lib/chat/types';
import { filterRenderableAssistantParts, hasRenderableAssistantContent } from './partUtils';

describe('filterRenderableAssistantParts', () => {
  test('retains every terminal tool regardless of count or terminal timestamp', () => {
    const tools: Part[] = Array.from({ length: 9 }, (_, index) => ({
      id: `tool-${index}`,
      type: 'tool',
      tool: 'read',
      callID: `call-${index}`,
      state: {
        status: index % 2 === 0 ? 'completed' : 'error',
        input: { path: `/tmp/file-${index}.txt` },
        time: { start: index },
      },
    }));

    expect(filterRenderableAssistantParts(tools)).toEqual(tools);
  });
});

describe('hasRenderableAssistantContent', () => {
  test('hides the empty assistant.message.start echo', () => {
    expect(hasRenderableAssistantContent([])).toBe(false);
    expect(hasRenderableAssistantContent([{ id: 't1', type: 'text', text: '' } as Part])).toBe(false);
    expect(hasRenderableAssistantContent([{ id: 't2', type: 'text', text: '   ' } as Part])).toBe(false);
    expect(hasRenderableAssistantContent([{ id: 'c1', type: 'compaction' } as Part])).toBe(false);
  });

  test('keeps messages with text, tools, reasoning, files, or errors', () => {
    expect(hasRenderableAssistantContent([{ id: 't3', type: 'text', text: 'hi' } as Part])).toBe(true);
    expect(
      hasRenderableAssistantContent([{ id: 'tool-1', type: 'tool', tool: 'read' } as Part]),
    ).toBe(true);
    expect(hasRenderableAssistantContent([{ id: 'r1', type: 'reasoning', text: '...' } as Part])).toBe(
      true,
    );
    expect(
      hasRenderableAssistantContent([{ id: 'f1', type: 'file', mime: 'image/png', url: 'blob:x' } as Part]),
    ).toBe(true);
    expect(hasRenderableAssistantContent([], 'Something failed')).toBe(true);
    expect(hasRenderableAssistantContent([{ id: 't4', type: 'text', text: '' } as Part], 'Failed')).toBe(
      true,
    );
  });
});
