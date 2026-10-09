import { describe, expect, it } from 'vitest';

import { createExtensionBridge } from './extension-bridge.js';

// Direct bridge coverage for the getEditorText() draft mirror lifecycle edges
// that the socket-level daemon tests cannot reach (disposal, untracked reset).
const createBridge = (options = {}) => {
  const published = [];
  const bridge = createExtensionBridge({
    publish: (event, payload, sessionId, directory) => published.push({ event, payload, sessionId, directory }),
    resolveDirectory: async (directory) => directory,
    redactAttachmentPaths: (value) => value,
    redactAttachmentValues: (value) => value,
    findRuntimeBySessionId: options.findRuntimeBySessionId || (() => undefined),
    getDefaultDirectory: options.getDefaultDirectory || (() => '/repo'),
    getSequence: () => 0,
    protocolError: (code, message) => Object.assign(new Error(message), { code }),
    requestSessionShutdown: () => {},
  });
  const session = options.session || { sessionId: 's1' };
  const bindings = bridge.buildExtensionBindings(session);
  const ui = bindings.uiContext;
  return { bridge, ui, bindings, published, session };
};

const trackEvents = (published) => published.filter((entry) => entry.event === 'extension.editor.track');

describe('extension bridge draft mirror', () => {
  it('disables browser sync when session extension state is cleared', () => {
    const { bridge, ui, published } = createBridge();
    ui.getEditorText();
    expect(bridge.updateExtensionDraft('s1', 'typed', 1)).toEqual({ accepted: true });

    bridge.clearExtensionState('s1');

    expect(trackEvents(published).map((entry) => entry.payload)).toEqual([{ enabled: true }, { enabled: false }]);
    expect(bridge.getSnapshotState('s1').draftTracked).toBeUndefined();
    expect(bridge.updateExtensionDraft('s1', 'late', 2)).toEqual({ accepted: false });
    expect(ui.getEditorText()).toBe('');
    // A later call opts the session back in.
    expect(trackEvents(published).at(-1).payload).toEqual({ enabled: true });
  });

  it('does not publish a disable event for sessions that never tracked', () => {
    const { bridge, published } = createBridge();
    bridge.clearExtensionState('s1');
    expect(trackEvents(published)).toEqual([]);
  });

  it('prompt reset does not allocate draft state for untracked sessions', () => {
    const { bridge, ui, published } = createBridge();
    bridge.resetExtensionDraft('s1');
    expect(ui.getEditorText()).toBe('');
    expect(bridge.getSnapshotState('s1')).toEqual({ draftTracked: true });
    expect(trackEvents(published)).toHaveLength(1);
  });
});

describe('extension bridge session directory scoping', () => {
  it('publishes session-scoped events stamped with the session runtime directory', () => {
    const { bridge, ui, published } = createBridge({
      findRuntimeBySessionId: (id) => (id === 's1' ? { cwd: '/dir-b' } : undefined),
      getDefaultDirectory: () => '/default-dir',
    });

    ui.setStatus('status-key', 'Running');
    expect(published.at(-1)).toEqual({
      event: 'extension.status',
      payload: { key: 'status-key', text: 'Running' },
      sessionId: 's1',
      directory: '/dir-b',
    });

    ui.notify('Test notification', 'warning');
    expect(published.at(-1)).toEqual({
      event: 'extension.notify',
      payload: { message: 'Test notification', level: 'warning' },
      sessionId: 's1',
      directory: '/dir-b',
    });

    ui.setWorkingMessage('working...');
    expect(published.at(-1)).toEqual({
      event: 'extension.working',
      payload: { message: 'working...' },
      sessionId: 's1',
      directory: '/dir-b',
    });

    ui.setWorkingVisible(true);
    expect(published.at(-1)).toEqual({
      event: 'extension.working',
      payload: { message: 'working...', visible: true },
      sessionId: 's1',
      directory: '/dir-b',
    });
  });
});

