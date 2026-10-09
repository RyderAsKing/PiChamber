import { beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { createReducerPartMap, type PiReducerSessionState } from '@/lib/pi/reducers/reducerTypes';
import type { PiPendingInputSummary } from '@/lib/pi/protocol';
import type { LiveSessionRecord } from '@/sync/pi-session-catalog';
import { ExtensionPromptDock } from './ExtensionPromptDock';
import { resolveSelectKeyAction } from './extensionPromptKeys';

const catalogRow = (
  id: string,
  title: string,
  pending: PiPendingInputSummary | null,
  directory = '/repo',
): LiveSessionRecord => ({
  id,
  directory,
  parentId: null,
  title,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  lifecycle: 'idle',
  hydrated: false,
  pendingInput: pending,
});

const seedCatalogRow = (row: LiveSessionRecord): void => {
  (getPiSessionStore().getState().catalog.byId as Map<string, LiveSessionRecord>).set(row.id, row);
};

const pendingSummary = (
  count: number,
  kind: PiPendingInputSummary['kind'] = 'input',
  since = 1_700_000_000_000,
): PiPendingInputSummary => ({ count, kind, since });

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

describe('ExtensionPromptDock', () => {
  const store = getPiSessionStore();

  beforeEach(() => {
    store.clear();
  });

  test('renders nothing when there are no pending dialogs', () => {
    const markup = renderToStaticMarkup(<ExtensionPromptDock sessionId="sess-1" />);
    expect(markup).toBe('');
  });

  test('renders select dialog with aria-label on listbox and stripped title on region', () => {
    const session = createTestSession('sess-1', '/repo');
    session.extensionDialogs = [
      {
        requestId: 'req-select',
        method: 'select',
        title: '\x1b[38;2;255;100;100mChoose Mode\x1b[0m',
        message: 'Select an operating mode:',
        options: ['Fast', 'Balanced', 'Deep'],
      },
    ];
    store.getState().reducer.bySession.set('sess-1', session);
    store.getState().selectedSessionId = 'sess-1';

    const markup = renderToStaticMarkup(<ExtensionPromptDock sessionId="sess-1" />);
    expect(markup).toContain('aria-label="Choose Mode"');
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('Select an operating mode:');
    expect(markup).toContain('Fast');
    expect(markup).toContain('Balanced');
    expect(markup).toContain('Deep');
    expect(markup).toContain('role="dialog"');
    const describedBy = markup.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(markup).toContain(`id="${describedBy}"`);
    // Roving tabindex: only the highlighted option is in the tab order.
    expect(markup.match(/role="option"[^>]*tabindex="0"/g)?.length).toBe(1);
    expect(markup.match(/role="option"[^>]*tabindex="-1"/g)?.length).toBe(2);
  });

  test('renders form dialog with number min and max constraints', () => {
    const session = createTestSession('sess-1', '/repo');
    session.extensionDialogs = [
      {
        requestId: 'req-form',
        method: 'form',
        title: 'Configure Parameters',
        fields: [
          {
            id: 'concurrency',
            label: 'Concurrency Limit',
            type: 'number',
            required: true,
            min: 1,
            max: 10,
            initial: '4',
          },
        ],
      },
    ];
    store.getState().reducer.bySession.set('sess-1', session);
    store.getState().selectedSessionId = 'sess-1';

    const markup = renderToStaticMarkup(<ExtensionPromptDock sessionId="sess-1" />);
    expect(markup).toContain('aria-label="Configure Parameters"');
    expect(markup).toContain('Concurrency Limit');
    expect(markup).toContain('type="number"');
    expect(markup).toContain('min="1"');
    expect(markup).toContain('max="10"');
    expect(markup).toContain('value="4"');
  });

  test('renders confirm dialog with Yes/No buttons', () => {
    const session = createTestSession('sess-1', '/repo');
    session.extensionDialogs = [
      {
        requestId: 'req-confirm',
        method: 'confirm',
        title: 'Delete Resource?',
        message: 'Are you sure you want to proceed?',
      },
    ];
    store.getState().reducer.bySession.set('sess-1', session);
    store.getState().selectedSessionId = 'sess-1';

    const markup = renderToStaticMarkup(<ExtensionPromptDock sessionId="sess-1" />);
    expect(markup).toContain('Delete Resource?');
    expect(markup).toContain('Are you sure you want to proceed?');
    expect(markup).toContain('Yes (Y)');
    expect(markup).toContain('No (N)');
  });
});

describe('ExtensionPromptDock other-sessions strip', () => {
  beforeEach(() => {
    getPiSessionStore().clear();
  });

  test('lists another session needing input even when the current session has no dialog', () => {
    seedCatalogRow(catalogRow('sess-other', 'Fix login bug', pendingSummary(1)));
    const markup = renderToStaticMarkup(<ExtensionPromptDock sessionId="sess-current" />);
    expect(markup).toContain('aria-label="Other sessions need input"');
    expect(markup).toContain('Fix login bug');
    expect(markup).toContain('aria-label="Needs input"');
    expect(markup).toContain('aria-label="Open Fix login bug"');
    expect(markup).not.toContain('role="dialog"');
  });

  test('excludes the current session from the strip', () => {
    seedCatalogRow(catalogRow('sess-current', 'Current work', pendingSummary(1)));
    seedCatalogRow(catalogRow('sess-other', 'Other work', pendingSummary(1)));
    const markup = renderToStaticMarkup(<ExtensionPromptDock sessionId="sess-current" />);
    expect(markup).toContain('Other work');
    expect(markup).not.toContain('Current work');
  });

  test('shows request counts and collapses beyond three sessions', () => {
    seedCatalogRow(catalogRow('sess-a', 'Alpha', pendingSummary(2, 'approval', 100)));
    seedCatalogRow(catalogRow('sess-b', 'Beta', pendingSummary(1, 'input', 200)));
    seedCatalogRow(catalogRow('sess-c', 'Gamma', pendingSummary(1, 'input', 300)));
    seedCatalogRow(catalogRow('sess-d', 'Delta', pendingSummary(1, 'input', 400)));
    const markup = renderToStaticMarkup(<ExtensionPromptDock sessionId="sess-current" />);
    expect(markup).toContain('Alpha');
    expect(markup).toContain('2 requests');
    expect(markup).toContain('Needs approval (2 requests)');
    expect(markup).toContain('+1 more');
    // The fourth waiter is hidden behind the overflow line.
    expect(markup).not.toContain('Delta');
  });

  test('falls back to Untitled session for title-less rows', () => {
    seedCatalogRow(catalogRow('sess-other', '   ', pendingSummary(1)));
    const markup = renderToStaticMarkup(<ExtensionPromptDock sessionId="sess-current" />);
    expect(markup).toContain('Untitled session');
  });
});


describe('resolveSelectKeyAction', () => {
  test('navigation keys move the highlight and wrap', () => {
    expect(resolveSelectKeyAction('ArrowDown', 0, 3)).toEqual({ kind: 'highlight', index: 1 });
    expect(resolveSelectKeyAction('ArrowDown', 2, 3)).toEqual({ kind: 'highlight', index: 0 });
    expect(resolveSelectKeyAction('ArrowUp', 0, 3)).toEqual({ kind: 'highlight', index: 2 });
    expect(resolveSelectKeyAction('Home', 2, 3)).toEqual({ kind: 'highlight', index: 0 });
    expect(resolveSelectKeyAction('End', 0, 3)).toEqual({ kind: 'highlight', index: 2 });
  });

  test('Space submits the highlighted option, same as Enter', () => {
    expect(resolveSelectKeyAction('Enter', 1, 3)).toEqual({ kind: 'submit', index: 1 });
    expect(resolveSelectKeyAction(' ', 1, 3)).toEqual({ kind: 'submit', index: 1 });
  });

  test('quick keys submit only options that exist', () => {
    expect(resolveSelectKeyAction('2', 0, 3)).toEqual({ kind: 'submit', index: 1 });
    expect(resolveSelectKeyAction('4', 0, 3)).toBeNull();
    expect(resolveSelectKeyAction('0', 0, 3)).toBeNull();
  });

  test('ignores unrelated keys and empty option lists', () => {
    expect(resolveSelectKeyAction('a', 0, 3)).toBeNull();
    expect(resolveSelectKeyAction('F1', 0, 3)).toBeNull();
    expect(resolveSelectKeyAction('Enter', 0, 0)).toBeNull();
  });
});
