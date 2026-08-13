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
      createdAt: 10,
      streaming: false,
      thinking: 'consider options',
      text: 'hello',
      parts: [
        { id: 'p1', type: 'text', text: 'hello', streaming: false },
        { id: 'p2', type: 'thinking', text: 'hidden', streaming: false },
        { id: 'p3', type: 'attachment', text: '', streaming: false, attachment: { id: 'a1', name: 'note.txt', mime: 'text/plain', size: 0 } },
        { id: 'p4', type: 'tool', text: '', streaming: false, tool: { name: 'read', toolCallId: 'c1', state: 'completed', output: 'ok' } },
      ],
    };
    const record = piMessageToRecord(message, 'ses_1');
    expect(record.info.role).toBe('assistant');
    expect(record.parts.some((part) => part.type === 'reasoning' && part.text === 'consider options')).toBe(true);
    expect(record.parts.some((part) => part.type === 'file' && part.filename === 'note.txt')).toBe(true);
    expect(record.parts.some((part) => part.type === 'tool' && part.tool === 'read')).toBe(true);
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
