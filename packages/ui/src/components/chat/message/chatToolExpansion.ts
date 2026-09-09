export const EXPANDED_TOOLS_CACHE_MAX = 4000;
export const expandedToolsStateCache = new Map<string, Set<string>>();

export const readExpandedToolsCache = (messageId: string): Set<string> => {
  const cached = expandedToolsStateCache.get(messageId);
  return cached ? new Set(cached) : new Set();
};

export const writeExpandedToolsCache = (
  messageId: string,
  value: Set<string>
): void => {
  if (
    expandedToolsStateCache.size >= EXPANDED_TOOLS_CACHE_MAX &&
    !expandedToolsStateCache.has(messageId)
  ) {
    const oldest = expandedToolsStateCache.keys().next().value;
    if (typeof oldest === 'string') {
      expandedToolsStateCache.delete(oldest);
    }
  }
  expandedToolsStateCache.set(messageId, new Set(value));
};
