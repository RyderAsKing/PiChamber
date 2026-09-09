import { getPiSessionStore } from '@/apps/pi-session-store';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { buildKnownSessionDirectories } from '@/sync/known-session-directories';
import { getGlobalSessionDirectories } from '@/sync/global-session-directory';
import type { PiSessionCatalogState } from '@/sync/pi-session-catalog';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { buildAvailableWorktreesByProject, useWorktreeStore } from '@/stores/useWorktreeStore';

// Lightweight read boundary over the live catalog. Owns no list/store and
// never changes focus; it only refreshes scopes whose committed status is
// not already `ready` and reports per-scope completeness.
export interface SessionCatalogLoadResult {
  runtimeKey: string;
  catalog: PiSessionCatalogState;
  readyDirectories: ReadonlySet<string>;
  failedDirectories: ReadonlySet<string>;
  complete: boolean;
  stale: boolean;
}

type InflightCatalogLoad = {
  store: ReturnType<typeof getPiSessionStore>;
  runtimeKey: string;
  generation: number;
  promise: Promise<SessionCatalogLoadResult>;
};

const inflightCatalogLoads = new Map<string, InflightCatalogLoad>();

const normalizeDirectorySet = (directories: Iterable<string>): Set<string> => {
  const next = new Set<string>();
  for (const directory of directories) {
    const normalized = normalizePath(directory);
    if (normalized) next.add(normalized);
  }
  return next;
};

const collectDefaultCatalogDirectories = (): Set<string> => {
  const next = new Set<string>();
  const projects = useProjectsStore.getState().projects;
  const known = buildKnownSessionDirectories(
    projects,
    buildAvailableWorktreesByProject(projects, useWorktreeStore.getState()),
    { includeWorktrees: true },
  );
  for (const directory of known) {
    const normalized = normalizePath(directory);
    if (normalized && normalized !== '~') next.add(normalized);
  }
  const focused = normalizePath(getPiSessionStore().getState().directory);
  if (focused) next.add(focused);
  const homeDirectory = useDirectoryStore.getState().homeDirectory ?? null;
  for (const directory of getGlobalSessionDirectories(homeDirectory)) {
    const normalized = normalizePath(directory);
    if (normalized && normalized !== '~') next.add(normalized);
  }
  return next;
};

const loadInner = async (
  capturedStore: ReturnType<typeof getPiSessionStore>,
  capturedRuntimeKey: string,
  capturedGeneration: number,
  sorted: readonly string[],
  isExplicit: boolean,
): Promise<SessionCatalogLoadResult> => {
  const committed = capturedStore.getState().catalog.listStatusByDirectory;
  const toRefresh = sorted.filter((directory) => committed.get(directory) !== 'ready');
  if (toRefresh.length > 0) {
    await capturedStore.refreshAllDirectoryCatalogs(toRefresh).catch(() => undefined);
  }

  const currentStore = getPiSessionStore();
  const stale =
    currentStore !== capturedStore ||
    getRuntimeKey() !== capturedRuntimeKey ||
    currentStore.getRuntimeGeneration() !== capturedGeneration;
  const catalog = currentStore.getState().catalog;

  const readyDirectories = new Set<string>();
  const failedDirectories = new Set<string>();
  for (const directory of sorted) {
    const status = catalog.listStatusByDirectory.get(directory);
    if (status === 'ready') readyDirectories.add(directory);
    else if (status === 'failed') failedDirectories.add(directory);
  }

  const complete =
    !stale &&
    failedDirectories.size === 0 &&
    readyDirectories.size === sorted.length &&
    (isExplicit || sorted.length > 0);

  return {
    runtimeKey: capturedRuntimeKey,
    catalog,
    readyDirectories,
    failedDirectories,
    complete,
    stale,
  };
};

export const loadSessionCatalog = (
  directories?: Iterable<string>,
): Promise<SessionCatalogLoadResult> => {
  const capturedStore = getPiSessionStore();
  const capturedRuntimeKey = getRuntimeKey();
  const capturedGeneration = capturedStore.getRuntimeGeneration();

  const isExplicit = directories !== undefined;
  const requested =
    directories === undefined ? collectDefaultCatalogDirectories() : normalizeDirectorySet(directories);
  const sorted = [...requested].sort();
  const inflightKey = `${capturedRuntimeKey}::${sorted.join('|')}`;
  const existing = inflightCatalogLoads.get(inflightKey);
  if (
    existing &&
    existing.store === capturedStore &&
    existing.runtimeKey === capturedRuntimeKey &&
    existing.generation === capturedGeneration
  ) {
    return existing.promise;
  }

  const promise = loadInner(capturedStore, capturedRuntimeKey, capturedGeneration, sorted, isExplicit);
  inflightCatalogLoads.set(inflightKey, {
    store: capturedStore,
    runtimeKey: capturedRuntimeKey,
    generation: capturedGeneration,
    promise,
  });
  const clear = (): void => {
    if (inflightCatalogLoads.get(inflightKey)?.promise === promise) {
      inflightCatalogLoads.delete(inflightKey);
    }
  };
  void promise.then(clear, clear);
  return promise;
};
