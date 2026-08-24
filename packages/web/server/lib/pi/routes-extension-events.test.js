import { describe, expect, it } from 'vitest';

import { projectEventFrame } from './routes.js';

const frame = (event, payload, sequence = 1) => ({
  protocolVersion: 1,
  kind: 'event',
  event,
  sequence,
  payload: { sessionId: 'sess-1', directory: '/work', ...payload },
});

describe('projectEventFrame extension panels and apps', () => {
  it('projects extension.ui panels with caps and removals', () => {
    const projected = projectEventFrame(frame('extension.ui', {
      id: 'subagents',
      title: 'Sub-agents',
      component: 'table',
      props: { columns: ['Agent'], rows: [['research']] },
      actions: [{ label: 'Clear', command: 'agents-clear' }],
    }));
    expect(projected).toMatchObject({
      name: 'extension.ui',
      payload: { id: 'subagents', title: 'Sub-agents', component: 'table' },
    });

    // Missing component and title is treated as an unregister.
    expect(projectEventFrame(frame('extension.ui', { id: 'gone' }))).toMatchObject({
      payload: { id: 'gone', removed: true },
    });

    // Invalid ids are dropped entirely.
    expect(projectEventFrame(frame('extension.ui', { id: '' }))).toBeNull();
    expect(projectEventFrame(frame('extension.ui', { id: `${'x'.repeat(200)}` }))).toBeNull();
  });

  it('projects extension.app payloads and rejects oversized html', () => {
    const projected = projectEventFrame(frame('extension.app', {
      appId: 'board',
      title: 'Board',
      html: '<button data-pichamber-command="run">Run</button>',
    }));
    expect(projected?.payload).toMatchObject({ appId: 'board', title: 'Board' });
    expect(projected?.payload.html).toContain('data-pichamber-command');

    expect(projectEventFrame(frame('extension.app', {
      appId: 'big',
      html: `${'<a>'.repeat(70_000)}`,
    }))).toBeNull();

    expect(projectEventFrame(frame('extension.app', { appId: 'gone', removed: true }))?.payload).toMatchObject({
      appId: 'gone',
      removed: true,
    });
  });

  it('projects form dialogs with sanitized fields', () => {
    const projected = projectEventFrame(frame('extension.dialog', {
      requestId: 'form-1',
      method: 'form',
      title: 'Spawn agent',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        { id: 'level', label: 'Level', type: 'select', options: ['low', 'high'], initial: 'high' },
        { id: 'bad' },
        null,
      ],
    }));
    expect(projected?.payload.method).toBe('form');
    expect(projected?.payload.fields).toHaveLength(2);
    expect(projected?.payload.fields[0]).toMatchObject({ id: 'name', type: 'text', required: true });
    expect(projected?.payload.fields[1]).toMatchObject({ id: 'level', initial: 'high', options: ['low', 'high'] });

    expect(projectEventFrame(frame('extension.dialog.dismiss', {
      requestId: 'form-1',
      reason: 'timeout',
    }))?.payload).toEqual({ requestId: 'form-1', reason: 'timeout' });
    expect(projectEventFrame(frame('extension.dialog.dismiss', {
      requestId: 'form-1',
      reason: 'invented',
    }))).toBeNull();

    // Unknown dialog methods fail closed: the frame is dropped.
    expect(projectEventFrame(frame('extension.dialog', {
      requestId: 'r1',
      method: 'hologram',
      title: '?',
    }))).toBeNull();
  });

  it('projects snapshot extensionPanels/extensionApps for reconnect', () => {
    const projected = projectEventFrame(frame('session.snapshot', {
      isStreaming: false,
      lifecycle: 'idle',
      queue: { steering: 0, followUp: 0 },
      lastSequence: 5,
      extensionStatuses: [{ key: 'mode', text: 'economy' }],
      extensionPanels: [{ id: 'panel-1', component: 'progress', props: { value: 50 } }],
      extensionApps: [{ appId: 'app-1', html: '<p>x</p>' }],
      extensionDialogs: [{
        requestId: 'form-1',
        method: 'form',
        title: 'Form',
        fields: [{ id: 'a', label: 'A', type: 'text' }],
      }],
    }));
    const snapshot = projected?.payload.snapshot;
    expect(snapshot.extensionPanels).toHaveLength(1);
    expect(snapshot.extensionApps).toHaveLength(1);
    expect(snapshot.extensionDialogs[0].fields).toHaveLength(1);
  });
});
