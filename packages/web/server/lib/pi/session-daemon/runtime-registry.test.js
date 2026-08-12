import { describe, expect, it } from 'vitest';

import { createSessionRuntimeRegistry, SessionRuntimeRegistryError } from './runtime-registry.js';

class FakeSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeRuntime {
  constructor({ cwd, sessionId }) {
    this.cwd = cwd;
    this.session = new FakeSession(sessionId);
    this.rebindSession = undefined;
    this.disposed = false;
  }

  setRebindSession(rebindSession) {
    this.rebindSession = rebindSession;
  }

  async replace({ cwd = this.cwd, sessionId }) {
    this.cwd = cwd;
    this.session = new FakeSession(sessionId);
    await this.rebindSession?.(this.session);
  }

  async dispose() {
    this.disposed = true;
  }
}

describe('Pi session runtime registry', () => {
  it('keys runtime ownership by session identity and cwd, then rebinds events after replacement', async () => {
    const events = [];
    const registry = createSessionRuntimeRegistry({
      onSessionEvent: (identity, event) => events.push({ identity, event }),
    });
    const runtime = new FakeRuntime({ cwd: '/projects/one', sessionId: 'session-one' });
    const originalSession = runtime.session;

    expect(registry.register(runtime)).toEqual({
      cwd: '/projects/one',
      sessionId: 'session-one',
      key: JSON.stringify(['/projects/one', 'session-one']),
    });
    originalSession.emit({ type: 'agent_start' });

    await runtime.replace({ cwd: '/projects/two', sessionId: 'session-two' });
    originalSession.emit({ type: 'agent_settled' });
    runtime.session.emit({ type: 'agent_settled' });

    expect(events).toEqual([
      { identity: { cwd: '/projects/one', sessionId: 'session-one' }, event: { type: 'agent_start' } },
      { identity: { cwd: '/projects/two', sessionId: 'session-two' }, event: { type: 'agent_settled' } },
    ]);
    expect(registry.size).toBe(1);
  });

  it('does not let a session replacement displace a separately tracked runtime', async () => {
    const registry = createSessionRuntimeRegistry();
    const firstRuntime = new FakeRuntime({ cwd: '/projects/one', sessionId: 'session-one' });
    const secondRuntime = new FakeRuntime({ cwd: '/projects/two', sessionId: 'session-two' });
    registry.register(firstRuntime);
    registry.register(secondRuntime);

    await expect(secondRuntime.replace({ cwd: '/projects/one', sessionId: 'session-one' })).rejects.toMatchObject({
      code: 'SESSION_RUNTIME_CONFLICT',
    });
    expect(registry.size).toBe(2);
  });

  it('keeps a failed runtime tracked while disposing unrelated runtimes', async () => {
    const registry = createSessionRuntimeRegistry();
    const failingRuntime = new FakeRuntime({ cwd: '/projects/one', sessionId: 'session-one' });
    failingRuntime.dispose = async () => { throw new Error('disposal failed'); };
    const healthyRuntime = new FakeRuntime({ cwd: '/projects/two', sessionId: 'session-two' });
    registry.register(failingRuntime);
    registry.register(healthyRuntime);

    await expect(registry.disposeAll()).rejects.toBeInstanceOf(AggregateError);
    expect(failingRuntime.disposed).toBe(false);
    expect(healthyRuntime.disposed).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('rejects invalid runtime identities', () => {
    const registry = createSessionRuntimeRegistry();

    expect(() => registry.register({ session: new FakeSession('session-one') })).toThrow(SessionRuntimeRegistryError);
    try {
      registry.register(new FakeRuntime({ cwd: '/projects/one', sessionId: '' }));
      throw new Error('Expected invalid runtime identity to be rejected.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_SESSION_RUNTIME' });
    }
  });
});
