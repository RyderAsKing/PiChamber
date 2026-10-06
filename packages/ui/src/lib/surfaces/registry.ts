import type { IconName } from '@/components/icon/icons';
import type { ContextPanelMode } from '@/stores/useUIStore';
import i18n from '@/i18n';

export type ContextSurfaceId =
  | 'editor'
  | 'git'
  | 'terminal'
  | 'context'
  | 'browser'
  | 'preview'
  | 'pull-requests'
  | 'issues'
  | 'extensions';

export type ContextSurfaceDescriptor = {
  id: ContextSurfaceId;
  /** The context panel tab mode this surface activates. 1:1 in the current model. */
  mode: ContextPanelMode;
  icon: IconName;
  label: string;
  /**
   * 'always' surfaces are always present on the rail.
   * 'has-content' surfaces are content-driven: they need an existing tab of
   * their mode (a preview URL emitted, a split session) and stay hidden on
   * the rail until one exists.
   * 'github-repo' surfaces need a GitHub repository in scope for the current
   * directory: visible when scope has >=1 GitHub repo, hidden while scope is
   * loading, visible when scope resolution FAILED so the failure renders.
   * 'extensions' surfaces are visible when the selected session has
   * `ctx.ui.setWidget` content or an extensions tab is already open.
   */
  availability: 'always' | 'has-content' | 'github-repo' | 'extensions';
  /** Short tooltip explanation shown on the rail. */
  description: string;
};

/** Shared default panel width as a fraction of the content area. */
export const CONTEXT_SURFACE_DEFAULT_WIDTH_FRACTION = 0.45;

export const CONTEXT_SURFACES: readonly ContextSurfaceDescriptor[] = [
  {
    id: 'context',
    description: "Session context and token usage",
    mode: 'context',
    icon: 'donut-chart-fill',
    label: "Context",
    availability: 'always',
  },
  {
    id: 'editor',
    description: "Edit project files",
    mode: 'file',
    icon: 'file-text',
    label: "Files",
    availability: 'always',
  },
  {
    id: 'git',
    description: "Review diffs, commit, and push",
    mode: 'git',
    icon: 'git-branch',
    label: "Git",
    availability: 'always',
  },
  {
    id: 'terminal',
    description: "Built-in terminal",
    mode: 'terminal',
    icon: 'terminal-box',
    label: "Terminal",
    availability: 'always',
  },

  {
    id: 'browser',
    description: "Built-in web browser",
    mode: 'browser',
    icon: 'global',
    label: "Browser",
    availability: 'always',
  },
  {
    id: 'preview',
    description: "Dev server preview",
    mode: 'preview',
    icon: 'window',
    label: "Preview",
    availability: 'has-content',
  },
  {
    id: 'pull-requests',
    description: "Browse pull requests for this repository",
    mode: 'pull-requests',
    icon: 'git-pull-request',
    label: "Pull requests",
    availability: 'github-repo',
  },
  {
    id: 'issues',
    description: "Browse issues for this repository",
    mode: 'issues',
    icon: 'task',
    label: "Issues",
    availability: 'github-repo',
  },
  {
    id: 'extensions',
    description: "Extension widgets for this session",
    mode: 'extensions',
    icon: 'plug-2',
    label: "Extensions",
    availability: 'extensions',
  },
];

const SURFACE_BY_ID = new Map(CONTEXT_SURFACES.map((surface) => [surface.id, surface]));

const GIT_SURFACE = CONTEXT_SURFACES.find((surface) => surface.id === 'git');

/** Rail chrome for the Git surface: Changes when the directory is not a repo. */
export const getGitRailPresentation = (isGitRepo: boolean | null): Pick<ContextSurfaceDescriptor, 'icon' | 'label' | 'description'> => {
  if (isGitRepo === false) {
    return {
      icon: 'arrow-left-right',
      label: i18n.t("Changes"),
      description: i18n.t("Review working and last-turn changes"),
    };
  }
  return {
    icon: GIT_SURFACE?.icon ?? 'git-branch',
    label: i18n.t(GIT_SURFACE?.label ?? "Git"),
    description: i18n.t(GIT_SURFACE?.description ?? "Review diffs, commit, and push"),
  };
};

const isContextSurfaceId = (value: unknown): value is ContextSurfaceId => {
  return typeof value === 'string' && SURFACE_BY_ID.has(value as ContextSurfaceId);
};

/**
 * Applies a persisted user reorder on top of the default registry order:
 * unknown ids are dropped, missing surfaces are appended in default order.
 */
