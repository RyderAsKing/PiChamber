import { resolve } from 'node:path';

class SessionRuntimeRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const identityKey = ({ cwd, sessionId }) => JSON.stringify([cwd, sessionId]);

const getIdentity = (runtime, session, fallbackCwd) => {
  const cwd = typeof runtime?.cwd === 'string' && runtime.cwd.length > 0 ? runtime.cwd : fallbackCwd;
  const sessionId = session?.sessionId;
  if (typeof cwd !== 'string' || cwd.length === 0 || typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new SessionRuntimeRegistryError('INVALID_SESSION_RUNTIME', 'The Pi session runtime identity is invalid.');
  }
  return { cwd, sessionId, key: identityKey({ cwd, sessionId }) };
};

/**
 * Owns active Pi SDK runtime identities and session-local event subscriptions.
 * Runtime replacement is serialized by the SDK; this registry rebinds only
 * after the SDK has installed the replacement session.
 */
export function createSessionRuntimeRegistry({ onSessionEvent = () => {} } = {}) {
  const recordsByKey = new Map();
  const recordsByRuntime = new Map();

  const subscribe = (record, session) => {
    if (typeof session?.subscribe !== 'function') {
      throw new SessionRuntimeRegistryError('INVALID_SESSION_RUNTIME', 'The Pi session runtime cannot subscribe to session events.');
    }
    record.session = session;
    record.unsubscribe = session.subscribe((event) => {
      onSessionEvent({ cwd: record.identity.cwd, sessionId: record.identity.sessionId }, event);
    });
  };

  const rebind = async (record, session) => {
    const nextIdentity = getIdentity(record.runtime, session, record.identity.cwd);
    const conflictingRecord = recordsByKey.get(nextIdentity.key);
    if (conflictingRecord && conflictingRecord !== record) {
      throw new SessionRuntimeRegistryError('SESSION_RUNTIME_CONFLICT', 'A Pi runtime already owns this session and directory.');
    }

    record.unsubscribe?.();
    recordsByKey.delete(record.identity.key);
    record.identity = nextIdentity;
    recordsByKey.set(nextIdentity.key, record);
    subscribe(record, session);
  };

  const register = (runtime, { cwd } = {}) => {
    const existingRecord = recordsByRuntime.get(runtime);
    if (existingRecord) return { ...existingRecord.identity };

    const identity = getIdentity(runtime, runtime?.session, cwd);
    const conflictingRecord = recordsByKey.get(identity.key);
    if (conflictingRecord && conflictingRecord.runtime !== runtime) {
      throw new SessionRuntimeRegistryError('SESSION_RUNTIME_CONFLICT', 'A Pi runtime already owns this session and directory.');
    }

    const record = { runtime, identity, session: undefined, unsubscribe: undefined };
    recordsByKey.set(identity.key, record);
    recordsByRuntime.set(runtime, record);
    try {
      subscribe(record, runtime.session);
      if (typeof runtime.setRebindSession === 'function') {
        runtime.setRebindSession((session) => rebind(record, session));
      }
    } catch (error) {
      record.unsubscribe?.();
      recordsByKey.delete(identity.key);
      recordsByRuntime.delete(runtime);
      throw error;
    }
    return { ...identity };
  };

  const dispose = async (runtime) => {
    const record = recordsByRuntime.get(runtime);
    if (!record) return false;

    record.unsubscribe?.();
    try {
      await runtime.dispose?.();
    } catch (error) {
      subscribe(record, record.session);
      throw error;
    }

    runtime.setRebindSession?.(undefined);
    recordsByKey.delete(record.identity.key);
    recordsByRuntime.delete(runtime);
    return true;
  };

  const disposeAll = async () => {
    const errors = [];
    for (const record of [...recordsByRuntime.values()]) {
      try {
        await dispose(record.runtime);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more Pi session runtimes could not be disposed.');
    }
  };

  return {
    get({ cwd, sessionId } = {}) {
      if (typeof cwd !== 'string' || typeof sessionId !== 'string') return undefined;
      return recordsByKey.get(identityKey({ cwd, sessionId }))?.runtime;
    },
    findBySessionId(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
      for (const record of recordsByKey.values()) {
        if (record.identity.sessionId === sessionId) return record.runtime;
      }
      return undefined;
    },
    listByDirectory(cwd) {
      if (typeof cwd !== 'string' || cwd.length === 0) return [];
      const normalized = resolve(cwd);
      const results = [];
      for (const record of recordsByKey.values()) {
        if (resolve(record.identity.cwd) === normalized) {
          results.push(record.runtime);
        }
      }
      return results;
    },
    has({ cwd, sessionId } = {}) {
      if (typeof cwd !== 'string' || typeof sessionId !== 'string') return false;
      return recordsByKey.has(identityKey({ cwd, sessionId }));
    },
    register,
    dispose,
    disposeAll,
    listAll() {
      return [...recordsByKey.values()].map((record) => record.runtime);
    },
    get size() {
      return recordsByKey.size;
    },
  };
}

export { SessionRuntimeRegistryError };
