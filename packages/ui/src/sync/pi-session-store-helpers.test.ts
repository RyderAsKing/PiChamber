import { describe, expect, test } from 'bun:test';
import {
  catalogLifecycleFromReducer,
  lifecycleFromEvent,
  asError,
  isInvalidSessionError,
  isSessionInUseError,
  isSessionRuntimeConflictError,
  createRecordFromPiSession,
  mergeHydratedSession,
} from './pi-session-store-helpers';
import { initialCatalog } from './pi-session-catalog';
import { PiRequestError } from '@/lib/pi/client';
import type { PiSession } from '@/lib/pi/types';
import { hydrateSessionFromDetail } from '@/lib/pi/event-reducer';

describe('pi-session-store-helpers', () => {
  test('maps reducer lifecycle to catalog lifecycle', () => {
    expect(catalogLifecycleFromReducer('busy')).toBe('busy');
    expect(catalogLifecycleFromReducer('retry')).toBe('retry');
    expect(catalogLifecycleFromReducer('error')).toBe('error');
    expect(catalogLifecycleFromReducer('idle')).toBe('idle');
    expect(catalogLifecycleFromReducer('interrupted')).toBe('idle');
  });

  test('maps events to catalog lifecycle', () => {
    expect(
      lifecycleFromEvent({
        name: 'session.lifecycle',
        payload: { state: 'busy' },
      })
    ).toBe('busy');
    expect(
      lifecycleFromEvent({
        name: 'assistant.message.start',
        payload: {},
      })
    ).toBe('busy');
    expect(
      lifecycleFromEvent({
        name: 'session.error',
        payload: {},
      })
    ).toBe('error');
    expect(
      lifecycleFromEvent({
        name: 'message.part.delta',
        payload: {},
      })
    ).toBe(undefined);
  });

  test('identifies specific PiRequestError types', () => {
    const invalidSession = new PiRequestError('INVALID_SESSION', 'Not found');
    const sessionInUse = new PiRequestError('SESSION_IN_USE', 'In use');
    const runtimeConflict = new PiRequestError(
      'SESSION_RUNTIME_CONFLICT',
      'Conflict'
    );
    const generic = new Error('Generic');

    expect(isInvalidSessionError(invalidSession)).toBe(true);
    expect(isInvalidSessionError(generic)).toBe(false);

    expect(isSessionInUseError(sessionInUse)).toBe(true);
    expect(isSessionInUseError(generic)).toBe(false);

    expect(isSessionRuntimeConflictError(runtimeConflict)).toBe(true);
    expect(isSessionRuntimeConflictError(generic)).toBe(false);

    expect(asError(invalidSession)).toBe(invalidSession);
    expect(asError(generic).code).toBe('DAEMON_REQUEST_FAILED');
  });

  test('creates live session record from PiSession', () => {
    const session: PiSession = {
      id: 'session-123',
      directory: '/workspace/app',
      title: 'Test Session',
      createdAt: 1000,
      updatedAt: 2000,
      messageCount: 5,
    };
    const record = createRecordFromPiSession(session, initialCatalog());
    expect(record.id).toBe('session-123');
    expect(record.directory).toBe('/workspace/app');
    expect(record.title).toBe('Test Session');
    expect(record.archived).toBe(false);
    expect(record.lifecycle).toBe('idle');
  });

  test('preserves loaded older pages when a reconnect refreshes a bounded tail', () => {
    const detail = (id: string, createdAt: number, hasMoreBefore: boolean, beforeCursor?: string) => ({
      session: { id: 'session-1', directory: '/dir', createdAt: 1, updatedAt: 1 },
      lastSequence: 5,
      hasMoreBefore,
      ...(beforeCursor ? { beforeCursor } : {}),
      messages: [{
        message: { id, sessionId: 'session-1', directory: '/dir', role: 'user' as const, text: id, createdAt },
        parts: [{ id: `${id}:text`, index: 0, type: 'text' as const, text: id }],
      }],
    });
    const existing = hydrateSessionFromDetail(detail('old', 1, false)).session;
    const fetched = hydrateSessionFromDetail(detail('new', 2, true, 'new')).session;

    const merged = mergeHydratedSession(fetched, existing);

    expect([...merged.messages.keys()]).toEqual(['new', 'old']);
    expect(merged.hasMoreBefore).toBe(false);
    expect(merged.beforeCursor).toBe(undefined);
  });

  test('preserves an older paged tool result across reconnect tail hydration', () => {
    const baseSession = { id: 'session-1', directory: '/dir', createdAt: 1, updatedAt: 1 };
    const existing = hydrateSessionFromDetail({
      session: baseSession,
      lastSequence: 4,
      hasMoreBefore: false,
      messages: [{
        message: {
          id: 'assistant-old', sessionId: 'session-1', directory: '/dir', role: 'assistant' as const,
          text: '', thinking: '', createdAt: 1,
        },
        parts: [{
          id: 'assistant-old:tool:call-1', index: 0, type: 'tool' as const,
          toolCallId: 'call-1', name: 'read', output: 'complete output', state: 'completed' as const,
        }],
      }],
    }).session;
    const fetched = hydrateSessionFromDetail({
      session: baseSession,
      lastSequence: 5,
      hasMoreBefore: true,
      beforeCursor: 'user-new',
      messages: [{
        message: {
          id: 'user-new', sessionId: 'session-1', directory: '/dir', role: 'user' as const,
          text: 'new', createdAt: 2,
        },
        parts: [],
      }],
    }).session;

    const merged = mergeHydratedSession(fetched, existing);

    expect(merged.parts.get('assistant-old:tool:call-1')?.tool?.output).toBe('complete output');
    expect(merged.hasMoreBefore).toBe(false);
  });

  test('merges hydrated session preserving live turn state', () => {
    const fetchedDetail = {
      session: {
        id: 'session-1',
        directory: '/dir',
        createdAt: 1000,
        updatedAt: 1000,
      },
      lastSequence: 5,
      messages: [],
    };
    const fetched = hydrateSessionFromDetail(fetchedDetail).session;
    const existing = {
      ...fetched,
      lifecycle: 'busy' as const,
      lastSequence: 7,
    };
    const merged = mergeHydratedSession(fetched, existing);
    expect(merged.lifecycle).toBe('busy');
    expect(merged.lastSequence).toBe(7);
  });
});