export const sortContextSurfaces = (railOrder: readonly string[]): ContextSurfaceDescriptor[] => {
  const ordered: ContextSurfaceDescriptor[] = [];
  const seen = new Set<ContextSurfaceId>();

  for (const id of railOrder) {
    if (!isContextSurfaceId(id) || seen.has(id)) {
      continue;
    }
    const surface = SURFACE_BY_ID.get(id);
    if (surface) {
      seen.add(id);
      ordered.push(surface);
    }
  }

  for (const surface of CONTEXT_SURFACES) {
    if (!seen.has(surface.id)) {
      ordered.push(surface);
    }
  }

  return ordered;
};

export type GitHubRailScopeState = {
  /** True while scope resolution is in flight and no result exists yet. */
  isLoading: boolean;
  /** True when scope resolved (even to zero repos) or failed. */
  hasResult: boolean;
  /** True when scope holds >=1 selectable GitHub repository. */
  hasGitHubRepo: boolean;
  /** True when scope resolution failed (surface stays visible to render it). */
  hasError: boolean;
};

/** Minimal scope-entry shape for deriving rail/mobile visibility. Structural
 * (not the store type) so lib stays free of store imports. */
export type GitHubScopeEntryLike = {
  scope: { repositories: ReadonlyArray<{ host: string | null; owner: string | null; repo: string | null; disabledReason?: string | null }> } | null;
  isLoading: boolean;
  error: unknown;
} | null | undefined;

/** Derive the `github-repo` scope state from a scope-store entry.
 * Shared by the desktop rail and the Capacitor mobile workspace tabs so both
 * apply the same rule without duplicating it. */
export const toGitHubRailScopeState = (entry: GitHubScopeEntryLike): GitHubRailScopeState => {
  if (!entry) return { isLoading: true, hasResult: false, hasGitHubRepo: false, hasError: false };
  const repos = entry.scope?.repositories ?? [];
  return {
    isLoading: entry.isLoading,
    hasResult: Boolean(entry.scope || entry.error),
    hasGitHubRepo: repos.some((repoEntry) => Boolean(repoEntry.host && repoEntry.owner && repoEntry.repo && !repoEntry.disabledReason)),
    hasError: Boolean(entry.error && !entry.scope),
  };
};

/** The `github-repo` availability rule without the rail's open-tab exception:
 * hidden while scope loads with no result yet, visible when scope holds >=1
 * GitHub repo, visible when scope resolution FAILED so the failure renders.
 * The rail adds "an open tab keeps its surface visible" on top of this;
 * mobile uses this directly and falls back to Changes instead. */
export const isGitHubRepoAvailable = (scope: GitHubRailScopeState | undefined): boolean => {
  if (!scope) return false;
  if (scope.isLoading && !scope.hasResult) return false;
  if (scope.hasError) return true;
  return scope.hasGitHubRepo;
};

type VisibleRailSurfacesOptions = {
  railOrder: readonly string[];
  screenWidth: number;
  tabs: readonly { mode: ContextPanelMode }[];
  /** GitHub scope state for the current directory. Omitted callers keep the
   * previous behavior for non-github surfaces; github-repo surfaces hide
   * until scope state is supplied (loading). */
  githubScope?: GitHubRailScopeState;
  /** Whether the selected session has `ctx.ui.setWidget` content. */
  hasExtensionContent?: boolean;
};

/**
 * The context panel rail's visible, user-ordered surfaces. Shared by the rail
 * (for rendering and number badges) and the global surface-switch shortcut so
 * both agree on which surface each digit maps to.
 *
 * Content-driven surfaces are hidden (not disabled) until content exists; an
 * existing tab keeps them visible even if the content source went away.
 */
export const getVisibleContextRailSurfaces = (options: VisibleRailSurfacesOptions): ContextSurfaceDescriptor[] => {
  return sortContextSurfaces(options.railOrder).filter((surface) => {
    if (surface.availability === 'has-content') {
      return options.tabs.some((tab) => tab.mode === surface.mode);
    }
    if (surface.availability === 'github-repo') {
      // An open tab keeps the surface visible even if scope went away.
      if (options.tabs.some((tab) => tab.mode === surface.mode)) return true;
      return isGitHubRepoAvailable(options.githubScope);
    }
    if (surface.availability === 'extensions') {
      if (options.tabs.some((tab) => tab.mode === surface.mode)) return true;
      return Boolean(options.hasExtensionContent);
    }
    return true;
  });
};
