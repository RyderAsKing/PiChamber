/**
 * The folder a clone lands in, read from the URL the way the server's
 * `/api/fs/clone` reads it: the last path segment without `.git`, ignoring a
 * query or fragment. Empty when the URL names no folder.
 */
export const repositoryFolderName = (remoteUrl: string): string => {
  const remote = remoteUrl.trim();
  if (!remote) return '';
  const withoutQuery = remote.split(/[?#]/, 1)[0] || remote;
  const match = withoutQuery.match(/([^/:]+?)(?:\.git)?\/?$/);
  return match?.[1]?.trim() || '';
};

/** Why a name can't be a new folder's name, or null when it can. */
export const folderNameProblem = (name: string): string | null => {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name for the folder.';
  if (/[/\\]/.test(trimmed)) return 'A name can’t contain / or \\.';
  if (trimmed === '.' || trimmed === '..') return 'Choose a different name.';
  return null;
};

/** `~/code/` plus `app` is `~/code/app`; a location without its slash gets one. */
export const childDisplayPath = (location: string, name: string): string => {
  if (!location) return name;
  return location.endsWith('/') ? `${location}${name}` : `${location}/${name}`;
};
