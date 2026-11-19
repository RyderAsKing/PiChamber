import { describe, expect, it } from 'vitest';

import {
  COMPOSER_CONTROL_EVENT,
  MAX_CONTROLS_PER_SESSION,
  createComposerControls,
  createComposerControlsExtension,
  isComposerControlsExtensionPath,
  parseComposerControl,
} from './extension-controls.js';
import { commandName } from '../extension-commands.js';

const MODES = {
  id: 'mode',
  kind: 'cycle',
  label: 'Mode',
  value: 'balance',
  options: [
    { value: 'economy', label: 'Economy', command: 'economy' },
    { value: 'balance', label: 'Balance', command: '/balance' },
    { value: 'premium', label: 'Premium', command: 'premium' },
  ],
};

describe('parseComposerControl', () => {
  it('keeps a cycle control and strips the slash from commands', () => {
    expect(parseComposerControl(MODES)).toEqual({
      id: 'mode',
      kind: 'cycle',
      label: 'Mode',
      value: 'balance',
      options: [
        { value: 'economy', label: 'Economy', command: 'economy' },
        { value: 'balance', label: 'Balance', command: 'balance' },
        { value: 'premium', label: 'Premium', command: 'premium' },
      ],
    });
  });

  it('keeps toggles and actions, with optional description and icon', () => {
    expect(parseComposerControl({ id: 'plan', kind: 'toggle', label: 'Plan', value: true, command: 'plan', icon: 'list-check-3', description: 'Read-only planning' }))
      .toEqual({ id: 'plan', kind: 'toggle', label: 'Plan', value: true, command: 'plan', icon: 'list-check-3', description: 'Read-only planning' });
    // A toggle without a boolean value is off.
    expect(parseComposerControl({ id: 'plan', kind: 'toggle', label: 'Plan', command: 'plan' })).toMatchObject({ value: false });
    expect(parseComposerControl({ id: 'review', kind: 'action', label: 'Review', command: 'review --staged' }))
      .toEqual({ id: 'review', kind: 'action', label: 'Review', command: 'review --staged' });
  });

  it('reads a removal', () => {
    expect(parseComposerControl({ id: 'mode', remove: true })).toEqual({ id: 'mode', remove: true });
    expect(parseComposerControl({ id: 'mode', removed: true })).toEqual({ id: 'mode', remove: true });
  });

  it('drops a cycle value that is not one of its options', () => {
    expect(parseComposerControl({ ...MODES, value: 'turbo' })).not.toHaveProperty('value');
  });

  it('cleans text and ignores a bad icon name', () => {
    const control = parseComposerControl({ id: 'plan', kind: 'toggle', label: ' Plan\nmode ', command: 'plan', icon: '../x' });
    expect(control).toMatchObject({ label: 'Plan mode' });
    expect(control).not.toHaveProperty('icon');
  });

  it('rejects unusable payloads', () => {
    for (const bad of [
      null,
      'mode',
      { ...MODES, id: 'Mode' },
      { ...MODES, id: 'x'.repeat(41) },
      { ...MODES, kind: 'slider' },
      { ...MODES, label: '  ' },
      { ...MODES, options: [MODES.options[0]] },
      { ...MODES, options: [MODES.options[0], MODES.options[0]] },
      { ...MODES, options: [MODES.options[0], { value: 'x', label: 'X', command: '' }] },
      { id: 'plan', kind: 'toggle', label: 'Plan' },
      { id: 'plan', kind: 'toggle', label: 'Plan', command: 'bad;name' },
      { id: 'run', kind: 'action', label: 'Run', command: '/' },
    ]) {
      expect(parseComposerControl(bad)).toBeNull();
    }
  });
});

describe('commandName and the listener path', () => {
  it('reads the invocation name and recognises the listener', () => {
    expect(commandName('review --staged')).toBe('review');
    expect(isComposerControlsExtensionPath('<inline:pichamber:composer-controls>')).toBe(true);
    expect(isComposerControlsExtensionPath('<inline:pichamber:visuals>')).toBe(false);
  });
});

