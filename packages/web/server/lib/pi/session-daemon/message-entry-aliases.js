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
 *
 * Scopes are pruned lazily: every retain stamps the scope's last-touched time
 * and drops scopes idle beyond ALIAS_SCOPE_IDLE_TTL_MS (and, under memory
 * pressure from very long-lived daemons with many abandoned sessions, the
 * oldest scopes beyond MAX_SCOPES). Deleted sessions are cleared eagerly via
 * clearSession; pruning here only bounds the ones that are merely abandoned.
 */
export const ALIAS_SCOPE_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_SCOPES = 512;
const PRUNE_EVERY_N_RETAINS = 64;

export function createMessageEntryAliases({ scheduleMicrotask = queueMicrotask, now = () => Date.now() } = {}) {
  const aliasesByScope = new Map();
  const pendingByMessage = new WeakMap();
  let retainsSincePrune = 0;

  const pruneScopes = (nowMs) => {
    for (const [key, entry] of aliasesByScope.entries()) {
      if (!entry || nowMs - (entry.lastTouchedAt || 0) > ALIAS_SCOPE_IDLE_TTL_MS) {
        aliasesByScope.delete(key);
      }
    }
    while (aliasesByScope.size > MAX_SCOPES) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, entry] of aliasesByScope.entries()) {
        const touchedAt = entry?.lastTouchedAt || 0;
        if (touchedAt < oldestAt) {
          oldestAt = touchedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      aliasesByScope.delete(oldestKey);
    }
  };

  const getScopeEntry = (cwd, sessionId, create = false) => {
    const key = scopeKey(cwd, sessionId);
    let entry = aliasesByScope.get(key);
    if (!entry && create) {
      entry = { aliases: new Map(), lastTouchedAt: now() };
      aliasesByScope.set(key, entry);
    }
    return entry;
  };

  const getScope = (cwd, sessionId, create = false) => getScopeEntry(cwd, sessionId, create)?.aliases;

  const retain = ({ cwd, sessionId, syntheticMessageId, message }) => {
    if (typeof cwd !== 'string' || typeof sessionId !== 'string' || typeof syntheticMessageId !== 'string'
      || !message || typeof message !== 'object') return;
    const alias = { message };
    const entry = getScopeEntry(cwd, sessionId, true);
    entry.aliases.set(syntheticMessageId, alias);
    entry.lastTouchedAt = now();
    pendingByMessage.set(message, { alias });
    if (++retainsSincePrune >= PRUNE_EVERY_N_RETAINS) {
      retainsSincePrune = 0;
      pruneScopes(now());
    }
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

    observeMessageEnd({ cwd, sessionId, syntheticMessageId, message, sessionManager }) {
      if (typeof syntheticMessageId !== 'string' || !message || typeof message !== 'object') return;
      const alias = getScope(cwd, sessionId)?.get(syntheticMessageId);
      if (!alias) return;
      if (alias.message && alias.message !== message) pendingByMessage.delete(alias.message);
      alias.message = message;
      const pending = { alias };
      pendingByMessage.set(message, pending);
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
      const entry = aliasesByScope.get(key);
      if (!entry) return;
      for (const alias of entry.aliases.values()) {
        if (alias.message) pendingByMessage.delete(alias.message);
      }
      aliasesByScope.delete(key);
    },

    clear() {
      for (const entry of aliasesByScope.values()) {
        for (const alias of entry.aliases.values()) {
          if (alias.message) pendingByMessage.delete(alias.message);
        }
      }
      aliasesByScope.clear();
    },
  };
}
