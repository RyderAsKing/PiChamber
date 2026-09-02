import { describe, expect, test } from 'bun:test';
const it = test;
import type { Part } from '@/lib/chat/types';
import type { ChatMessageEntry, TurnRecord } from './turns/types';
import {
  getMessageId,
  getMessageParentId,
  getPartText,
  isSessionRetryMessage,
  isSyntheticSubtaskBridgeAssistant,
  isUserSubtaskMessage,
  normalizeCompactionSummaryMessage,
  resolveMessageRole,
  turnContainsMessageId,
  withShellBridgeDetails,
  withSubtaskSessionId,
} from './messageListHelpers';

const makeMessage = (
  id: string,
  role: string,
  parts: Part[] = [],
  extra: Record<string, unknown> = {},
): ChatMessageEntry => ({
  info: {
    id,
    role,
    ...extra,
  } as any,
  parts,
});

describe('messageListHelpers', () => {
  describe('resolveMessageRole', () => {
    it('prefers clientRole over role', () => {
      const msg = makeMessage('1', 'system', [], { clientRole: 'assistant' });
      expect(resolveMessageRole(msg)).toBe('assistant');
    });

    it('falls back to role if clientRole is missing', () => {
      const msg = makeMessage('1', 'user');
      expect(resolveMessageRole(msg)).toBe('user');
    });

    it('returns null if neither is present', () => {
      const msg = { info: {} as any, parts: [] };
      expect(resolveMessageRole(msg)).toBeNull();
    });
  });

  describe('isSessionRetryMessage', () => {
    it('identifies SessionRetry errors', () => {
      const msg = makeMessage('1', 'assistant', [], { error: { name: 'SessionRetry' } });
      expect(isSessionRetryMessage(msg)).toBe(true);
    });

    it('returns false for non-retry errors or clean messages', () => {
      const msg1 = makeMessage('1', 'assistant', [], { error: { name: 'OtherError' } });
      const msg2 = makeMessage('2', 'assistant');
      expect(isSessionRetryMessage(msg1)).toBe(false);
      expect(isSessionRetryMessage(msg2)).toBe(false);
    });
  });

  describe('getPartText', () => {
    it('extracts text from text part', () => {
      expect(getPartText({ type: 'text', text: 'hello' } as Part)).toBe('hello');
    });

    it('extracts content from content part fallback', () => {
      expect(getPartText({ type: 'text', content: 'fallback' } as any)).toBe('fallback');
    });

    it('returns empty string if neither present', () => {
      expect(getPartText({ type: 'text' } as any)).toBe('');
    });
  });

  describe('getMessageId and getMessageParentId', () => {
    it('extracts id and parentID correctly', () => {
      const msg = makeMessage('msg-1', 'user', [], { parentID: 'parent-1' });
      expect(getMessageId(msg)).toBe('msg-1');
      expect(getMessageParentId(msg)).toBe('parent-1');
    });

    it('handles missing or whitespace ids', () => {
      expect(getMessageId(undefined)).toBeNull();
      expect(getMessageId(makeMessage('  ', 'user'))).toBeNull();
    });
  });

  describe('normalizeCompactionSummaryMessage', () => {
    it('sets clientRole to assistant for system compaction messages', () => {
      const msg = makeMessage('sys-1', 'system', [], { parentID: 'cmd-1' });
      const normalized = normalizeCompactionSummaryMessage(msg, new Set(['cmd-1']));
      expect((normalized.info as any).clientRole).toBe('assistant');
    });

    it('leaves non-system or non-matching messages untouched', () => {
      const userMsg = makeMessage('u-1', 'user', [], { parentID: 'cmd-1' });
      expect(normalizeCompactionSummaryMessage(userMsg, new Set(['cmd-1']))).toBe(userMsg);

      const sysMsg = makeMessage('sys-2', 'system', [], { parentID: 'cmd-2' });
      expect(normalizeCompactionSummaryMessage(sysMsg, new Set(['cmd-1']))).toBe(sysMsg);
    });
  });

  describe('isUserSubtaskMessage', () => {
    it('returns true only for user messages with subtask part', () => {
      const subtaskUser = makeMessage('1', 'user', [{ type: 'subtask' } as any]);
      const normalUser = makeMessage('2', 'user', [{ type: 'text', text: 'hi' } as any]);
      const assistantSubtask = makeMessage('3', 'assistant', [{ type: 'subtask' } as any]);

      expect(isUserSubtaskMessage(subtaskUser)).toBe(true);
      expect(isUserSubtaskMessage(normalUser)).toBe(false);
      expect(isUserSubtaskMessage(assistantSubtask)).toBe(false);
      expect(isUserSubtaskMessage(undefined)).toBe(false);
    });
  });

  describe('isSyntheticSubtaskBridgeAssistant', () => {
    it('recognizes task tool single part in assistant message', () => {
      const msg = makeMessage('a-1', 'assistant', [
        {
          type: 'tool',
          tool: 'task',
          state: { metadata: { sessionId: 'child-session-1' } },
        } as any,
      ]);
      const res = isSyntheticSubtaskBridgeAssistant(msg);
      expect(res.hide).toBe(true);
      expect(res.taskSessionId).toBe('child-session-1');
    });

    it('returns hide: false for normal assistant messages', () => {
      const msg = makeMessage('a-2', 'assistant', [{ type: 'text', text: 'hello' } as any]);
      expect(isSyntheticSubtaskBridgeAssistant(msg).hide).toBe(false);
    });
  });

  describe('withSubtaskSessionId', () => {
    it('injects taskSessionID into subtask parts', () => {
      const msg = makeMessage('1', 'user', [{ type: 'subtask' } as any]);
      const updated = withSubtaskSessionId(msg, 'child-123');
      expect((updated.parts[0] as any).taskSessionID).toBe('child-123');
    });

    it('returns original message if taskSessionId is null', () => {
      const msg = makeMessage('1', 'user', [{ type: 'subtask' } as any]);
      expect(withSubtaskSessionId(msg, null)).toBe(msg);
    });
  });

  describe('withShellBridgeDetails', () => {
    it('replaces synthetic /shell text with shell action', () => {
      const msg = makeMessage('1', 'user', [
        { type: 'text', text: 'The following tool was executed by the user\nls', synthetic: true } as any,
      ]);
      const updated = withShellBridgeDetails(msg, {
        command: 'ls -la',
        output: 'file.txt',
        status: 'completed',
      } as any);

      expect((updated.parts[0] as any).shellAction).toEqual({
        command: 'ls -la',
        output: 'file.txt',
        status: 'completed',
      });
    });
  });

  describe('turnContainsMessageId', () => {
    const turn = {
      turnId: 't-1',
      userMessage: makeMessage('u-1', 'user'),
      assistantMessages: [makeMessage('a-1', 'assistant'), makeMessage('a-2', 'assistant')],
      activityParts: [],
      activitySegments: [],
      hasTools: false,
      hasReasoning: false,
    } as unknown as TurnRecord;

    it('detects message in user or assistant', () => {
      expect(turnContainsMessageId(turn, 'u-1')).toBe(true);
      expect(turnContainsMessageId(turn, 'a-2')).toBe(true);
      expect(turnContainsMessageId(turn, 'unknown')).toBe(false);
      expect(turnContainsMessageId(turn, null)).toBe(false);
    });
  });
});
