import { describe, expect, test } from 'bun:test';

import type { PiProjectedMessage, PiProjectedSession } from '@/lib/pi/event-reducer';
import { piMessageToRecord, piProjectedToRecords, piSessionToUiSession } from './pi-to-renderable';
import type { PiSession } from '@/lib/pi/types';

const session: PiSession = {
  id: 'ses_1',
  directory: '/repo',
  title: 'Demo',
  createdAt: 1,
  updatedAt: 2,
  archived: false,
};

describe('pi-to-renderable', () => {
  test('maps Pi session metadata onto the restored Session shape', () => {
    const ui = piSessionToUiSession(session);
    expect(ui.id).toBe('ses_1');
    expect(ui.directory).toBe('/repo');
    expect(ui.title).toBe('Demo');
    expect(ui.time?.created).toBe(1);
    expect(ui.time?.updated).toBe(2);
  });

  test('maps thinking to reasoning and attachment to file parts', () => {
    const message: PiProjectedMessage = {
      id: 'msg_1',
      role: 'assistant',
      parentId: 'user_1',
      createdAt: 10,
      streaming: false,
      thinking: 'consider options',
      text: 'hello',
      parts: [
        { id: 'p1', type: 'text', text: 'hello', streaming: false },
        { id: 'p2', type: 'thinking', text: 'consider options', streaming: false },
        { id: 'p3', type: 'attachment', text: '', streaming: false, attachment: { id: 'a1', name: 'note.txt', mime: 'text/plain', size: 0 } },
        { id: 'p4', type: 'tool', text: '', streaming: false, tool: { name: 'read', toolCallId: 'c1', state: 'completed', output: 'ok', input: { path: 'a.txt' }, error: 'boom', metadata: { truncation: { truncated: false } }, startedAt: 5, endedAt: 9 } },
      ],
    };
    const record = piMessageToRecord(message, 'ses_1');
    expect(record.info.role).toBe('assistant');
    expect(record.info.parentID).toBe('user_1');
    expect(record.parts.filter((part) => part.type === 'reasoning')).toHaveLength(1);
    expect(record.parts.some((part) => part.type === 'reasoning' && part.text === 'consider options')).toBe(true);
    expect(record.parts.some((part) => part.type === 'file' && part.filename === 'note.txt')).toBe(true);
    expect(record.parts.some((part) => part.type === 'tool' && part.tool === 'read')).toBe(true);
    const toolPart = record.parts.find((part) => part.type === 'tool');
    expect(toolPart?.state).toEqual({
      status: 'completed',
      input: { path: 'a.txt' },
      output: 'ok',
      error: 'boom',
      time: { start: 5, end: 9 },
      metadata: { truncation: { truncated: false } },
    });
  });

  test('falls back to message thinking and text when parts list is empty', () => {
    const message: PiProjectedMessage = {
      id: 'msg_fallback',
      role: 'assistant',
      createdAt: 10,
      streaming: false,
      thinking: 'fallback thinking',
      text: 'fallback text',
      parts: [],
    };
    const record = piMessageToRecord(message, 'ses_1');
    expect(record.parts).toHaveLength(2);
    expect(record.parts[0]).toEqual({ id: 'msg_fallback:thinking', type: 'reasoning', text: 'fallback thinking' });
    expect(record.parts[1]).toEqual({ id: 'msg_fallback:text', type: 'text', text: 'fallback text' });
  });

  test('maps a running tool to the running status and a cancelled tool stays cancelled', () => {
    const running: PiProjectedMessage = {
      id: 'msg_2', role: 'assistant', createdAt: 1, streaming: true, text: '', thinking: '',
      parts: [{ id: 'r', type: 'tool', text: '', streaming: true, tool: { name: 'bash', toolCallId: 'c2', state: 'running', input: { command: 'ls' } } }],
    };
    const cancelled: PiProjectedMessage = {
      id: 'msg_3', role: 'assistant', createdAt: 1, streaming: false, text: '', thinking: '',
      parts: [{ id: 'c', type: 'tool', text: '', streaming: false, tool: { name: 'bash', toolCallId: 'c3', state: 'cancelled' } }],
    };
    expect((piMessageToRecord(running, 'ses_1').parts[0] as { state?: { status?: string } }).state?.status).toBe('running');
    expect((piMessageToRecord(cancelled, 'ses_1').parts[0] as { state?: { status?: string } }).state?.status).toBe('cancelled');
  });

  test('returns an empty list for a missing projected session instead of fabricating idle history', () => {
    expect(piProjectedToRecords(null)).toEqual([]);
  });

  test('projects every message in a session', () => {
    const projected: PiProjectedSession = {
      sessionId: 'ses_1',
      directory: '/repo',
      lifecycle: 'idle',
      queue: { steering: 0, followUp: 0 },
      messages: [
        { id: 'u1', role: 'user', createdAt: 1, streaming: false, text: 'hi', thinking: '', parts: [{ id: 't', type: 'text', text: 'hi', streaming: false }] },
      ],
    };
    expect(piProjectedToRecords(projected)).toHaveLength(1);
  });
});
