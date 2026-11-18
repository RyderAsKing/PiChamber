import type {
  PiExtensionConfigPackage,
  PiExtensionConfigResponse,
  PiPluginView,
} from '@/lib/pi/protocol';

/**
 * Pure rules the marketplace views share: which installed package a search
 * hit is, whether an update is out, and which built-in plugins a search is
 * really asking for.
 */

/** The npm name of an npm source (`npm:@scope/name@1.2.3` → `@scope/name`). */
export const npmNameOfSource = (source: string): string | undefined => {
  const trimmed = source.trim();
  if (!trimmed.startsWith('npm:')) return undefined;
  const spec = trimmed.slice('npm:'.length).trim();
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/);
  return match?.[1];
};

/** The npm name of an installed package, when it came from npm. */
export const npmNameOf = (pkg: PiExtensionConfigPackage): string | undefined => (
  pkg.kind === 'npm' ? npmNameOfSource(pkg.source) ?? pkg.name : undefined
);

const KIND_LABEL: Record<PiExtensionConfigPackage['kind'], string> = {
  npm: 'npm package',
  git: 'Git package',
  local: 'Local folder',
};

/** What kind of package and which version: `npm package · v0.48.0`. */
export const formatInstalledFacts = (pkg: PiExtensionConfigPackage): string => [
  KIND_LABEL[pkg.kind],
  pkg.version ? `v${pkg.version}` : null,
  // The title shows the bare npm name, so a pin in the source shows here.
  pkg.pinned ? 'pinned' : null,
].filter(Boolean).join(' · ');

export interface InstalledPackage {
  pkg: PiExtensionConfigPackage;
  /** Which list it came from: the global view or a project's. */
  view: 'global' | 'project';
}

/**
 * Installed npm packages by name, across the views given. A package the
 * project lists wins over the same name listed globally, since that is the
 * one this project loads.
 */
export const installedByName = (
  configs: Array<{ config: PiExtensionConfigResponse | null | undefined; view: 'global' | 'project' }>,
): Map<string, InstalledPackage> => {
  const found = new Map<string, InstalledPackage>();
  for (const { config, view } of configs) {
    for (const pkg of config?.packages ?? []) {
      const name = npmNameOf(pkg);
      if (!name) continue;
      const existing = found.get(name);
      if (existing && !(pkg.scope === 'project' && existing.pkg.scope !== 'project')) continue;
      found.set(name, { pkg, view });
    }
  }
  return found;
};

const parseVersion = (version: string) => {
  const [core, ...rest] = version.split('+')[0].split('-');
  const parts = core.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return undefined;
  return { parts, prerelease: rest.join('-') };
};

/**
 * Semver prerelease order: dot-separated fields, numbers compared as numbers
 * (by length first, so any size works) and below words, words compared as
 * text, and a shorter list below a longer one it starts.
 */
const comparePrerelease = (a: string, b: string): number => {
  const left = a.split('.');
  const right = b.split('.');
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) {
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
      return x < y ? -1 : 1;
    }
    if (xNumber !== yNumber) return xNumber ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
};

/**
 * Compare two versions the way semver orders them (numbers first, a
 * prerelease before its release). Unparseable versions compare equal, so
 * no update is offered on a guess.
 */
export const compareVersions = (a: string, b: string): number => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index += 1) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
};

/**
 * The version an installed package can update to, if npm has a newer one.
 * Pinned and non-npm packages get none here (git updates have no version
 * to compare).
 */
export const availableUpdate = (
  pkg: PiExtensionConfigPackage,
  latest: Record<string, string>,
): string | undefined => {
  const name = npmNameOf(pkg);
  if (!name || pkg.pinned || !pkg.installed || !pkg.version) return undefined;
  const newest = latest[name];
  return newest && compareVersions(newest, pkg.version) > 0 ? newest : undefined;
};

const tokens = (query: string): string[] => query.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3);

/**
 * Built-in plugins a search seems to be after: a word of the query (3 letters
 * or more) starts a word of the plugin's name or keywords. Descriptions are
 * left out, since their common words ("agent", "page") would match most
 * searches. Shown above the results, since the built-in one is the better fit
 * in PiChamber.
 */
export const matchingPlugins = (plugins: PiPluginView[], query: string): PiPluginView[] => {
  const words = tokens(query);
  if (words.length === 0) return [];
  return plugins.filter((plugin) => {
    if (!plugin.bundled) return false;
    const terms = [plugin.name, ...(plugin.keywords ?? [])].flatMap(tokens);
    return words.some((word) => terms.some((term) => term.startsWith(word)));
  });
};

/** `1,234`, `12k`, `1.2M`: weekly downloads in a row's facts. */
export const formatCount = (count: number): string => {
  if (count < 1_000) return count.toLocaleString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
};
