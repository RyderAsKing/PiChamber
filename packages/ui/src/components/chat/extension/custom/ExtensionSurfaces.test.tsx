import { beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { getPiSessionStore } from '@/apps/pi-session-store';
import type { PiExtensionSurfaceState } from '@/lib/pi/reducers/customSurfaceReducers';
import { createReducerPartMap, type PiReducerSessionState } from '@/lib/pi/reducers/reducerTypes';
import { ExtensionSurfaceComposer, ExtensionSurfaceOverlays } from './ExtensionSurfaces';

const session = (surfaces: PiExtensionSurfaceState[], extra: Partial<PiReducerSessionState> = {}): PiReducerSessionState => ({
  sessionId: 'sess-1',
  directory: '/repo',
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
  extensionSurfaces: new Map(surfaces.map((surface) => [surface.surfaceId, surface])),
  ...extra,
});

const surface = (overrides: Partial<PiExtensionSurfaceState> = {}): PiExtensionSurfaceState => ({
  surfaceId: 'custom-1',
  title: '/pick',
  mode: 'inline',
  capturing: true,
  hidden: false,
  focused: true,
  z: 1,
  frame: {
    version: 1,
    lines: ['\x1b[1mPick one\x1b[22m', '> alpha'],
    cells: [undefined, undefined],
    cursor: null,
    layout: null,
    visible: true,
    columns: 80,
    screenColumns: 120,
    rows: 30,
  },
  ...overrides,
});

const overlay = (overrides: Partial<PiExtensionSurfaceState> = {}): PiExtensionSurfaceState => {
  const base = surface({ surfaceId: 'custom-2', mode: 'overlay', title: 'Extension', z: 2 });
  return { ...base, ...overrides, frame: { ...base.frame!, layout: { row: 4, col: 10, width: 30, height: 2 }, ...overrides.frame } };
};

const seed = (surfaces: PiExtensionSurfaceState[], extra: Partial<PiReducerSessionState> = {}) => {
  getPiSessionStore().getState().reducer.bySession.set('sess-1', session(surfaces, extra));
};

const composer = () => renderToStaticMarkup(
  <ExtensionSurfaceComposer sessionId="sess-1"><textarea data-testid="chat-input" /></ExtensionSurfaceComposer>,
);

describe('ExtensionSurfaceComposer', () => {
  beforeEach(() => getPiSessionStore().clear());

  test('shows only the chat input when no surface is open', () => {
    const markup = composer();
    expect(markup).toContain('data-testid="chat-input"');
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('hidden=""');
  });

  test('an inline surface takes the composer place and keeps the input mounted', () => {
    seed([surface()]);
    const markup = composer();
    expect(markup).toContain('aria-label="Extension: /pick"');
    expect(markup).toContain('Pick one');
    expect(markup).toContain('&gt; alpha');
    expect(markup).toContain('aria-label="Close /pick"');
    expect(markup).toContain('<div hidden=""><textarea data-testid="chat-input">');
  });

  test('lists overlays this window cannot show, with Close', () => {
    seed([
      overlay({ frame: { visible: false } as PiExtensionSurfaceState['frame'] }),
      overlay({ surfaceId: 'custom-3', title: '/hidden', hidden: true }),
    ]);
    const markup = composer();
    expect(markup).toContain('Extension is hidden because the screen is too narrow.');
    expect(markup).toContain('/hidden is hidden by the extension.');
    expect(markup).not.toContain('New messages wait');
    expect(markup).not.toContain('hidden=""');
  });

  test('says messages wait while the command that opened a hidden overlay runs', () => {
    seed(
      [overlay({ frame: { visible: false } as PiExtensionSurfaceState['frame'] })],
      { lifecycle: 'busy', runningCommand: '/overlay-sidepanel' },
    );
    expect(composer()).toContain('New messages wait until it closes.');
  });

  test('turns http(s) OSC 8 hyperlinks into links, and nothing else', () => {
    const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
    seed([surface({ frame: { ...surface().frame!, lines: [link('https://auth.example/authorize?a=1&b=2', 'sign in'), link('javascript:alert(1)', 'plain')], cells: [undefined, undefined] } })]);
    const markup = composer();
    expect(markup).toContain('<a href="https://auth.example/authorize?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"');
    expect(markup).toContain('>sign in</a>');
    expect(markup).not.toContain('javascript:');
    expect(markup).toContain('plain');
  });

  test('draws wide graphemes in fixed cell boxes', () => {
    seed([surface({ frame: { ...surface().frame!, lines: ['a😀b'], cells: [{ 1: 2 }] } })]);
    expect(composer()).toContain('style="width:2ch;height:18px"');
  });
});

describe('ExtensionSurfaceOverlays', () => {
  beforeEach(() => getPiSessionStore().clear());

  test('places overlays on the pane screen and dims only for capturing ones', () => {
    seed([overlay()]);
    let markup = renderToStaticMarkup(<ExtensionSurfaceOverlays sessionId="sess-1" />);
    // Placed where the daemon put it, kept inside the pane.
    expect(markup).toContain('left:max(0px, min(10ch, 100% - 30ch - 10px));top:max(0px, min(72px, 100% - 46px));max-width:100%');
    expect(markup).toContain('width:30ch;max-width:100%;height:36px');
    expect(markup).toContain('bg-background/60');

    seed([overlay({ capturing: false, focused: false })]);
    markup = renderToStaticMarkup(<ExtensionSurfaceOverlays sessionId="sess-1" />);
    expect(markup).toContain('width:30ch');
    expect(markup).not.toContain('bg-background/60');
  });

  test('stacks the panels a command opened as tabs, with one Close for the command', () => {
    const panel = (surfaceId: string, label: string, extra: Partial<PiExtensionSurfaceState> = {}) => overlay({
      surfaceId,
      parentId: 'custom-2',
      title: '/overlay-focus',
      capturing: false,
      focused: false,
      ...extra,
      frame: { ...overlay().frame!, lines: ['╭────────╮', `│ \x1b[31m${label}\x1b[39m visible │`], cells: [undefined, undefined] },
    });
    seed([
      overlay({ title: '/overlay-focus', focused: false }),
      panel('custom-3', 'Alpha', { z: 5 }),
      panel('custom-4', 'Beta', { z: 3, focused: true }),
      panel('custom-5', 'Gamma', { z: 4 }),
    ]);
    const markup = renderToStaticMarkup(<ExtensionSurfaceOverlays sessionId="sess-1" />);
    expect(markup.match(/aria-label="Close \/overlay-focus"/g)).toHaveLength(1);
    // Tabs in the order the panels opened, named from their first line.
    expect([...markup.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((match) => match[1])).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(/aria-selected="true"[^>]*>Beta</.test(markup)).toBe(true);
    // Only the command's overlay and the focused panel draw content.
    expect(markup.match(/data-extension-surface=/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Extension: /overlay-focus, Beta"');
  });

  test('leaves a single panel where Pi puts it, without tabs', () => {
    seed([overlay({ title: '/demo' }), overlay({ surfaceId: 'custom-3', parentId: 'custom-2', capturing: false, focused: false, z: 3 })]);
    const markup = renderToStaticMarkup(<ExtensionSurfaceOverlays sessionId="sess-1" />);
    expect(markup).not.toContain('role="tablist"');
    expect(markup.match(/data-extension-surface=/g)).toHaveLength(2);
  });

  test('renders nothing for inline-only or unshown overlays', () => {
    seed([surface(), overlay({ hidden: true })]);
    expect(renderToStaticMarkup(<ExtensionSurfaceOverlays sessionId="sess-1" />)).toBe('');
  });
});
