// Reads npm's public registry for the marketplace: search, a package's latest
// manifest, and weekly downloads. Every answer is reduced to a small,
// validated shape here, so nothing npm sends reaches the browser unchecked.
// See DOCUMENTATION.md.

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org';
const DEFAULT_DOWNLOADS_URL = 'https://api.npmjs.org';

/** Pi's gallery lists npm packages with this keyword (Pi docs/packages.md). */
export const PI_PACKAGE_KEYWORD = 'pi-package';
/** Authors add this keyword to say the package has PiChamber support. */
export const PICHAMBER_KEYWORD = 'pichamber';

const USER_AGENT = 'PiChamber';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_DOWNLOADS_BYTES = 16 * 1024;
const MAX_NAME_LENGTH = 214;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_KEYWORDS = 20;
const MAX_KEYWORD_LENGTH = 50;
const MAX_URL_LENGTH = 500;
const PI_RESOURCE_TYPES = ['extensions', 'skills', 'prompts', 'themes'];

const NPM_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9._~ -]{1,64}$/;
const LICENSE_PATTERN = /^[A-Za-z0-9.+() -]{1,64}$/;

export class MarketplaceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A name npm would accept for a new package, which is what `pi install npm:<name>` needs. */
export const isValidNpmName = (value) => (
  typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH && NPM_NAME_PATTERN.test(value)
);

/** One line of plain text: control characters removed, spaces collapsed, length capped. */
const plainText = (value, max) => {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
};

const keywordsOf = (value) => {
  if (!Array.isArray(value)) return [];
  const keywords = [];
  for (const entry of value) {
    const keyword = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (keyword.length === 0 || keyword.length > MAX_KEYWORD_LENGTH || keywords.includes(keyword)) continue;
    keywords.push(keyword);
    if (keywords.length === MAX_KEYWORDS) break;
  }
  return keywords;
};

