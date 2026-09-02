export const normalizeMobileFilesPath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

export const getNameFromPath = (path: string): string => {
  const normalized = normalizeMobileFilesPath(path);
  if (!normalized || normalized === '/') return normalized || '/';
  return normalized.split('/').filter(Boolean).at(-1) ?? normalized;
};

export const getParentDirectory = (path: string): string | null => {
  const normalized = normalizeMobileFilesPath(path);
  if (!normalized || normalized === '/') return null;
  const index = normalized.lastIndexOf('/');
  if (index < 0) return null;
  if (index === 0) return '/';
  const parent = normalized.slice(0, index);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}/`;
  return parent;
};

const isPathWithinRoot = (path: string, root: string): boolean => {
  const normalizedPath = normalizeMobileFilesPath(path);
  const normalizedRoot = normalizeMobileFilesPath(root);
  if (!normalizedPath || !normalizedRoot) return false;
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
};

export const resolveChildPath = (child: string, currentDirectory: string): string => {
  const normalizedChild = normalizeMobileFilesPath(child);
  if (!normalizedChild) return normalizeMobileFilesPath(currentDirectory);
  if (normalizedChild.startsWith('/') || /^[A-Za-z]:(\/|$)/.test(normalizedChild)) {
    return normalizedChild;
  }
  const current = normalizeMobileFilesPath(currentDirectory);
  return current ? `${current}/${normalizedChild}` : normalizedChild;
};

export const canNavigateToParent = (directory: string, root: string): boolean => {
  const current = normalizeMobileFilesPath(directory);
  const projectRoot = normalizeMobileFilesPath(root);
  if (!current || current === projectRoot) return false;
  const parent = getParentDirectory(current);
  if (!parent) return false;
  if (!projectRoot) return true;
  if (isPathWithinRoot(current, projectRoot)) return isPathWithinRoot(parent, projectRoot);
  return true;
};
