const isRootPath = (value: string): boolean => value === '/';

export const normalizeSeparators = (value: string): string => value.replace(/\\/g, '/');

export const trimTrailingSeparators = (value: string): string => {
  if (!value || isRootPath(value)) return value;
  let result = value;
  while (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
};

export const hasTrailingPathSeparator = (value: string): boolean => value.endsWith('/');

export const ensureBrowseDirectoryPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || hasTrailingPathSeparator(trimmed)) return trimmed;
  return `${trimmed}/`;
};

const getLastPathSeparatorIndex = (value: string): number => value.lastIndexOf('/');

export const getBrowseDirectoryPath = (value: string): string => {
  if (hasTrailingPathSeparator(value)) return value;
  const lastSeparator = getLastPathSeparatorIndex(value);
  if (lastSeparator < 0) return value;
  return value.slice(0, lastSeparator + 1);
};

export const getBrowseLeafPathSegment = (value: string): string => {
  const lastSeparator = getLastPathSeparatorIndex(value);
  return value.slice(lastSeparator + 1);
};

export const getBrowseParentPath = (value: string): string | null => {
  const trimmed = trimTrailingSeparators(value.trim());
  if (!trimmed || trimmed === '~' || trimmed === '~/' || trimmed === '/') return null;
  const lastSeparator = getLastPathSeparatorIndex(trimmed);
  if (lastSeparator < 0) return null;
  if (trimmed.startsWith('~/') && lastSeparator <= 1) return '~/';
  if (lastSeparator === 0) return '/';
  return `${trimmed.slice(0, lastSeparator)}/`;
};

export const canNavigateUp = (value: string): boolean => (
  hasTrailingPathSeparator(value) && getBrowseParentPath(value) !== null
);

export const getBrowseCurrentFolderName = (value: string): string | null => {
  if (!canNavigateUp(value)) return null;
  const trimmed = trimTrailingSeparators(value.trim());
  const name = getBrowseLeafPathSegment(trimmed);
  return name || trimmed;
};

export const appendBrowsePathSegment = (currentPath: string, segment: string): string => (
  `${getBrowseDirectoryPath(currentPath)}${segment}/`
);

export const normalizeDirectoryPath = (path: string | null | undefined): string | null => {
  if (!path) return null;
  const normalized = trimTrailingSeparators(normalizeSeparators(path.trim()));
  if (!normalized) return null;
  return normalized.toLowerCase();
};

export const displayPathToAbsolutePath = (value: string, homeDirectory: string): string => {
  const trimmed = value.trim();
  if (trimmed === '~') return homeDirectory;
  if (trimmed.startsWith('~/')) return `${homeDirectory}${trimmed.slice(1)}`;
  return trimmed;
};

export const absolutePathToDisplayPath = (absolute: string, homeDirectory: string): string => {
  const normalizedAbsolute = trimTrailingSeparators(normalizeSeparators(absolute.trim()));
  const normalizedHome = trimTrailingSeparators(normalizeSeparators(homeDirectory.trim()));
  if (!normalizedAbsolute) return '';
  if (!normalizedHome) return ensureBrowseDirectoryPath(normalizedAbsolute);

  if (normalizedAbsolute.toLowerCase() === normalizedHome.toLowerCase()) {
    return '~/';
  }

  const homePrefix = `${normalizedHome}/`;
  if (normalizedAbsolute.toLowerCase().startsWith(homePrefix.toLowerCase())) {
    return `~/${normalizedAbsolute.slice(normalizedHome.length + 1)}/`;
  }

  return ensureBrowseDirectoryPath(normalizedAbsolute);
};