/** An http(s) link the UI may open, credentials removed. Anything else is dropped. */
export const safeLink = (value) => {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return undefined;
  let text = value.trim();
  // npm's repository field: `git+https://host/x.git`, `git://host/x`, `github:user/repo`.
  if (/^github:/i.test(text)) text = `https://github.com/${text.slice('github:'.length)}`;
  text = text.replace(/^git\+/i, '').replace(/^git:\/\//i, 'https://');
  let url;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  url.username = '';
  url.password = '';
  if (url.hostname === 'github.com' || url.hostname === 'gitlab.com') url.pathname = url.pathname.replace(/\.git$/, '');
  return url.toString();
};

const repositoryUrl = (repository) => safeLink(isRecord(repository) ? repository.url : repository);

const npmPageUrl = (name) => `https://www.npmjs.com/package/${name}`;

const isoDate = (value) => {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};

/** What a package's `pi` block says it adds, in Pi's resource order. */
const piContents = (pi) => (isRecord(pi)
  ? PI_RESOURCE_TYPES.filter((type) => Array.isArray(pi[type]) && pi[type].length > 0)
  : []);

/**
 * Read a JSON body without trusting its size: the declared length is checked
 * first, then the stream is cut off at `maxBytes`.
 */
const readJson = async (response, maxBytes) => {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new MarketplaceError('MARKETPLACE_UNAVAILABLE', 'npm answer too large');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new MarketplaceError('MARKETPLACE_UNAVAILABLE', 'npm answer too large');
    return JSON.parse(text);
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new MarketplaceError('MARKETPLACE_UNAVAILABLE', 'npm answer too large');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
};

/**
 * One search hit or one manifest, reduced to what the marketplace shows.
 * Returns `undefined` for an entry without a usable name.
 */
export const summarizePackage = (pkg, extra = {}) => {
  if (!isRecord(pkg) || !isValidNpmName(pkg.name)) return undefined;
  const keywords = keywordsOf(pkg.keywords);
  const version = typeof pkg.version === 'string' && VERSION_PATTERN.test(pkg.version) ? pkg.version : undefined;
  const description = plainText(pkg.description, MAX_DESCRIPTION_LENGTH);
  // Who maintains it, not who published: CI publishes as "GitHub Actions".
  const maintainer = Array.isArray(pkg.maintainers) && isRecord(pkg.maintainers[0]) ? pkg.maintainers[0] : undefined;
  const publisher = [maintainer?.username, maintainer?.name, isRecord(pkg.publisher) ? pkg.publisher.username : undefined]
    .find((name) => typeof name === 'string' && USERNAME_PATTERN.test(name) && name !== 'GitHub Actions');
  const date = isoDate(pkg.date);
  const links = isRecord(pkg.links) ? pkg.links : {};
  const repository = safeLink(links.repository) ?? repositoryUrl(pkg.repository);
  const homepage = safeLink(links.homepage) ?? safeLink(pkg.homepage);
  return {
    name: pkg.name,
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
    keywords,
    ...(publisher ? { publisher } : {}),
    ...(date ? { date } : {}),
    ...(Number.isFinite(extra.weeklyDownloads) ? { weeklyDownloads: Math.max(0, Math.floor(extra.weeklyDownloads)) } : {}),
    // From the keyword alone. The package page reads the manifest to confirm it.
    pichamberKeyword: keywords.includes(PICHAMBER_KEYWORD),
    links: {
      npm: npmPageUrl(pkg.name),
      ...(repository ? { repository } : {}),
      ...(homepage && homepage !== repository ? { homepage } : {}),
    },
  };
};

/**
 * The latest manifest, with what only the manifest knows: the license, what
 * the `pi` block adds, and whether a `pichamber` block is really there.
 */
export const summarizeManifest = (manifest) => {
  const summary = summarizePackage(manifest);
  if (!summary) return undefined;
  const license = typeof manifest.license === 'string' && LICENSE_PATTERN.test(manifest.license) ? manifest.license : undefined;
  return {
    ...summary,
    ...(license ? { license } : {}),
    contains: piContents(manifest.pi),
    pichamber: isRecord(manifest.pichamber) && typeof manifest.pichamber.apiVersion === 'number',
    isPiPackage: summary.keywords.includes(PI_PACKAGE_KEYWORD),
  };
};

/**
 * `fetchImpl` is the global `fetch` by default; tests pass a stub. Every
 * request has a timeout and a size cap. Failures throw `MarketplaceError`:
 * `MARKETPLACE_UNAVAILABLE` (network, status, malformed answer) or
 * `MARKETPLACE_PACKAGE_NOT_FOUND` (404 for a package).
 */
export const createNpmRegistry = ({
  fetchImpl = globalThis.fetch,
  registryUrl = DEFAULT_REGISTRY_URL,
  downloadsUrl = DEFAULT_DOWNLOADS_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => {
  const getJson = async (url, maxBytes, { notFound } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
          redirect: 'follow',
          signal: controller.signal,
        });
      } catch {
        throw new MarketplaceError('MARKETPLACE_UNAVAILABLE', 'npm could not be reached');
      }
      if (response.status === 404 && notFound) throw new MarketplaceError(notFound);
      if (!response.ok) throw new MarketplaceError('MARKETPLACE_UNAVAILABLE', `npm answered ${response.status}`);
      try {
        return await readJson(response, maxBytes);
      } catch (error) {
        if (error instanceof MarketplaceError) throw error;
        throw new MarketplaceError('MARKETPLACE_UNAVAILABLE', 'npm answer unreadable');
      }
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * One page of npm's search. `text` ranks results; `keywords` filter them
   * (npm's `keywords:` qualifier). Answers `{ total, objects }` with raw
   * entries for `searchPackages` to reduce.
   */
  const searchRaw = async ({ text = '', keywords = [], from = 0, size = 20 }) => {
    const query = [text, ...keywords.map((keyword) => `keywords:${keyword}`)].filter(Boolean).join(' ');
    const url = new URL('/-/v1/search', registryUrl);
    url.searchParams.set('text', query);
    url.searchParams.set('size', String(size));
    url.searchParams.set('from', String(from));
    const body = await getJson(url, MAX_SEARCH_BYTES);
    if (!isRecord(body) || !Array.isArray(body.objects)) throw new MarketplaceError('MARKETPLACE_UNAVAILABLE', 'npm answer malformed');
    return { total: Number.isFinite(body.total) ? body.total : undefined, objects: body.objects };
  };

  /** The `latest` manifest of one package. */
  const latest = async (name) => {
    if (!isValidNpmName(name)) throw new MarketplaceError('INVALID_MARKETPLACE_REQUEST');
    const url = new URL(`/${name.replace('/', '%2F')}/latest`, registryUrl);
    const body = await getJson(url, MAX_MANIFEST_BYTES, { notFound: 'MARKETPLACE_PACKAGE_NOT_FOUND' });
    if (!isRecord(body) || body.name !== name) throw new MarketplaceError('MARKETPLACE_UNAVAILABLE', 'npm answer malformed');
    return body;
  };

  /** Downloads in the last week, or `undefined` when npm does not say. */
  const weeklyDownloads = async (name) => {
    if (!isValidNpmName(name)) throw new MarketplaceError('INVALID_MARKETPLACE_REQUEST');
    const url = new URL(`/downloads/point/last-week/${name}`, downloadsUrl);
    const body = await getJson(url, MAX_DOWNLOADS_BYTES, { notFound: 'MARKETPLACE_PACKAGE_NOT_FOUND' });
    return isRecord(body) && Number.isFinite(body.downloads) ? body.downloads : undefined;
  };

  return { searchRaw, latest, weeklyDownloads };
};
