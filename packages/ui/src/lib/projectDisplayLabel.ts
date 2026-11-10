import { formatDirectoryName } from '@/lib/utils';

/** "demo-repo" -> "Demo Repo": how a folder reads when it has no saved label. */
const titleCaseFolderName = (name: string): string =>
  name.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());

/**
 * A project's name wherever it is shown (sidebar, header, composer, settings):
 * its saved label exactly as written, otherwise its folder name title-cased.
 */
export const getProjectDisplayLabel = (
  project: { label?: string | null; path: string },
  homeDirectory: string | null = null,
): string => {
  const label = project.label?.trim();
  if (label) return label;
  return titleCaseFolderName(formatDirectoryName(project.path, homeDirectory) || project.path);
};
