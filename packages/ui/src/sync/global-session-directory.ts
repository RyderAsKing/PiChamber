import { normalizePath } from '@/lib/pathNormalization';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

export const getGlobalSessionDirectories = (homeDirectory?: string | null): string[] => {
  const directories = ['~'];
  const add = (candidate: string | null | undefined): void => {
    const normalized = normalizePath(candidate);
    if (normalized && !directories.includes(normalized)) directories.push(normalized);
  };

  add(homeDirectory);
  try {
    add(getDeferredSafeStorage().getItem('homeDirectory'));
  } catch { /* storage unavailable */ }
  try {
    if (typeof window !== 'undefined') add(window.__PICHAMBER_HOME__);
  } catch { /* window unavailable */ }

  return directories;
};

export const isGlobalSessionDirectory = (
  directory: string | null | undefined,
  homeDirectory?: string | null,
): boolean => {
  const normalized = normalizePath(directory);
  return Boolean(normalized && getGlobalSessionDirectories(homeDirectory).includes(normalized));
};
