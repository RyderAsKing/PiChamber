import { describe, expect, it } from 'vitest';

import { subscribeMergedPiEvents } from './merged-event-stream.js';

const frame = (sessionId, sequence, directory = '/a') => ({
  protocolVersion: 1, kind: 'event', name: 'message.delta', sequence, sessionId, directory, streamEpoch: 'epoch-box', payload: {},
});

const fakeRuntime = () => {
  const runtime = {
    emit: null,
    subscribe: async ({ onEvent }) => {
      runtime.emit = onEvent;
      return () => {};
    },
  };
  return runtime;
};

const open = async ({ ownsSession } = {}) => {
  const main = fakeRuntime();
  const box = fakeRuntime();
  const events = [];
  const pool = {
    main: () => main,
    live: () => [{ key: 'main', runtime: main }, { key: 'sandbox:proj-a', runtime: box }],
    onChange: () => () => {},
    onMove: () => () => {},
  };
  await subscribeMergedPiEvents({
    pool,
    projectFrame: (value) => value,
    onEvent: (event) => events.push(event),
    onError: () => {},
    ...(ownsSession ? { ownsSession } : {}),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { box, events };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('a project daemon\'s frames', () => {
  it('are delivered only for sessions the server finds in that daemon\'s folders', async () => {
    const asked = [];
    const { box, events } = await open({
      ownsSession: async (key, sessionId, directory) => {
        asked.push([key, sessionId, directory]);
        await new Promise((resolve) => setTimeout(resolve, 2));
        return sessionId === 's-own';
      },
    });

    // The sandbox daemon reports on another project's session between two
    // frames of its own.
    box.emit(frame('s-own', 1));
    box.emit(frame('s-foreign', 2));
    box.emit(frame('s-own', 3));
    await settle();
    box.emit(frame('s-foreign', 4));
    box.emit(frame('s-own', 5));

    expect(events.map((event) => [event.sessionId, event.sequence])).toEqual([['s-own', 1], ['s-own', 3], ['s-own', 5]]);
    // Asked once per session, with the daemon's key.
    expect(asked).toEqual([['sandbox:proj-a', 's-own', '/a'], ['sandbox:proj-a', 's-foreign', '/a']]);
    // The cursor still moves past the dropped frames.
    const cursor = JSON.parse(Buffer.from(events.at(-1).cursor, 'base64url').toString('utf8'));
    expect(Object.values(cursor.d)).toEqual([['epoch-box', 5]]);
  });

  it('keep their order while a session is being checked', async () => {
    let answer;
    const { box, events } = await open({ ownsSession: () => new Promise((resolve) => { answer = resolve; }) });
    box.emit(frame('s-1', 1));
    box.emit(frame('s-1', 2));
    expect(events).toEqual([]);
    answer(true);
    await settle();
    box.emit(frame('s-1', 3));
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it('drops a session whose check fails', async () => {
    const { box, events } = await open({ ownsSession: async () => { throw new Error('unreadable'); } });
    box.emit(frame('s-1', 1));
    await settle();
    expect(events).toEqual([]);
  });

  it('pass straight through when nothing checks them', async () => {
    const { box, events } = await open();
    box.emit(frame('s-1', 1));
    expect(events.map((event) => event.sequence)).toEqual([1]);
  });
});
