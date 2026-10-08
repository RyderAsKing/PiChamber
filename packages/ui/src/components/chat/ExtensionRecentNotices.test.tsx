import { beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { createReducerPartMap, type PiReducerSessionState } from '@/lib/pi/reducers/reducerTypes';
import type { PiReducerExtensionNotice } from '@/lib/pi/reducers/reducerTypes';
import {
  EXTENSION_NOTICES_SEEN_KEY,
  markExtensionNoticesSeen,
  safeRuntimeKeyForNotices,
} from '@/lib/pi/extensionNotices';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { ExtensionNoticeList, ExtensionRecentNotices } from './ExtensionStatusWidgets';

const createTestSession = (sessionId: string, directory = '/repo'): PiReducerSessionState => ({
  sessionId,
  directory,
  lastSequence: 0,
  lifecycle: 'idle',
  messages: new Map(),
  partOrder: new Map(),
  parts: createReducerPartMap(),
  toolsByCallId: new Map(),
  streamingMessages: new Set(),
  queue: { steering: 0, followUp: 0 },
  extensionStatuses: new Map(),
  extensionWidgets: new Map(),
  extensionDialogs: [],
  extensionNotices: [],
  extensionErrors: [],
  extensionPanels: new Map(),
  extensionApps: new Map(),
});

const liveNotice = (
  id: string,
  createdAt: number,
  level: PiReducerExtensionNotice['level'] = 'info',
  origin: PiReducerExtensionNotice['origin'] = 'live',
): PiReducerExtensionNotice => ({
  id,
  message: `notice ${id}`,
  level,
  createdAt,
  origin,
  serverTimestamp: true,
});

const seedSession = (session: PiReducerSessionState): void => {
  const store = getPiSessionStore();
  store.getState().reducer.bySession.set(session.sessionId, session);
  store.getState().selectedSessionId = session.sessionId;
};

describe('ExtensionRecentNotices', () => {
  const store = getPiSessionStore();

  beforeEach(() => {
    store.clear();
    try {
      getSafeStorage().removeItem(EXTENSION_NOTICES_SEEN_KEY);
    } catch {
      // No storage in this environment; helpers already tolerate that.
    }
  });

  test('renders nothing with zero notices', () => {
    seedSession(createTestSession('sess-1'));
    expect(renderToStaticMarkup(<ExtensionRecentNotices sessionId="sess-1" />)).toBe('');
  });

  test('renders nothing without a session', () => {
    expect(renderToStaticMarkup(<ExtensionRecentNotices sessionId={null} />)).toBe('');
  });

  test('shows the unread dot and count-aware label while unseen', () => {
    const now = Date.now();
    const session = createTestSession('sess-1');
    session.extensionNotices = [liveNotice('n1', now - 60_000), liveNotice('n2', now - 30_000)];
    seedSession(session);

    const markup = renderToStaticMarkup(<ExtensionRecentNotices sessionId="sess-1" />);
    expect(markup).toContain('aria-label="Recent notices, 2 unread"');
    expect(markup).toContain('2 notices');
    expect(markup).toContain('bg-[var(--status-info)]');
    // The popover stays closed until the user opens it.
    expect(markup).not.toContain('role="dialog"');
  });

  test('hides the dot once every notice is seen', () => {
    const now = Date.now();
    const session = createTestSession('sess-1');
    session.extensionNotices = [liveNotice('n1', now - 60_000, 'warning', 'history')];
    seedSession(session);
    markExtensionNoticesSeen(safeRuntimeKeyForNotices(), 'sess-1', now);

    const markup = renderToStaticMarkup(<ExtensionRecentNotices sessionId="sess-1" />);
    expect(markup).toContain('aria-label="Recent notices"');
    expect(markup).not.toContain('unread');
    expect(markup).not.toContain('bg-[var(--status-info)]');
  });

  test('tolerates malformed seen storage', () => {
    const session = createTestSession('sess-1');
    session.extensionNotices = [liveNotice('n1', Date.now() - 10_000)];
    seedSession(session);
    getSafeStorage().setItem(EXTENSION_NOTICES_SEEN_KEY, 'garbage{{{');

    const markup = renderToStaticMarkup(<ExtensionRecentNotices sessionId="sess-1" />);
    expect(markup).toContain('aria-label="Recent notices, 1 unread"');
  });
});

describe('ExtensionNoticeList', () => {
  test('lists newest first with level styling and relative time', () => {
    const now = Date.now();
    const notices = [
      { ...liveNotice('older', now - 5 * 60_000, 'info'), message: 'first happened' },
      { ...liveNotice('newer', now - 60_000, 'error'), message: 'second happened' },
    ];
    const markup = renderToStaticMarkup(<ExtensionNoticeList notices={notices} />);
    // Newest first.
    expect(markup.indexOf('second happened')).toBeLessThan(markup.indexOf('first happened'));
    // Error level icon/color via status tokens.
    expect(markup).toContain('text-[var(--status-error)]');
    expect(markup).toContain('text-[var(--status-info)]');
    // Selectable message text and relative timestamps.
    expect(markup).toContain('select-text');
    expect(markup).toContain('1 min ago');
    expect(markup).toContain('5 min ago');
  });
});
