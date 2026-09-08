import type { PiSessionCatalogState } from '@/sync/pi-session-catalog';

export type MobileRestorePersisted = {
  sessionId: string;
  directory: string | null;
};

export type MobileRestoreDecision =
  | { action: 'wait' }
  | { action: 'select'; sessionId: string; directory: string }
  | { action: 'clear' };

type MobileRestoreInput = {
  persisted: MobileRestorePersisted | null;
  persistedDirectory: string | null;
  stale: boolean;
  ready: boolean;
  catalog: PiSessionCatalogState | null;
  runtimeKey: string;
  capturedRuntimeKey: string;
  storeIdentityMatches: boolean;
  generationMatches: boolean;
};

/**
 * Pure decision for the native cold-launch last-session restore.
 *
 * - Demands `persistedDirectory` (normalized) even when it is not a known
 *   project; without it the restore can neither select nor clear.
 * - Stale results (runtime key, store identity, or generation drift) never
 *   clear or select — the caller retries on the next connect.
 * - A non-ready target directory is not authoritative: empty partial
 *   results never clear, and missing rows never select.
 * - Only an authoritative `ready` scope may clear (missing/archived) or
 *   select (active row present).
 */
export const decideMobileRestore = (input: MobileRestoreInput): MobileRestoreDecision => {
  const {
    persisted,
    persistedDirectory,
    stale,
    ready,
    catalog,
    runtimeKey,
    capturedRuntimeKey,
    storeIdentityMatches,
    generationMatches,
  } = input;
  if (!persisted || !persistedDirectory) return { action: 'wait' };
  if (stale || runtimeKey !== capturedRuntimeKey || !storeIdentityMatches || !generationMatches) {
    return { action: 'wait' };
  }
  if (!ready || !catalog) return { action: 'wait' };
  const record = catalog.byId.get(persisted.sessionId);
  if (!record || record.archived) return { action: 'clear' };
  return { action: 'select', sessionId: record.id, directory: record.directory ?? persistedDirectory };
};
