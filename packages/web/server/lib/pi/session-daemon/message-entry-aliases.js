const scopeKey = (cwd, sessionId) => JSON.stringify([cwd, sessionId]);

const stripPartSuffix = (messageId) => {
  const suffixIndex = messageId.indexOf(':');
  return suffixIndex === -1 ? messageId : messageId.slice(0, suffixIndex);
};

const findPersistedMessageEntry = (sessionManager, message) => {
  const entries = sessionManager?.getEntries?.();
  if (!Array.isArray(entries)) return undefined;
  return entries.find((entry) => entry?.type === 'message' && entry.message === message);
};

/**
 * Keeps daemon-published live message ids resolvable after Pi persists those
 * messages under its own session-entry ids.
 */
export function createMessageEntryAliases({ scheduleMicrotask = queueMicrotask } = {}) {
  const aliasesByScope = new Map();
  const pendingByMessage = new WeakMap();

  const getScope = (cwd, sessionId, create = false) => {
    const key = scopeKey(cwd, sessionId);
    let scope = aliasesByScope.get(key);
    if (!scope && create) {
      scope = new Map();
      aliasesByScope.set(key, scope);
    }
    return scope;
  };

  const retain = ({ cwd, sessionId, syntheticMessageId, message }) => {
    if (typeof cwd !== 'string' || typeof sessionId !== 'string' || typeof syntheticMessageId !== 'string'
      || !message || typeof message !== 'object') return;
    const alias = { message };
    getScope(cwd, sessionId, true).set(syntheticMessageId, alias);
    pendingByMessage.set(message, { cwd, sessionId, alias });
  };

  const releasePersisted = (pending, sessionManager) => {
    const entry = findPersistedMessageEntry(sessionManager, pending.alias.message);
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) return undefined;
    pending.alias.entryId = entry.id;
    delete pending.alias.message;
    pendingByMessage.delete(entry.message);
    return entry.id;
  };

  return {
    retain,

    observeMessageEnd({ cwd, sessionId, message, sessionManager }) {
      if (!message || typeof message !== 'object') return;
      const pending = pendingByMessage.get(message);
      if (!pending || pending.cwd !== cwd || pending.sessionId !== sessionId) return;
      scheduleMicrotask(() => {
        releasePersisted(pending, sessionManager);
      });
    },

    resolve({ cwd, sessionId, requestedId, sessionManager }) {
      if (typeof requestedId !== 'string' || requestedId.length === 0) return requestedId;
      const entryId = stripPartSuffix(requestedId);
      if (sessionManager?.getEntry?.(entryId)) return entryId;

      const alias = getScope(cwd, sessionId)?.get(entryId);
      if (!alias) return entryId;
      if (typeof alias.entryId === 'string' && alias.entryId.length > 0) return alias.entryId;
      if (alias.message) {
        const pending = pendingByMessage.get(alias.message);
        const persistedEntryId = pending ? releasePersisted(pending, sessionManager) : undefined;
        if (persistedEntryId) return persistedEntryId;
      }
      return entryId;
    },

    clearSession({ cwd, sessionId }) {
      const key = scopeKey(cwd, sessionId);
      const scope = aliasesByScope.get(key);
      if (!scope) return;
      for (const alias of scope.values()) {
        if (alias.message) pendingByMessage.delete(alias.message);
      }
      aliasesByScope.delete(key);
    },

    clear() {
      for (const scope of aliasesByScope.values()) {
        for (const alias of scope.values()) {
          if (alias.message) pendingByMessage.delete(alias.message);
        }
      }
      aliasesByScope.clear();
    },
  };
}
