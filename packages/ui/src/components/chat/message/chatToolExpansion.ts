export const EXPANDED_TOOLS_CACHE_MAX = 4000;
export const expandedToolsStateCache = new Map<string, Set<string>>();
export const collapsedToolsStateCache = new Map<string, Set<string>>();

export const BASH_TOOL_NAMES = new Set(['bash', 'shell', 'cmd', 'terminal']);
export const EDIT_TOOL_NAMES = new Set([
  'apply_patch',
  'edit',
  'write',
  'multiedit',
  'str_replace',
  'str_replace_based_edit_tool',
  'create',
  'file_write',
]);

export const normalizeToolName = (toolName: unknown): string => {
  if (typeof toolName !== 'string') return '';
  const trimmed = toolName.trim().toLowerCase();
  if (!trimmed) return '';
  const withoutIndex = trimmed.replace(/:\d+$/, '');
  if (!withoutIndex.includes('.')) {
    return withoutIndex;
  }
  const parts = withoutIndex.split('.').filter(Boolean);
  return parts[parts.length - 1] ?? withoutIndex;
};

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

export const readCollapsedToolsCache = (messageId: string): Set<string> => {
  const cached = collapsedToolsStateCache.get(messageId);
  return cached ? new Set(cached) : new Set();
};

export const writeCollapsedToolsCache = (
  messageId: string,
  value: Set<string>
): void => {
  if (
    collapsedToolsStateCache.size >= EXPANDED_TOOLS_CACHE_MAX &&
    !collapsedToolsStateCache.has(messageId)
  ) {
    const oldest = collapsedToolsStateCache.keys().next().value;
    if (typeof oldest === 'string') {
      collapsedToolsStateCache.delete(oldest);
    }
  }
  collapsedToolsStateCache.set(messageId, new Set(value));
};
