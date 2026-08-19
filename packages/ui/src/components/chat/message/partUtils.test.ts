import { describe, expect, test } from 'bun:test';

import type { Part } from '@/lib/chat/types';
import { filterRenderableAssistantParts } from './partUtils';

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
