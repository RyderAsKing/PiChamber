/**
 * Header-draft helpers for the manual server form (label/URL/token plus
 * optional extra request headers). Moved here from the servers settings
 * section so the shared add-server dialog and the desktop edit dialog use
 * one implementation. `Authorization` stays reserved for the connection
 * token and is never accepted as an extra header.
 */

export type HeaderDraft = {
  id: string;
  name: string;
  value: string;
};

export const createHeaderDraft = (name = '', value = ''): HeaderDraft => ({
  id:
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `header-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  name,
  value,
});

const isReservedRequestHeaderName = (name: string): boolean =>
  name.trim().toLowerCase() === 'authorization';

export const buildRequestHeaders = (
  headers: HeaderDraft[],
): Record<string, string> | undefined => {
  const next: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.trim();
    const value = header.value.trim();
    if (name && value && !isReservedRequestHeaderName(name)) next[name] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

export const readRequestHeaderDrafts = (
  headers: Record<string, string> | undefined,
): HeaderDraft[] => {
  return Object.entries(headers || {}).map(([name, value]) => createHeaderDraft(name, value));
};
