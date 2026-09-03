import { describe, expect, test } from 'bun:test';
import {
  catalogLifecycleFromReducer,
  lifecycleFromEvent,
  asError,
  isInvalidSessionError,
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
    const runtimeConflict = new PiRequestError(
      'SESSION_RUNTIME_CONFLICT',
      'Conflict'
    );
    const generic = new Error('Generic');

    expect(isInvalidSessionError(invalidSession)).toBe(true);
    expect(isInvalidSessionError(generic)).toBe(false);

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