describe('createComposerControls', () => {
  const setup = () => {
    const published = [];
    const controls = createComposerControls({ publish: (sessionId, payload) => published.push([sessionId, payload]) });
    return { controls, published };
  };

  it('stores, replaces, publishes, and removes a session\'s controls', () => {
    const { controls, published } = setup();
    expect(controls.set('s1', MODES)).toBe(true);
    expect(controls.set('s1', { ...MODES, value: 'premium' })).toBe(true);
    expect(controls.snapshot('s1')).toEqual([expect.objectContaining({ id: 'mode', value: 'premium' })]);
    expect(controls.snapshot('s2')).toBeUndefined();
    expect(controls.set('s1', { id: 'mode', remove: true })).toBe(true);
    // Removing what is not there publishes nothing.
    expect(controls.set('s1', { id: 'mode', remove: true })).toBe(false);
    expect(controls.snapshot('s1')).toBeUndefined();
    expect(published.map(([sessionId, payload]) => [sessionId, payload.control?.value ?? payload])).toEqual([
      ['s1', 'balance'],
      ['s1', 'premium'],
      ['s1', { id: 'mode', removed: true }],
    ]);
  });

  it('ignores invalid payloads and controls past the cap', () => {
    const { controls, published } = setup();
    expect(controls.set('s1', { id: 'bad' })).toBe(false);
    expect(controls.set('', MODES)).toBe(false);
    for (let index = 0; index < MAX_CONTROLS_PER_SESSION; index += 1) {
      expect(controls.set('s1', { id: `a${index}`, kind: 'action', label: 'A', command: 'a' })).toBe(true);
    }
    expect(controls.set('s1', { id: 'one-more', kind: 'action', label: 'A', command: 'a' })).toBe(false);
    // An existing control can still change.
    expect(controls.set('s1', { id: 'a0', kind: 'action', label: 'B', command: 'b' })).toBe(true);
    expect(published).toHaveLength(MAX_CONTROLS_PER_SESSION + 1);
  });

  it('clears a session and tells clients about each control', () => {
    const { controls, published } = setup();
    controls.set('s1', MODES);
    controls.set('s1', { id: 'plan', kind: 'toggle', label: 'Plan', command: 'plan' });
    controls.set('s2', MODES);
    published.length = 0;
    controls.clear('s1');
    controls.clear('s1');
    expect(published).toEqual([['s1', { id: 'mode', removed: true }], ['s1', { id: 'plan', removed: true }]]);
    expect(controls.sessionIds()).toEqual(['s2']);
  });

  it('resolves a click to a command, and to none when the value is already set', () => {
    const { controls } = setup();
    controls.set('s1', MODES);
    controls.set('s1', { id: 'plan', kind: 'toggle', label: 'Plan', command: 'plan', value: false });
    controls.set('s1', { id: 'review', kind: 'action', label: 'Review', command: 'review --staged' });
    expect(controls.resolve('s1', 'mode', 'premium')).toMatchObject({ command: 'premium' });
    expect(controls.resolve('s1', 'mode', 'balance')).toMatchObject({ command: null });
    expect(controls.resolve('s1', 'mode', 'turbo')).toEqual({ error: 'INVALID_ARGUMENT' });
    expect(controls.resolve('s1', 'plan', true)).toMatchObject({ command: 'plan' });
    expect(controls.resolve('s1', 'plan', false)).toMatchObject({ command: null });
    expect(controls.resolve('s1', 'plan', 'yes')).toEqual({ error: 'INVALID_ARGUMENT' });
    expect(controls.resolve('s1', 'review')).toMatchObject({ command: 'review --staged' });
    expect(controls.resolve('s1', 'gone', true)).toEqual({ error: 'CONTROL_NOT_FOUND' });
    expect(controls.resolve('s2', 'mode', 'premium')).toEqual({ error: 'CONTROL_NOT_FOUND' });
  });
});

describe('createComposerControlsExtension', () => {
  const fakePi = () => {
    const listeners = new Map();
    const handlers = new Map();
    return {
      events: { on: (event, listener) => listeners.set(event, listener), emit: (event, data) => listeners.get(event)?.(data) },
      on: (event, handler) => handlers.set(event, handler),
      start: (sessionId) => handlers.get('session_start')?.({ type: 'session_start' }, { sessionManager: { getSessionId: () => sessionId } }),
    };
  };

  it('holds controls emitted before session_start, then forwards them with the session id', () => {
    const received = [];
    const extension = createComposerControlsExtension((sessionId, data) => received.push([sessionId, data.id]));
    expect(extension).toMatchObject({ name: 'pichamber:composer-controls', hidden: true });
    const pi = fakePi();
    extension.factory(pi);
    pi.events.emit(COMPOSER_CONTROL_EVENT, { id: 'early' });
    expect(received).toEqual([]);
    pi.start('s1');
    pi.events.emit(COMPOSER_CONTROL_EVENT, { id: 'late' });
    pi.events.emit('other:event', { id: 'ignored' });
    expect(received).toEqual([['s1', 'early'], ['s1', 'late']]);
  });

  it('listens on pichamber.composer only', () => {
    const received = [];
    const extension = createComposerControlsExtension((sessionId, data) => received.push([sessionId, data.id]));
    const pi = fakePi();
    extension.factory(pi);
    pi.start('s1');
    expect(COMPOSER_CONTROL_EVENT).toBe('pichamber.composer');
    pi.events.emit('pichamber.composer', { id: 'current' });
    pi.events.emit('pichamber:composer', { id: 'retired' });
    expect(received).toEqual([['s1', 'current']]);
  });
});
