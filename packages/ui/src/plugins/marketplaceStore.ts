import { create } from 'zustand';

import { piClient } from '@/lib/pi/client';
import type {
  PiMarketplaceFeaturedResponse,
  PiMarketplacePackage,
  PiMarketplacePackageDetail,
} from '@/lib/pi/protocol';
import { getRuntimeKey } from '@/lib/runtime-switch';

/**
 * The marketplace as the server answers it: featured packages, search pages
 * per query, package pages, and latest versions for update checks. The
 * server caches npm too; this store only avoids asking it again while a view
 * is open. A runtime switch clears it (`apps/runtimeEndpointReset.ts`).
 */

type Status = 'loading' | 'ready' | 'error';

interface MarketplaceSearchEntry {
  packages: PiMarketplacePackage[];
  total?: number;
  nextFrom: number | null;
  status: Status;
  /** A further page is loading; `status` stays `ready`. */
  loadingMore: boolean;
  /** The last page failed to load; the pages before it stay. */
  moreFailed: boolean;
  loadedAt: number;
}

interface MarketplaceLoad<T> {
  data: T | null;
  status: Status;
  loadedAt: number;
}

interface MarketplaceStore {
  featured: MarketplaceLoad<PiMarketplaceFeaturedResponse>;
  searches: Record<string, MarketplaceSearchEntry>;
  details: Record<string, MarketplaceLoad<PiMarketplacePackageDetail>>;
  /** Latest version per npm name, from any answer that carried one. */
  latest: Record<string, string>;
  loadFeatured: (options?: { force?: boolean }) => Promise<void>;
  /** The first page for this query, or the next one with `more`. */
  search: (query: string, pichamberOnly: boolean, options?: { more?: boolean; force?: boolean }) => Promise<void>;
  loadDetail: (name: string, options?: { force?: boolean }) => Promise<void>;
  /** Ask for the latest versions of these names, skipping ones already known. */
  loadVersions: (names: string[]) => Promise<void>;
  resetForRuntimeSwitch: () => void;
}

const FRESH_MS = 5 * 60 * 1000;

export const searchKey = (query: string, pichamberOnly: boolean): string => (
  `${pichamberOnly ? '1' : '0'}\n${query.trim().replace(/\s+/g, ' ').toLowerCase()}`
);

const emptyLoad = <T,>(): MarketplaceLoad<T> => ({ data: null, status: 'loading', loadedAt: 0 });

let generation = 0;
const inFlight = new Map<string, Promise<void>>();
const versionsAsked = new Set<string>();

const withVersions = (latest: Record<string, string>, packages: PiMarketplacePackage[]): Record<string, string> => {
  let next = latest;
  for (const pkg of packages) {
    if (!pkg.version || latest[pkg.name] === pkg.version) continue;
    if (next === latest) next = { ...latest };
    next[pkg.name] = pkg.version;
  }
  return next;
};

