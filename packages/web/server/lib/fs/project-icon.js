// Finds the image a project already uses as its own icon (a web favicon, an
// app-router icon, or a logo asset) so the UI can show it next to the folder.
// Lookup only reads well-known files inside the project directory; it never
// follows a path out of that directory.

const ICON_MIME_BY_EXTENSION = new Map([
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

// Checked in order; the first existing file wins.
const DIRECT_ICON_PATHS = [
  'favicon.svg',
  'favicon.ico',
  'favicon.png',
  'public/favicon.svg',
  'public/favicon.ico',
  'public/favicon.png',
  'static/favicon.svg',
  'static/favicon.ico',
  'static/favicon.png',
  'app/icon.svg',
  'app/icon.png',
  'app/favicon.ico',
  'src/app/icon.svg',
  'src/app/icon.png',
  'src/app/favicon.ico',
  'src/favicon.svg',
  'src/favicon.ico',
  'assets/icon.svg',
  'assets/icon.png',
  'assets/logo.svg',
  'assets/logo.png',
];

// Files that may declare the icon with <link rel="icon" href="..."> or a
// framework head config ({ rel: 'icon', href: '...' }).
const ICON_DECLARING_FILES = [
  'index.html',
  'public/index.html',
  'src/index.html',
  'app/root.tsx',
  'src/root.tsx',
  'app/routes/__root.tsx',
  'src/routes/__root.tsx',
];

// Workspace folders whose packages are searched when the root has no icon.
const MONOREPO_PARENTS = ['apps', 'packages'];
// Package names that usually hold the product's web front end; searched first.
const PREFERRED_PACKAGE_NAMES = ['web', 'app', 'www', 'site', 'frontend', 'client', 'ui'];
const MAX_PACKAGES_PER_PARENT = 32;

const MAX_ICON_BYTES = 1024 * 1024;
const MAX_DECLARING_FILE_BYTES = 256 * 1024;

const FOUND_TTL_MS = 10 * 60 * 1000;
const MISSING_TTL_MS = 60 * 1000;
const CACHE_CAPACITY = 256;

const LINK_TAG_RE = /<link\b[^>]*>/gi;
const HTML_REL_RE = /\brel\s*=\s*["']([^"']*)["']/i;
const HTML_HREF_RE = /\bhref\s*=\s*["']([^"']+)["']/i;
const OBJECT_REL_ICON_RE = /\brel\s*:\s*["'](?:shortcut\s+)?icon["']/i;
const OBJECT_HREF_RE = /\bhref\s*:\s*["']([^"']+)["']/i;

const isIconRel = (rel) => rel.toLowerCase().split(/\s+/).includes('icon');

/** Returns the first icon href declared in an HTML document or a head config. */
export const findDeclaredIconHref = (source) => {
  for (const match of source.matchAll(LINK_TAG_RE)) {
    const tag = match[0];
    const rel = tag.match(HTML_REL_RE)?.[1];
    if (!rel || !isIconRel(rel)) continue;
    const href = tag.match(HTML_HREF_RE)?.[1];
    if (href) return href;
  }
  // Head configs are object literals; inspect each `{ ... }` body on its own so
  // a rel from one object never pairs with an href from another.
  for (const body of source.split(/[{}]/)) {
    if (!OBJECT_REL_ICON_RE.test(body)) continue;
    const href = body.match(OBJECT_HREF_RE)?.[1];
    if (href) return href;
  }
  return null;
};

/** Maps a declared href to project-relative candidates, or [] for remote/inline icons. */
const hrefCandidates = (href, declaringFile, path) => {
  const clean = href.split(/[?#]/, 1)[0].trim();
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return [];
  if (clean.startsWith('/')) {
    const rooted = clean.replace(/^\/+/, '');
    return [path.posix.join('public', rooted), path.posix.join('static', rooted), rooted];
  }
  return [path.posix.join(path.posix.dirname(declaringFile), clean)];
};

const sortPackageNames = (names) => {
  const rank = (name) => {
    const index = PREFERRED_PACKAGE_NAMES.indexOf(name);
    return index === -1 ? PREFERRED_PACKAGE_NAMES.length : index;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
};

export const createProjectIconResolver = ({ fsPromises, path, now = () => Date.now() }) => {
  const cache = new Map();
  const inFlight = new Map();

  const isWithin = (candidate, root) => {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };

  /** Resolves a project-relative path to a real file inside `root`, or null. */
  const existingFile = async (root, relativePath, maxBytes) => {
    const absolute = path.resolve(root, ...relativePath.split('/'));
    if (!isWithin(absolute, root)) return null;
    try {
      const real = await fsPromises.realpath(absolute);
      if (!isWithin(real, root)) return null;
      const stats = await fsPromises.stat(real);
      if (!stats.isFile() || stats.size === 0 || stats.size > maxBytes) return null;
      return real;
    } catch {
      return null;
    }
  };

  const iconFile = async (root, relativePath) => {
    const mime = ICON_MIME_BY_EXTENSION.get(path.extname(relativePath).toLowerCase());
    if (!mime) return null;
    const file = await existingFile(root, relativePath, MAX_ICON_BYTES);
    return file ? { path: file, mime } : null;
  };

  // Probes run concurrently; the earliest candidate in list order wins.
  const firstInOrder = async (items, probe) => {
    const results = await Promise.all(items.map((item) => probe(item)));
    return results.find(Boolean) ?? null;
  };

  const declaredIcon = async (root, declaringFile) => {
    const file = await existingFile(root, declaringFile, MAX_DECLARING_FILE_BYTES);
    if (!file) return null;
    let source;
    try {
      source = await fsPromises.readFile(file, 'utf8');
    } catch {
      return null;
    }
    const href = findDeclaredIconHref(source);
    if (!href) return null;
    for (const candidate of hrefCandidates(href, declaringFile, path)) {
      const icon = await iconFile(root, candidate);
      if (icon) return icon;
    }
    return null;
  };

  const iconAt = async (root, prefix) => {
    const join = (relative) => (prefix ? `${prefix}/${relative}` : relative);
    const direct = await firstInOrder(DIRECT_ICON_PATHS, (relative) => iconFile(root, join(relative)));
    if (direct) return direct;
    return firstInOrder(ICON_DECLARING_FILES, (relative) => declaredIcon(root, join(relative)));
  };

  const packagePrefixes = async (root) => {
    const prefixes = [];
    for (const parent of MONOREPO_PARENTS) {
      let entries;
      try {
        entries = await fsPromises.readdir(path.join(root, parent), { withFileTypes: true });
      } catch {
        continue;
      }
      const names = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
        .map((entry) => entry.name);
      for (const name of sortPackageNames(names).slice(0, MAX_PACKAGES_PER_PARENT)) {
        prefixes.push(`${parent}/${name}`);
      }
    }
    return prefixes;
  };

  const lookup = async (root) => {
    const rootIcon = await iconAt(root, '');
    if (rootIcon) return rootIcon;
    for (const prefix of await packagePrefixes(root)) {
      const icon = await iconAt(root, prefix);
      if (icon) return icon;
    }
    return null;
  };

  const remember = (root, icon) => {
    cache.delete(root);
    cache.set(root, { icon, expiresAt: now() + (icon ? FOUND_TTL_MS : MISSING_TTL_MS) });
    while (cache.size > CACHE_CAPACITY) {
      cache.delete(cache.keys().next().value);
    }
  };

  const stillExists = async (icon) => {
    try {
      return (await fsPromises.stat(icon.path)).isFile();
    } catch {
      return false;
    }
  };

  /**
   * Returns `{ path, mime }` for the project's icon, or null when it has none.
   * `root` must already be a canonical (realpath) directory.
   */
  const resolve = async (root) => {
    const cached = cache.get(root);
    if (cached && cached.expiresAt > now() && (!cached.icon || await stillExists(cached.icon))) {
      return cached.icon;
    }
    const pending = inFlight.get(root);
    if (pending) return pending;
    const request = lookup(root)
      .then((icon) => {
        remember(root, icon);
        return icon;
      })
      .finally(() => {
        inFlight.delete(root);
      });
    inFlight.set(root, request);
    return request;
  };

  return { resolve };
};
