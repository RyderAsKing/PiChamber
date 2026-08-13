import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('./runtime-url', () => ({
  getRuntimeUrlResolver: () => ({ sse: (path: string) => `http://runtime.test${path}` }),
}));

mock.module('./runtime-switch', () => ({
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) { MockEventSource.instances.push(this); }
  close() { this.readyState = MockEventSource.CLOSED; }
}

describe('PiChamber session-control events', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    globalThis.window = {} as Window & typeof globalThis;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  test('dispatches externally created session events', async () => {
    const { subscribeOpenchamberEvents } = await import('./pichamberEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeOpenchamberEvents((event) => events.push(event));
    const source = MockEventSource.instances[0];
    expect(source.url).toBe('http://runtime.test/api/openchamber/events');
    source.onmessage?.({ data: JSON.stringify({
      type: 'openchamber:session-created',
      properties: { sessionId: 'ses_123', directory: '/repo', projectId: 'project_1', createdAt: 123, promptDispatched: true, dispatchedAsCommand: false },
    }) });
    expect(events).toEqual([{ type: 'session-created', sessionId: 'ses_123', directory: '/repo', projectId: 'project_1', createdAt: 123, promptDispatched: true, dispatchedAsCommand: false }]);
    unsubscribe();
  });

  test('ignores removed scheduled-task event envelopes', async () => {
    const { subscribeOpenchamberEvents } = await import('./pichamberEvents');
    let calls = 0;
    const unsubscribe = subscribeOpenchamberEvents(() => { calls += 1; });
    MockEventSource.instances[0].onmessage?.({ data: JSON.stringify({ type: 'openchamber:scheduled-task-ran', properties: { projectId: 'project', taskId: 'task' } }) });
    expect(calls).toBe(0);
    unsubscribe();
  });
});