export const useMarketplaceStore = create<MarketplaceStore>()((set, get) => {
  /** Run `load` once per key at a time; a runtime switch drops its answer. */
  const once = (key: string, load: (isCurrent: () => boolean) => Promise<void>): Promise<void> => {
    const running = inFlight.get(key);
    if (running) return running;
    const loadGeneration = generation;
    const runtimeKey = getRuntimeKey();
    const isCurrent = () => loadGeneration === generation && getRuntimeKey() === runtimeKey;
    const request = load(isCurrent).finally(() => {
      if (loadGeneration === generation) inFlight.delete(key);
    });
    inFlight.set(key, request);
    return request;
  };

  return {
    featured: emptyLoad(),
    searches: {},
    details: {},
    latest: {},

    loadFeatured: (options) => {
      const current = get().featured;
      if (!options?.force && current.status === 'ready' && Date.now() - current.loadedAt < FRESH_MS) return Promise.resolve();
      return once('featured', async (isCurrent) => {
        set((state) => ({ featured: { ...state.featured, status: 'loading' } }));
        try {
          const data = await piClient.getMarketplaceFeatured({ runtimeKey: getRuntimeKey() });
          if (!isCurrent()) return;
          set((state) => ({
            featured: { data, status: 'ready', loadedAt: Date.now() },
            latest: withVersions(state.latest, data.packages),
          }));
        } catch {
          if (!isCurrent()) return;
          set((state) => ({ featured: { ...state.featured, status: 'error' } }));
        }
      });
    },

    search: (query, pichamberOnly, options) => {
      const key = searchKey(query, pichamberOnly);
      const existing = get().searches[key];
      const more = options?.more === true;
      if (more) {
        if (!existing || existing.status !== 'ready' || existing.nextFrom === null || existing.loadingMore) return Promise.resolve();
      } else if (!options?.force && existing?.status === 'ready' && Date.now() - existing.loadedAt < FRESH_MS) {
        return Promise.resolve();
      }
      const from = more && existing ? existing.nextFrom ?? 0 : 0;
      return once(`search\n${key}\n${from}`, async (isCurrent) => {
        set((state) => {
          const entry = state.searches[key];
          return {
            searches: {
              ...state.searches,
              [key]: more && entry
                ? { ...entry, loadingMore: true, moreFailed: false }
                : {
                  packages: entry?.packages ?? [],
                  ...(entry?.total !== undefined ? { total: entry.total } : {}),
                  nextFrom: entry?.nextFrom ?? null,
                  status: 'loading',
                  loadingMore: false,
                  moreFailed: false,
                  loadedAt: entry?.loadedAt ?? 0,
                },
            },
          };
        });
        try {
          const page = await piClient.searchMarketplace(
            { query: query.trim(), from, pichamberOnly },
            { runtimeKey: getRuntimeKey() },
          );
          if (!isCurrent()) return;
          set((state) => {
            const entry = state.searches[key];
            const seen = new Set(more && entry ? entry.packages.map((pkg) => pkg.name) : []);
            const packages = more && entry
              ? [...entry.packages, ...page.packages.filter((pkg) => !seen.has(pkg.name))]
              : page.packages;
            return {
              searches: {
                ...state.searches,
                [key]: {
                  packages,
                  ...(page.total !== undefined ? { total: page.total } : {}),
                  nextFrom: page.nextFrom,
                  status: 'ready',
                  loadingMore: false,
                  moreFailed: false,
                  loadedAt: more && entry ? entry.loadedAt : Date.now(),
                },
              },
              latest: withVersions(state.latest, page.packages),
            };
          });
        } catch {
          if (!isCurrent()) return;
          set((state) => {
            const entry = state.searches[key];
            if (!entry) return state;
            return {
              searches: {
                ...state.searches,
                [key]: more ? { ...entry, loadingMore: false, moreFailed: true } : { ...entry, status: 'error' },
              },
            };
          });
        }
      });
    },

    loadDetail: (name, options) => {
      const existing = get().details[name];
      if (!options?.force && existing?.status === 'ready' && Date.now() - existing.loadedAt < FRESH_MS) return Promise.resolve();
      return once(`detail\n${name}`, async (isCurrent) => {
        set((state) => ({
          details: { ...state.details, [name]: { ...(state.details[name] ?? emptyLoad()), status: 'loading' } },
        }));
        try {
          const data = await piClient.getMarketplacePackage(name, { runtimeKey: getRuntimeKey() });
          if (!isCurrent()) return;
          set((state) => ({
            details: { ...state.details, [name]: { data, status: 'ready', loadedAt: Date.now() } },
            latest: withVersions(state.latest, [data]),
          }));
        } catch {
          if (!isCurrent()) return;
          set((state) => ({
            details: { ...state.details, [name]: { ...(state.details[name] ?? emptyLoad()), status: 'error' } },
          }));
        }
      });
    },

    loadVersions: async (names) => {
      const wanted = [...new Set(names)].filter((name) => !versionsAsked.has(name));
      if (wanted.length === 0) return;
      for (const name of wanted) versionsAsked.add(name);
      const loadGeneration = generation;
      const runtimeKey = getRuntimeKey();
      try {
        // The server takes at most 50 names a request.
        for (let index = 0; index < wanted.length; index += 50) {
          const { versions } = await piClient.getMarketplaceVersions(wanted.slice(index, index + 50), { runtimeKey });
          if (loadGeneration !== generation || getRuntimeKey() !== runtimeKey) return;
          set((state) => ({ latest: { ...state.latest, ...versions } }));
        }
      } catch {
        // Unknown stays unknown: no update is offered. Ask again next time.
        if (loadGeneration === generation) for (const name of wanted) versionsAsked.delete(name);
      }
    },

    resetForRuntimeSwitch: () => {
      generation += 1;
      inFlight.clear();
      versionsAsked.clear();
      set({ featured: emptyLoad(), searches: {}, details: {}, latest: {} });
    },
  };
});
