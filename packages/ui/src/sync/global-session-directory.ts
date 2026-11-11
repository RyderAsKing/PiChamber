import { isDesktopLocalOriginActive } from '@/lib/desktop';
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
  // The desktop app injects its own machine's home, which names the server's
  // home only while the app is on its built-in server. On a remote server it
  // is another machine's path (C:/Users/... against a Linux server).
  try {
    if (typeof window !== 'undefined' && isDesktopLocalOriginActive()) add(window.__PICHAMBER_HOME__);
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
