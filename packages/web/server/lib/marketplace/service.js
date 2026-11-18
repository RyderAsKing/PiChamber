// The marketplace: npm search over Pi packages, the curated featured list,
// one package's details, and latest versions for update checks. Answers are
// cached in memory and shared by every device on this server; identical
// requests in flight share one npm call. See DOCUMENTATION.md.

import {
  MarketplaceError,
  PICHAMBER_KEYWORD,
  PI_PACKAGE_KEYWORD,
  isValidNpmName,
  summarizeManifest,
  summarizePackage,
} from './npm-registry.js';

const PAGE_SIZE = 20;
const MAX_QUERY_LENGTH = 100;
const MAX_FROM = 5_000;
const MAX_VERSION_NAMES = 50;
const SEARCH_TTL_MS = 5 * 60 * 1000;
const PACKAGE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 300;
const CONCURRENCY = 6;

/**
 * A small TTL cache that also shares a running load. A failed load is not
 * kept, so the next request tries again.
 */
const createCache = ({ ttlMs, now }) => {
  const entries = new Map();
  return (key, load) => {
    const hit = entries.get(key);
    if (hit && (hit.pending || now() - hit.at < ttlMs)) {
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    }
    const value = load();
    const entry = { at: now(), value, pending: true };
    entries.set(key, entry);
    value.then(
      () => {
        entry.pending = false;
        entry.at = now();
      },
      () => {
        if (entries.get(key) === entry) entries.delete(key);
      },
    );
    while (entries.size > MAX_CACHE_ENTRIES) entries.delete(entries.keys().next().value);
    return value;
  };
};

/** Run `task` over `items` with at most `limit` at once, keeping order. */
const mapLimited = async (items, limit, task) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/**
 * Search text as npm should see it: one line, no `keywords:` or other
 * qualifiers (the keyword filter is ours to set), length capped.
 */
export const normalizeQuery = (value) => {
  if (typeof value !== 'string') return '';
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\b[a-z]+:\S*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
};

const queryTokens = (query) => query.toLowerCase().split(/[\s,]+/).filter((token) => token.length >= 2);

/**
 * npm ranks by the text but still returns every package with the keyword,
 * the popular ones last. A hit counts when a word of the query is in its
 * name, description, or keywords.
 */
const matches = (summary, tokens) => {
  if (tokens.length === 0) return true;
  const haystack = [summary.name, summary.description ?? '', ...summary.keywords].join(' ').toLowerCase();
  return tokens.some((token) => haystack.includes(token));
};

