import { beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { createReducerPartMap, type PiReducerSessionState } from '@/lib/pi/reducers/reducerTypes';
import { ExtensionsSurface } from './ExtensionsSurface';

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

describe('ExtensionsSurface', () => {
  const store = getPiSessionStore();

  beforeEach(() => {
    store.clear();
  });

  test('renders empty state when session has no widgets', () => {
    const markup = renderToStaticMarkup(<ExtensionsSurface sessionId="sess-empty" />);
    expect(markup).toContain('No extensions installed');
    expect(markup).toContain('data-testid="extensions-surface-empty"');
  });

  test('renders ctx.ui.setWidget content with preserved truecolor', () => {
    const session = createTestSession('sess-1', '/repo');
    session.extensionWidgets.set('git-status-widget', {
      lines: ['\x1b[38;2;255;100;100m3 files changed\x1b[0m', 'Branch: main'],
      placement: 'belowEditor',
    });
    store.getState().reducer.bySession.set('sess-1', session);

    const markup = renderToStaticMarkup(<ExtensionsSurface sessionId="sess-1" />);
    expect(markup).toContain('aria-label="Widgets"');
    expect(markup).toContain('Git Status Widget');
    expect(markup).toContain('below editor');
    expect(markup).toContain('3 files changed');
    expect(markup).toContain('color:rgb(255, 100, 100)');
    expect(markup).toContain('Branch: main');
    expect(markup).not.toContain('\x1b');
  });

  test('does not render statuses, panels, or apps', () => {
    const session = createTestSession('sess-2', '/repo');
    session.extensionStatuses.set('token-speed', 'TPS: 54.2 tok/s');
    session.extensionPanels.set('panel-1', {
      id: 'panel-1',
      title: 'Indexing Status',
      component: 'progress',
      props: { label: 'Building Index', value: 45, max: 100 },
    });
    session.extensionApps.set('app-preview', {
      appId: 'app-preview',
      title: 'Preview App',
      html: '<p>Interactive App</p>',
    });
    store.getState().reducer.bySession.set('sess-2', session);

    const markup = renderToStaticMarkup(<ExtensionsSurface sessionId="sess-2" />);
    expect(markup).toContain('data-testid="extensions-surface-empty"');
    expect(markup).not.toContain('TPS:');
    expect(markup).not.toContain('Indexing Status');
    expect(markup).not.toContain('iframe');
  });
});
