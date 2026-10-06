import type { Session } from '@/lib/chat/types';
import { formatDirectoryName } from '@/lib/utils';
import { normalizePath } from '@/lib/pathNormalization';
import i18n from '@/i18n';
export { normalizePath };

export const selectExpandedParentKeysForContext = (
  previous: Set<string>,
  expanded: ReadonlySet<string>,
  context: 'project' | 'recent',
): Set<string> => {
  const prefix = `${context}:`;
  const next = new Set([...expanded].filter((key) => key.startsWith(prefix)));
  if (previous.size === next.size && [...next].every((key) => previous.has(key))) {
    return previous;
  }
  return next;
};

export const toggleExpandedParentKey = (
  expanded: Set<string>,
  key: string,
): Set<string> => {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

const formatDateLabel = (value: string | number) => {
  const targetDate = new Date(value);
  const today = new Date();
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (isSameDay(targetDate, today)) {
    return i18n.t("Today");
  }
  if (isSameDay(targetDate, yesterday)) {
    return i18n.t("Yesterday");
  }
  const formatted = targetDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return formatted.replace(',', '');
};

export const formatSessionDateLabel = (updatedMs: number): string => {
  const today = new Date();
  const updatedDate = new Date(updatedMs);
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (isSameDay(updatedDate, today)) {
    const diff = Date.now() - updatedMs;
    if (diff < 60_000) return i18n.t("Just now");
    if (diff < 3_600_000) return i18n.t('{{count}}min ago', { count: Math.floor(diff / 60_000) });
    return i18n.t('{{count}}h ago', { count: Math.floor(diff / 3_600_000) });
  }

  return formatDateLabel(updatedMs);
};

export const formatSessionCompactDateLabel = (updatedMs: number): string => {
  const diff = Math.max(0, Date.now() - updatedMs);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (diff < hour) {
    return i18n.t('{{count}}m', { count: Math.max(1, Math.floor(diff / minute)) });
  }
  if (diff < day) {
    return i18n.t('{{count}}h', { count: Math.floor(diff / hour) });
  }
  if (diff < week) {
    return i18n.t('{{count}}d ago', { count: Math.floor(diff / day) });
  }
  if (diff < 5 * week) {
    return i18n.t('{{count}}w ago', { count: Math.floor(diff / week) });
  }
  if (diff < year) {
    return i18n.t('{{count}}mo', { count: Math.floor(diff / month) });
  }
  return i18n.t('{{count}}y ago', { count: Math.floor(diff / year) });
};

export const isPathWithinProject = (directory?: string | null, projectPath?: string | null): boolean => {
  const normalizedDirectory = normalizePath(directory);
  const normalizedProjectPath = normalizePath(projectPath);
  return isNormalizedPathWithinProject(normalizedDirectory, normalizedProjectPath);
};

const isNormalizedPathWithinProject = (normalizedDirectory: string | null, normalizedProjectPath: string | null): boolean => {
  if (!normalizedDirectory || !normalizedProjectPath) return false;
  if (normalizedDirectory === normalizedProjectPath) return true;
  if (normalizedProjectPath === '/') return normalizedDirectory.startsWith('/');
  return normalizedDirectory.startsWith(`${normalizedProjectPath}/`);
};

export const normalizeForBranchComparison = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[-_]/g, '')
    .trim();
};

export const isBranchDifferentFromLabel = (branch: string | null, label: string): boolean => {
  if (!branch) return false;
  return normalizeForBranchComparison(branch) !== normalizeForBranchComparison(label);
};

export const dedupeSessionsById = (sessions: Session[]): Session[] => {
  const byId = new Map<string, Session>();
  sessions.forEach((session) => {
    byId.set(session.id, session);
  });
  return Array.from(byId.values());
};

export const getArchivedScopeKey = (projectRoot: string): string => `__archived__:${projectRoot}`;

export const resolveArchivedFolderName = (session: Session, projectRoot: string | null): string => {
  const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
  const projectWorktree = normalizePath((session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? null);
  const resolved = sessionDirectory ?? projectWorktree;
  if (!resolved) {
    return i18n.t('unassigned');
  }
  if (projectRoot && resolved === projectRoot) {
    return i18n.t('project root');
  }
  const source = projectRoot && resolved.startsWith(`${projectRoot}/`)
    ? resolved.slice(projectRoot.length + 1)
    : resolved;
  const segments = source.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? i18n.t('unassigned');
};

export const formatProjectLabel = (label: string): string => {
  return label
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

export const getProjectLabel = (
  project: { label?: string; normalizedPath: string },
  homeDirectory: string | null,
): string => (
  formatProjectLabel(
    project.label?.trim()
    || formatDirectoryName(project.normalizedPath, homeDirectory)
    || project.normalizedPath,
  )
);

/** Where sidebar content starts, from either edge: the shared column gutter (`px-2`) plus a row's own padding (`px-3`), following the user's padding scale like those classes do. The session scroller itself stays full-width so the overlay scrollbar can sit on the sidebar edge. */
export const sidebarContentInsetX = 'calc(1.25rem * var(--padding-scale, 1))';

/** Chrome shared by session rows and session-shaped actions (show more). */
export const sidebarRowIconClassName = 'size-4 shrink-0';
export const sidebarRowLabelClassName = 'min-w-0 truncate typography-ui-label font-normal';
export const sidebarRowIconClassNameMobile = sidebarRowIconClassName;
export const sidebarRowLabelClassNameMobile = sidebarRowLabelClassName;
export const sidebarSessionRowClassName =
  'group relative my-0.5 flex w-full cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';
export const sidebarSessionRowClassNameMobile = sidebarSessionRowClassName;

export const sidebarRowIconClass = (mobile: boolean): string => (
  mobile ? sidebarRowIconClassNameMobile : sidebarRowIconClassName
);
export const sidebarRowLabelClass = (mobile: boolean): string => (
  mobile ? sidebarRowLabelClassNameMobile : sidebarRowLabelClassName
);
