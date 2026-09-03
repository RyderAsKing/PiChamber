/** Normalize directory identities used by directory-scoped UI state. */
export const normalizeDirectoryPathKey = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '').replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  if (!normalized) {
    return raw.startsWith('/') ? '/' : '';
  }

  return normalized;
};