export const createMarketplaceService = ({
  registry,
  featuredSource,
  bundledPackageNames = async () => [],
  now = () => Date.now(),
}) => {
  const searchCache = createCache({ ttlMs: SEARCH_TTL_MS, now });
  const packageCache = createCache({ ttlMs: PACKAGE_TTL_MS, now });
  const downloadsCache = createCache({ ttlMs: PACKAGE_TTL_MS, now });

  /** Names never shown: the hidden list and PiChamber's own plugins. */
  const excludedNames = async () => {
    const [featured, bundled] = await Promise.all([featuredSource.get(), bundledPackageNames().catch(() => [])]);
    return { featured, excluded: new Set([...featured.hidden, ...bundled]) };
  };

  const latest = (name) => packageCache(name, () => registry.latest(name));

  const weeklyDownloads = (name) => downloadsCache(name, () => registry.weeklyDownloads(name))
    .catch(() => undefined);

  /**
   * One page. `from` is npm's offset; the answer's `nextFrom` is the offset
   * of the next page, or `null` at the end.
   */
  const search = async ({ query, from = 0, pichamberOnly = false } = {}) => {
    const text = normalizeQuery(query);
    const offset = Number.isInteger(from) && from >= 0 && from <= MAX_FROM ? from : 0;
    // npm filters on one keyword reliably; with two it loosens. Ask for the
    // rarer one and check both here.
    const keywords = pichamberOnly ? [PI_PACKAGE_KEYWORD, PICHAMBER_KEYWORD] : [PI_PACKAGE_KEYWORD];
    const key = JSON.stringify([text, offset, pichamberOnly]);
    const page = await searchCache(key, () => registry.searchRaw({
      text,
      keywords: [pichamberOnly ? PICHAMBER_KEYWORD : PI_PACKAGE_KEYWORD],
      from: offset,
      size: PAGE_SIZE,
    }));
    const { excluded } = await excludedNames();
    const tokens = queryTokens(text);
    let unrelated = 0;
    const packages = [];
    for (const object of page.objects) {
      const summary = summarizePackage(object?.package, { weeklyDownloads: object?.downloads?.weekly });
      if (!summary) continue;
      // Pi's gallery needs `pi-package`; the filter needs ours as well.
      if (!keywords.every((keyword) => summary.keywords.includes(keyword))) continue;
      if (!matches(summary, tokens)) {
        unrelated += 1;
        continue;
      }
      if (excluded.has(summary.name)) continue;
      packages.push(summary);
    }
    const consumed = offset + page.objects.length;
    // Past the last hit npm pads with unrelated packages: stop there.
    const more = page.objects.length === PAGE_SIZE && unrelated === 0 && consumed < MAX_FROM
      && (page.total === undefined || consumed < page.total);
    return {
      packages,
      ...(tokens.length === 0 && page.total !== undefined ? { total: page.total } : {}),
      nextFrom: more ? consumed : null,
    };
  };

  /**
   * The featured packages in their listed order. One that npm cannot answer
   * for is still listed, marked `unavailable`, with its note.
   */
  const featured = async () => {
    const { featured: list, excluded } = await excludedNames();
    const shown = list.featured.filter((entry) => !excluded.has(entry.name));
    const packages = await mapLimited(shown, CONCURRENCY, async (entry) => {
      try {
        const [manifest, downloads] = await Promise.all([latest(entry.name), weeklyDownloads(entry.name)]);
        const summary = summarizeManifest(manifest);
        if (!summary) throw new MarketplaceError('MARKETPLACE_UNAVAILABLE');
        return {
          ...summary,
          ...(downloads !== undefined ? { weeklyDownloads: downloads } : {}),
          ...(entry.note ? { note: entry.note } : {}),
        };
      } catch {
        return {
          name: entry.name,
          keywords: [],
          pichamberKeyword: false,
          links: { npm: `https://www.npmjs.com/package/${entry.name}` },
          ...(entry.note ? { note: entry.note } : {}),
          unavailable: true,
        };
      }
    });
    return { packages, updated: list.updated, source: list.source };
  };

  /** One package's page. Hidden and bundled names answer not found. */
  const packageDetail = async (name) => {
    if (!isValidNpmName(name)) throw new MarketplaceError('INVALID_MARKETPLACE_REQUEST');
    const { excluded } = await excludedNames();
    if (excluded.has(name)) throw new MarketplaceError('MARKETPLACE_PACKAGE_NOT_FOUND');
    const [manifest, downloads] = await Promise.all([latest(name), weeklyDownloads(name)]);
    const summary = summarizeManifest(manifest);
    if (!summary) throw new MarketplaceError('MARKETPLACE_UNAVAILABLE');
    return { ...summary, ...(downloads !== undefined ? { weeklyDownloads: downloads } : {}) };
  };

  /**
   * Latest versions for update checks. A name npm cannot answer for is left
   * out, which means unknown, not "no update".
   */
  const versions = async (names) => {
    if (!Array.isArray(names) || names.length > MAX_VERSION_NAMES || !names.every(isValidNpmName)) {
      throw new MarketplaceError('INVALID_MARKETPLACE_REQUEST');
    }
    const unique = [...new Set(names)];
    const found = await mapLimited(unique, CONCURRENCY, async (name) => {
      try {
        const version = summarizeManifest(await latest(name))?.version;
        return version ? [name, version] : null;
      } catch {
        return null;
      }
    });
    return { versions: Object.fromEntries(found.filter(Boolean)) };
  };

  return { search, featured, packageDetail, versions };
};