describe('extension bridge setWidget', () => {
  it('clears string widget on null and omits placement when clearing', () => {
    const { bridge, ui, published } = createBridge();

    ui.setWidget('w1', ['line 1'], { placement: 'belowEditor' });
    expect(published.at(-1)).toEqual({
      event: 'extension.widget',
      payload: { key: 'w1', lines: ['line 1'], placement: 'belowEditor' },
      sessionId: 's1',
      directory: '/repo',
    });
    expect(bridge.getSnapshotState('s1').widgets).toEqual([
      { key: 'w1', lines: ['line 1'], placement: 'belowEditor' },
    ]);

    // Clearing via null
    ui.setWidget('w1', null, { placement: 'belowEditor' });
    expect(published.at(-1)).toEqual({
      event: 'extension.widget',
      payload: { key: 'w1' },
      sessionId: 's1',
      directory: '/repo',
    });
    expect(bridge.getSnapshotState('s1').widgets).toBeUndefined();

    // Re-set and clear via undefined
    ui.setWidget('w1', ['line 2'], { placement: 'belowEditor' });
    ui.setWidget('w1', undefined, { placement: 'belowEditor' });
    expect(published.at(-1)).toEqual({
      event: 'extension.widget',
      payload: { key: 'w1' },
      sessionId: 's1',
      directory: '/repo',
    });
    expect(bridge.getSnapshotState('s1').widgets).toBeUndefined();
  });
});

describe('extension bridge component widget disposal', () => {
  it('returns early in scheduleComponentWidgetsRender after session extension state is cleared', async () => {
    const { bridge, ui, published } = createBridge();
    let capturedTui = null;
    let renderCount = 0;

    ui.setWidget('comp', (tui) => {
      capturedTui = tui;
      return {
        render: () => {
          renderCount += 1;
          return [`render-${renderCount}`];
        },
      };
    });

    expect(renderCount).toBe(1);
    const initialPublishCount = published.length;

    // Clear session extension state
    bridge.clearExtensionState('s1');

    // Disposed component tries to request render
    capturedTui.requestRender();

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(renderCount).toBe(1);
    expect(published.filter((p) => p.event === 'extension.widget' && p.payload.lines)).toHaveLength(1);
    expect(published.length).toBe(initialPublishCount + 1); // +1 from clearExtensionState's clearing widget event
  });
});

describe('extension bridge reload and tree navigation panel rebuilding', () => {
  it('rebuilds panels and apps from branch entries after reloadSession', async () => {
    const entries = [
      { type: 'custom', customType: 'pichamber.ui', data: { id: 'p1', title: 'Panel 1', component: 'test' } },
      { type: 'custom', customType: 'pichamber.app', data: { appId: 'a1', title: 'App 1', html: '<div>App</div>' } },
    ];
    let reloaded = false;
    const session = {
      sessionId: 's1',
      sessionManager: {
        getBranch: () => entries,
      },
      reload: async () => {
        reloaded = true;
      },
    };
    const { bridge, bindings } = createBridge({ session });

    await bindings.commandContextActions.reload();
    expect(reloaded).toBe(true);

    const snapshot = bridge.getSnapshotState('s1');
    expect(snapshot.panels).toEqual([
      { id: 'p1', title: 'Panel 1', component: 'test' },
    ]);
    expect(snapshot.apps).toEqual([
      { appId: 'a1', title: 'App 1', html: '<div>App</div>' },
    ]);
  });

  it('rebuilds panels and apps after successful navigateTree', async () => {
    const entries = [
      { type: 'custom', customType: 'pichamber.ui', data: { id: 'p2', title: 'Panel 2', component: 'test2' } },
    ];
    const session = {
      sessionId: 's1',
      sessionManager: {
        getBranch: () => entries,
      },
      navigateTree: async () => ({ cancelled: false }),
    };
    const { bridge, bindings } = createBridge({ session });

    const result = await bindings.commandContextActions.navigateTree('entry-target');
    expect(result).toEqual({ cancelled: false });

    const snapshot = bridge.getSnapshotState('s1');
    expect(snapshot.panels).toEqual([
      { id: 'p2', title: 'Panel 2', component: 'test2' },
    ]);
  });
});

