import type { IconName } from '@/components/icon/icons';
import type { ContextPanelMode } from '@/stores/useUIStore';

export type ContextSurfaceId =
  | 'editor'
  | 'git'
  | 'terminal'
  | 'notes'
  | 'context'
  | 'browser'
  | 'preview'
  | 'chat';

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
   */
  availability: 'always' | 'has-content';
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
    id: 'notes',
    description: "Notes, todos, and plans for the project",
    mode: 'notes',
    icon: 'sticky-note',
    label: "Project notes",
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
    id: 'chat',
    description: "Session opened side by side",
    mode: 'chat',
    icon: 'chat-4',
    label: "Chat",
    availability: 'has-content',
  },
];

const SURFACE_BY_ID = new Map(CONTEXT_SURFACES.map((surface) => [surface.id, surface]));

const GIT_SURFACE = CONTEXT_SURFACES.find((surface) => surface.id === 'git');

/** Rail chrome for the Git surface: Changes when the directory is not a repo. */
export const getGitRailPresentation = (isGitRepo: boolean | null): Pick<ContextSurfaceDescriptor, 'icon' | 'label' | 'description'> => {
  if (isGitRepo === false) {
    return {
      icon: 'arrow-left-right',
      label: "Changes",
      description: "Review working and last-turn changes",
    };
  }
  return {
    icon: GIT_SURFACE?.icon ?? 'git-branch',
    label: GIT_SURFACE?.label ?? "Git",
    description: GIT_SURFACE?.description ?? "Review diffs, commit, and push",
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

type VisibleRailSurfacesOptions = {
  railOrder: readonly string[];
  screenWidth: number;
  tabs: readonly { mode: ContextPanelMode }[];
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
    return true;
  });
};
